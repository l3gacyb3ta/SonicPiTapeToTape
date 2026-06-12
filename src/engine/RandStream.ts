/**
 * RandStream — decode Sonic Pi's frozen random-number stream (EPIC #531, Phase 1).
 *
 * Desktop Sonic Pi does NOT generate random numbers with a live PRNG. At boot it
 * loads a fixed table of 441,000 values from `etc/buffers/rand-stream.wav` and
 * `SPRand` indexes into it (`app/server/ruby/core.rb`, class SPRand,
 * `wav_from_buffer_file` + `rand_peek`). The stream is identical across every
 * install and is reset each Run — which is why a piece using `rand`/`choose`/
 * `shuffle` sounds the same on everyone's machine. To match desktop note-for-note
 * we ship the SAME wav and index it the SAME way (GROUND_TRUTH_DESKTOP_SP_PRNG).
 *
 * Desktop reads the wav as `WaveFile::Format.new(:mono, :float, 44100)`. The wav
 * on disk is mono 16-bit PCM, and WaveFile's pcm_16→float conversion is
 * `sample / 32768`, yielding values in [0, 1). We replicate exactly that: parse
 * the RIFF `data` chunk, read signed 16-bit little-endian samples, divide by
 * 32768. Verified: table[1..4] == the golden `rand` values asserted in desktop's
 * `test/lang/core/test_random.rb` (0.75006103515625, 0.733917236328125,
 * 0.464202880859375, 0.24249267578125).
 */

/** The frozen stream length desktop hard-codes (`rand_peek`'s `% 441000`). */
export const RAND_STREAM_LENGTH = 441000

/** Divisor for WaveFile's pcm_16 → float conversion (signed 16-bit full scale). */
const PCM16_FULL_SCALE = 32768

const RIFF = 0x52494646 // 'RIFF'
const WAVE = 0x57415645 // 'WAVE'
const DATA = 0x64617461 // 'data'

/**
 * Decode a rand-stream wav (mono 16-bit PCM) into the 441,000-value table
 * `SPRand` indexes. Returns a `Float64Array` of `RAND_STREAM_LENGTH` values in
 * [0, 1), each `sampleInt16 / 32768`.
 *
 * Parses RIFF chunks to find `data` (rather than assuming a 44-byte header) so it
 * is robust to extra chunks. Throws on a non-RIFF/WAVE buffer or a missing `data`
 * chunk — a corrupt table must fail loudly, never silently mis-seed the stream.
 */
export function decodeRandStream(bytes: ArrayBuffer | Uint8Array): Float64Array {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)

  if (u8.byteLength < 12 || dv.getUint32(0, false) !== RIFF || dv.getUint32(8, false) !== WAVE) {
    throw new Error('RandStream: not a RIFF/WAVE buffer')
  }

  // Walk chunks from offset 12 to find `data`.
  let dataOff = -1
  let dataLen = 0
  let off = 12
  while (off + 8 <= u8.byteLength) {
    const id = dv.getUint32(off, false)
    const size = dv.getUint32(off + 4, true)
    if (id === DATA) {
      dataOff = off + 8
      dataLen = size
      break
    }
    off += 8 + size + (size & 1) // chunks are word-aligned
  }
  if (dataOff < 0) throw new Error('RandStream: no data chunk')

  const available = Math.min(RAND_STREAM_LENGTH, dataLen >> 1) // 2 bytes/sample
  const table = new Float64Array(RAND_STREAM_LENGTH)
  for (let i = 0; i < available; i++) {
    table[i] = dv.getInt16(dataOff + i * 2, true) / PCM16_FULL_SCALE
  }
  return table
}

// ---------------------------------------------------------------------------
// Process-wide random-stream registry (EPIC #531 Phase 1b + Phase 4)
//
// Desktop ships FIVE frozen tables — `white` (default) plus the `pink`,
// `light_pink`, `dark_pink`, `perlin` distributions (`sprand_core.rb:136-140`,
// selected by `use_random_source` / `random_numbers`). SPRand instances (one per
// ProgramBuilder) index the SAME shared tables — desktop loads them once at boot.
// We mirror that with one shared registry, loaded by whoever boots the engine:
// the browser fetches `/rand-stream*.wav` in `SonicPiEngine.init`; the Node test
// harness reads them from `public/` in the vitest setup. ProgramBuilder reads
// them synchronously, so they MUST be set before the first builder is constructed
// (after init / setup, never at import time). White is mandatory; the four
// distributions are loaded best-effort — `use_random_source` to an unloaded
// source throws loudly (never silently falls back to white, which would be the
// exact silent-divergence trap this EPIC removes).
// ---------------------------------------------------------------------------

