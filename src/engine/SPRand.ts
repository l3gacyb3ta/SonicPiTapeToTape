/**
 * SPRand — table-indexed random generator matching desktop Sonic Pi (EPIC #531).
 *
 * Desktop's `SonicPi::Core::SPRand` (app/server/ruby/core.rb) does NOT run a live
 * PRNG. It indexes a frozen 441,000-value table (the rand-stream wav, see
 * {@link ./RandStream}) by a per-thread `(seed, idx)` position. This class is a
 * 1:1 port of that arithmetic so `rand`/`rand_i`/`choose`/… produce the SAME
 * values as desktop for the same seed — the parity our prior MT19937
 * `SeededRandom` could never reach (it generated fresh floats, indexing nothing).
 *
 * Desktop arithmetic (grounded, GROUND_TRUTH_DESKTOP_SP_PRNG):
 *   rand_peek(max, idx, seed): pos = (seed + idx + 1) mod 441000; table[pos] * max
 *   rand!(max):                r = idx; idx = r + 1; rand_peek(max, r)
 *     → after set_seed!(s) (seed=s, idx=0), successive rand! read pos s+1, s+2, …
 *   rand_i!(max) = trunc(rand!(max))   (Ruby Float#to_i truncates toward zero)
 *
 * Two Ruby→JS traps this port must respect (both are silent-divergence sources):
 *   1. In Ruby `0` is TRUTHY, so SPRand's `idx = get_idx unless idx` keeps an
 *      explicit `idx == 0`. The JS guard must therefore test `=== undefined`,
 *      NOT `!idx` (which would wrongly re-fetch when idx is 0).
 *   2. Ruby `%` takes the sign of the divisor, so a NEGATIVE index (after
 *      rand_back past 0) wraps to a positive table slot. JS `%` keeps the sign of
 *      the dividend, so we floor-mod.
 *
 * The public surface mirrors {@link ./SeededRandom} so Phase 1b can swap it into
 * ProgramBuilder with no call-site changes. Per-op consumption details
 * (rrand/shuffle/dice/one_in vs desktop) are tightened in Phase 2 (#531); this
 * phase lands the exact value SOURCE and the seed/idx mechanics.
 */
import { RAND_STREAM_LENGTH } from './RandStream'
import type { RandSource } from './RandStream'

/** Ruby-style modulo: result takes the sign of the divisor (always [0, m)). */
function floorMod(n: number, m: number): number {
  return ((n % m) + m) % m
}

/** A draw position + the distribution it reads from (desktop's three random
 *  thread-locals: seed, idx, gen_type). Carried as one unit so a forked thread /
 *  live_loop inherits all three (EPIC #531 Phase 3 + 4). */
export interface RandState {
  seed: number
  idx: number
  source: RandSource
}

export class SPRand {
  /** The ACTIVE distribution table — swapped by `setSource` (Phase 4). */
  private table: Float64Array
  /** Desktop `:sonic_pi_spider_random_gen_seed` — an offset into the table. */
  private seed: number
  /** Desktop `:sonic_pi_spider_random_gen_idx` — draws since the last set_seed. */
  private idx: number
  /** Desktop `:sonic_pi_spider_random_gen_type` — which distribution is active. */
  private source: RandSource = 'white'
  /**
   * All distribution tables, for `use_random_source` switching (Phase 4). When
   * absent (single-table unit tests) source switching throws. The white table is
   * always the constructor's `table`.
   */
  private readonly sources?: Partial<Record<RandSource, Float64Array>>

  constructor(table: Float64Array, seed = 0, sources?: Partial<Record<RandSource, Float64Array>>) {
    this.table = table
    this.seed = seed
    this.idx = 0
    this.sources = sources
  }

