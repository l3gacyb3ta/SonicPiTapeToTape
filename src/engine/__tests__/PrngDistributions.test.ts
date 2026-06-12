/**
 * EPIC #531 Phase 4 — random DISTRIBUTIONS (use_random_source).
 *
 * Desktop ships FIVE frozen tables — white (default) + pink / light_pink /
 * dark_pink / perlin (sprand_core.rb:136-140). `use_random_source :pink` swaps
 * WHICH table the stream indexes; `current_random_source` reads it;
 * `with_random_source` swaps for a block then restores. Two semantics matter:
 *   1. switching source does NOT reset the draw position (idx is shared across
 *      all distributions — desktop `test_rand_type`);
 *   2. a forked thread / live_loop INHERITS the parent's source (runtime.rb:1153).
 *
 * GROUND TRUTH: the SPRand golden firsts are desktop's OWN `test/lang/core/
 * test_random.rb` assertions (after `use_random_source X; rand_reset`). The
 * pipeline values are computed from the same shipped tables via the same
 * child-seed derivation desktop uses (runtime.rb:1062 reads `random_numbers` =
 * the CURRENT source's table), so they ARE desktop's values by construction.
 * Method (SP140): the pipeline assertions drive transpile→evaluate→puts, not a
 * direct builder call.
 */
import { describe, it, expect } from 'vitest'
import { SonicPiEngine } from '../SonicPiEngine'
import { ProgramBuilder } from '../ProgramBuilder'
import { SPRand } from '../SPRand'
import { getWhiteRandStream, getRandStreams, RAND_SOURCES } from '../RandStream'
import type { RandSource } from '../RandStream'

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}
type Sched = { tick: (t: number) => void }

async function runAndCapture(code: string, iterations = 4): Promise<string[]> {
  const engine = new SonicPiEngine()
  await engine.init()
  const printed: string[] = []
  engine.setPrintHandler((m) => printed.push(m))
  await engine.evaluate(code)
  const scheduler = (engine as unknown as { scheduler: Sched }).scheduler
  engine.play()
  for (let i = 0; i < iterations; i++) {
    scheduler.tick(20)
    await flush()
  }
  engine.dispose()
  return printed.filter((m) => /^[0-9.]/.test(m))
}

// Desktop `test_random.rb` golden firsts: `use_random_source X; rand_reset; rand`.
const GOLDEN_FIRSTS: Record<RandSource, [number, number]> = {
  white: [0.75006103515625, 0.733917236328125],
  pink: [0.47808837890625, 0.56011962890625],
  light_pink: [0.53851318359375, 0.54705810546875],
  dark_pink: [0.442596435546875, 0.443756103515625],
  perlin: [0.546478271484375, 0.573150634765625],
}

describe('EPIC #531 Phase 4 — SPRand distributions (golden vs desktop test_random.rb)', () => {
  function freshRng(): SPRand {
    return new SPRand(getWhiteRandStream(), 0, getRandStreams())
  }

  it('each source reproduces desktop golden firsts after reset (seed 0)', () => {
    for (const source of RAND_SOURCES) {
      const rng = freshRng()
      rng.setSource(source)
      rng.reset(0)
      expect([rng.next(), rng.next()]).toEqual(GOLDEN_FIRSTS[source])
    }
  })

  it('switching source does NOT reset the draw position (shared idx)', () => {
    const rng = freshRng()
    rng.reset(0)
    rng.next() // idx 0 → white[1]
    rng.next() // idx 1 → white[2]
    // now at idx 2; switching to pink reads PINK at idx 2 (not pink[1]).
    rng.setSource('pink')
    const pink = getRandStreams().pink as Float64Array
    expect(rng.next()).toBe(pink[3]) // (seed 0 + idx 2 + 1) = 3
  })

  it('current source reflects the last setSource (default white)', () => {
    const rng = freshRng()
    expect(rng.getSource()).toBe('white')
    rng.setSource('perlin')
    expect(rng.getSource()).toBe('perlin')
  })

  it('setSource throws for an unloaded distribution (no silent fallback)', () => {
    // single-table SPRand (no sources map) — source switching is unavailable.
    const lone = new SPRand(getWhiteRandStream(), 0)
    expect(() => lone.setSource('pink')).toThrow(/not loaded/)
  })
})

describe('EPIC #531 Phase 4 — ProgramBuilder use/with/current_random_source', () => {
  it('use_random_source switches the distribution; current_random_source reads it', () => {
    const b = new ProgramBuilder()
    expect(b.current_random_source()).toBe('white')
    b.use_random_source('dark_pink')
    expect(b.current_random_source()).toBe('dark_pink')
  })

  it('an invalid source warns and is a no-op (keeps current)', () => {
    const warnings: string[] = []
    const b = new ProgramBuilder()
    b.setWarnHandler((m) => warnings.push(m))
    b.use_random_source('chartreuse')
    expect(b.current_random_source()).toBe('white')
    expect(warnings.some((w) => w.includes('invalid noise type'))).toBe(true)
  })

  it('with_random_source restores the previous source, idx keeps advancing', () => {
    const b = new ProgramBuilder()
    b.use_random_source('perlin')
    b.use_random_seed(0)
    const before = b.current_random_seed() // seed+idx, idx 0
    let insideSource = ''
    b.with_random_source('white', (bb) => {
      bb.rand() // advances idx through the block
      insideSource = bb.current_random_source()
    })
    expect(insideSource).toBe('white') // active inside the block
    expect(b.current_random_source()).toBe('perlin') // restored after
    expect(b.current_random_seed()).toBe(before + 1) // idx advanced, NOT reset
  })
})

describe('EPIC #531 Phase 4 — use_random_source reaches a live_loop (E2E pipeline)', () => {
  // Computed from the shipped tables: top-level `use_random_source :X` is set
  // before the loop registers, so the loop's child seed is derived from X's table
  // (runtime.rb:1062 reads the current source) and the loop reads X's table.
  const LOOP_VALS: Partial<Record<RandSource, string[]>> = {
    white: ['0.9287109375', '0.1043701171875'],
    pink: ['0.530731201171875', '0.53668212890625'],
    perlin: ['0.618316650390625', '0.64178466796875'],
  }

  it('a live_loop inherits the top-level distribution and reads its table', async () => {
    for (const [source, expected] of Object.entries(LOOP_VALS)) {
      const nums = await runAndCapture(
        `use_random_source :${source}\nuse_random_seed 0\nlive_loop :l do\n  puts rand\n  sleep 1\nend`,
        2,
      )
      expect(nums.slice(0, expected.length)).toEqual(expected)
    }
  })

  it('the distribution choice is deterministic across Runs', async () => {
    const code = `use_random_source :pink\nlive_loop :l do\n  puts rand\n  sleep 1\nend`
    const a = await runAndCapture(code, 3)
    const b = await runAndCapture(code, 3)
    expect(b.slice(0, 3)).toEqual(a.slice(0, 3))
  })

  it('different sources yield different loop streams', async () => {
    const pink = await runAndCapture(`use_random_source :pink\nlive_loop :l do\n puts rand\n sleep 1\nend`, 2)
    const perlin = await runAndCapture(`use_random_source :perlin\nlive_loop :l do\n puts rand\n sleep 1\nend`, 2)
    expect(perlin[0]).not.toBe(pink[0])
  })
})