/** The random distribution sources desktop ships (`NOISE_TYPES`, white = default). */
export const RAND_SOURCES = ['white', 'pink', 'light_pink', 'dark_pink', 'perlin'] as const
export type RandSource = (typeof RAND_SOURCES)[number]

/** `RandSource` → relative wav filename (white is the bare `rand-stream.wav`). */
export const RAND_SOURCE_FILES: Record<RandSource, string> = {
  white: 'rand-stream.wav',
  pink: 'rand-stream-pink.wav',
  light_pink: 'rand-stream-light-pink.wav',
  dark_pink: 'rand-stream-dark-pink.wav',
  perlin: 'rand-stream-perlin.wav',
}

const randStreams: Partial<Record<RandSource, Float64Array>> = {}

/** Install a decoded distribution table. Called once per source at boot. */
export function setRandStream(source: RandSource, table: Float64Array): void {
  randStreams[source] = table
}

/**
 * A distribution's table. Throws if not loaded — a builder must never silently
 * fall back to a wrong stream (re-introducing the MT19937-vs-desktop divergence
 * this EPIC removes). `use_random_source :pink` before pink is loaded fails loud.
 */
export function getRandStream(source: RandSource): Float64Array {
  const t = randStreams[source]
  if (!t) {
    throw new Error(
      `rand stream '${source}' not loaded — SonicPiEngine.init() (browser) or the ` +
        'test setup must load it before use_random_source selects it',
    )
  }
  return t
}

/** All loaded distribution tables (white guaranteed by callers; others optional). */
export function getRandStreams(): Partial<Record<RandSource, Float64Array>> {
  return { ...randStreams }
}

/** Install the decoded WHITE random stream (back-compat alias for the default). */
export function setWhiteRandStream(table: Float64Array): void {
  randStreams.white = table
}

/** Whether the white random stream has been loaded (init/setup guard). */
export function isWhiteRandStreamLoaded(): boolean {
  return randStreams.white != null
}

/** The shared white random table. Throws if not loaded (see getRandStream). */
export function getWhiteRandStream(): Float64Array {
  return getRandStream('white')
}

/**
 * Fetch + decode the white random stream from a URL and install it (browser
 * boot). No-op if already loaded (Node tests preload via fs). Defaults to the
 * Vite-served `/rand-stream.wav`; a library consumer serving it elsewhere passes
 * its own URL (mirrors the tree-sitter wasm URL override).
 */
export async function loadWhiteRandStream(url = '/rand-stream.wav'): Promise<void> {
  if (isWhiteRandStreamLoaded()) return
  const res = await fetch(url)
  if (!res.ok) throw new Error(`rand stream fetch failed: ${url} (${res.status})`)
  setWhiteRandStream(decodeRandStream(await res.arrayBuffer()))
}

/**
 * Fetch + decode all five distribution streams (EPIC #531 Phase 4). White is
 * mandatory (throws on failure — same contract as loadWhiteRandStream). The four
 * distributions are best-effort: a fetch failure is warned, not fatal, so a
 * consumer serving only `/rand-stream.wav` still boots — `use_random_source` to a
 * missing source then throws loudly at use, never silently mis-seeds. `baseUrl`
 * defaults to the served root (`/`); files are `RAND_SOURCE_FILES`.
 */
export async function loadRandStreams(baseUrl = '/'): Promise<void> {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'
  await loadWhiteRandStream(base + RAND_SOURCE_FILES.white)
  for (const source of RAND_SOURCES) {
    if (source === 'white' || randStreams[source]) continue
    try {
      const res = await fetch(base + RAND_SOURCE_FILES[source])
      if (!res.ok) throw new Error(`${res.status}`)
      setRandStream(source, decodeRandStream(await res.arrayBuffer()))
    } catch (e) {
      console.warn(
        `[SonicPi] rand distribution '${source}' not loaded (${(e as Error).message}); ` +
          `use_random_source :${source} will error until it is served`,
      )
    }
  }
}