  /**
   * `rand_peek(max, idx, seed)` — the core lookup. Returns the value at the
   * position the NEXT draw would read, WITHOUT consuming. `idx`/`seed` default to
   * the stored state (Ruby `unless` ⇒ `=== undefined`, so an explicit 0 is kept).
   */
  private randPeek(max = 1, idx?: number, seed?: number): number {
    const i = idx === undefined ? this.idx : idx
    const s = seed === undefined ? this.seed : seed
    // Floor the position: a thread-derived seed (Phase 3) is a float, and desktop's
    // Ruby `random_numbers[float]` truncates. Integer seeds (use_random_seed) are a
    // no-op here. Indexing a Float64Array with a non-integer would yield undefined.
    const pos = Math.floor(floorMod(s + i + 1, RAND_STREAM_LENGTH))
    return this.table[pos] * max
  }

  /**
   * `rand!(max)` — consume one value: read at the current idx, advance idx by one.
   * (Desktop `inc_idx!` returns the OLD idx then stores idx+1, and rand_peek uses
   * the old idx → positions seed+1, seed+2, … after a reset.)
   */
  private randBang(max = 1): number {
    const r = this.idx
    this.idx = r + 1
    return this.randPeek(max, r)
  }

  // --- public surface (mirrors SeededRandom) -------------------------------

  /** Random float in [0, 1) — desktop `rand` with no/`1` max. One draw. */
  next(): number {
    return this.randBang(1)
  }

  /** `rand_i!(max)` — `floor(rand!(max))`, one draw (Ruby Float#to_i truncates). */
  randI(max: number): number {
    return Math.floor(this.randBang(max))
  }

  /**
   * `rrand(min, max)` — desktop lang/core.rb:3117. Returns min WITHOUT a draw when
   * `min == max` (the consumption-exact edge a `min + rand!(0)` would get wrong by
   * drawing); otherwise `min(min,max) + rand!(|min-max|)`. The `|range|` + smallest
   * form also handles `min > max` like desktop.
   */
  rrand(min: number, max: number): number {
    if (min === max) return min
    const r = this.randBang(Math.abs(min - max))
    return Math.min(min, max) + r
  }

  /** `rrand_i(min, max)` — desktop lang/core.rb:3159. No draw when `min == max`;
   *  else `min(min,max) + rand_i!(|min-max| + 1)`. */
  rrand_i(min: number, max: number): number {
    if (min === max) return min
    const r = Math.floor(this.randBang(Math.abs(min - max) + 1))
    return Math.min(min, max) + r
  }

  /** Random element from an array (`arr[rand_i!(len)]`). */
  choose<T>(arr: T[]): T {
    return arr[this.randI(arr.length)]
  }

  /**
   * `Array#shuffle` — desktop's SPRand override (sprand_core.rb:1083-1100), NOT a
   * plain Fisher-Yates. It derives a fresh seed from ONE outer draw, runs `s`
   * random-swap iterations on that DERIVED stream, then restores the outer stream
   * advanced by EXACTLY ONE. So shuffle consumes exactly one value from the
   * caller's stream regardless of list size — the property a plain Fisher-Yates
   * (which consumes `s` draws) breaks, misaligning every subsequent rand.
   * Returns a new array; the input is not mutated.
   */
  shuffle<T>(arr: readonly T[]): T[] {
    const origSeed = this.seed
    const origIdx = this.idx
    // rand_i!(441000): one outer draw → the derived shuffle seed.
    const derived = Math.floor(this.randBang(RAND_STREAM_LENGTH))
    this.seed = derived
    this.idx = 0
    const a = arr.slice()
    const s = a.length
    for (let k = 0; k < s; k++) {
      const ia = Math.floor(this.randBang(s))
      const ib = Math.floor(this.randBang(s))
      const tmp = a[ia]
      a[ia] = a[ib]
      a[ib] = tmp
    }
    // Restore the outer stream, advanced by exactly one (set_seed!(orig, idx+1)).
    this.seed = origSeed
    this.idx = origIdx + 1
    return a
  }

  /** `use_random_seed s` / `set_seed!(s)` — set seed, reset idx to 0. */
  reset(seed: number): void {
    this.seed = seed
    this.idx = 0
  }

  /**
   * `use_random_source src` / `set_random_number_distribution!` (EPIC #531
   * Phase 4, sprand_core.rb:147 + random_numbers:151). Swaps WHICH frozen table
   * the stream indexes. CRITICAL: it does NOT touch seed/idx — the draw position
   * is shared across all distributions (desktop `test_rand_type`: switching to
   * white mid-stream reads white at the CURRENT idx, not idx 0). Throws if the
   * source's table was never loaded (no silent fall-back to white).
   */
  setSource(source: RandSource): void {
    const t = this.sources?.[source]
    if (!t) {
      throw new Error(
        `rand source '${source}' not loaded — use_random_source needs its distribution table`,
      )
    }
    this.source = source
    this.table = t
  }

  /** `current_random_source` — the active distribution (desktop default `:white`). */
  getSource(): RandSource {
    return this.source
  }

  /**
   * Derive a forked child thread's seed (EPIC #531 Phase 3). Desktop forks every
   * spider thread (live_loop / in_thread / at) with its OWN deterministic stream
   * derived from the PARENT's stream at spawn (runtime.rb:1062-1067):
   *   new_rand_seed = SPRand.rand!(441000, gen_idx)   # explicit idx ⇒ NO consume
   *   child_seed    = new_rand_seed + SPRand.get_seed  # + parent seed
   * The EXPLICIT `gen_idx` makes the lookup a peek at the fixed position
   * `(parent_seed + gen_idx + 1)`, so the derivation does NOT advance the parent
   * stream and is independent of how many draws the parent already made — only
   * the parent SEED and the spawn-order `gen_idx` matter. `gen_idx` increments per
   * spawn (the caller advances it), so sibling threads get DIFFERENT streams.
   * The result is a FLOAT; randPeek floors the table position, so a float seed
   * indexes correctly downstream.
   */
  deriveChildSeed(genIdx: number): number {
    return this.randPeek(RAND_STREAM_LENGTH, genIdx) + this.seed
  }

  /**
   * `current_random_seed` = `get_seed_plus_idx` = seed + idx (the position the
   * next draw resolves from, modulo the +1 lookahead).
   */
  getSeedPlusIdx(): number {
    return this.seed + this.idx
  }

  /** `rand_reset` / `set_idx!(count)` — jump the stream position (keep seed). */
  setIdx(count: number): void {
    this.idx = count
  }

  /** `rand_back` / `dec_idx!(amount)` — move the stream position back. */
  decIdx(amount = 1): void {
    this.idx = this.idx - amount
  }

  /** `rand_skip` / `inc_idx!(amount)` — advance the stream position. */
  incIdx(amount = 1): void {
    this.idx = this.idx + amount
  }

  /** Next value without consuming — backs `rand_look`. */
  peek(): number {
    return this.randPeek(1)
  }

  /** Snapshot `(seed, idx, source)` for save/restore (`with_random_seed`,
   *  per-loop persistence, fork inheritance). Carries the distribution too so a
   *  restored / inherited stream reads the right table (Phase 4). */
  getState(): RandState {
    return { seed: this.seed, idx: this.idx, source: this.source }
  }

  /** Restore a `(seed, idx[, source])` snapshot. A provided source switches the
   *  active table (must be loaded); omitting it keeps the current distribution. */
  setState(state: { seed: number; idx: number; source?: RandSource }): void {
    this.seed = state.seed
    this.idx = state.idx
    if (state.source !== undefined && state.source !== this.source) this.setSource(state.source)
  }

  /** Clone state (shares the immutable tables). */
  clone(): SPRand {
    const r = new SPRand(this.table, this.seed, this.sources)
    r.idx = this.idx
    r.source = this.source
    return r
  }
}
