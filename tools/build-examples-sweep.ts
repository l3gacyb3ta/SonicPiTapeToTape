/**
 * build-examples-sweep.ts — mirror per-roster comparator artifacts into
 * test_results/<roster>/<slug>/ and emit a manifest JSON.
 *
 * Default roster = the 34 bundled Sonic Pi.app examples. Pass --roster
 * book-examples to build the 18 curriculum snippets instead.
 *
 * Idempotent: re-run picks up the latest matching .captures/compare_*<name>.md.
 *
 * Output (per roster):
 *   test_results/<rosterDir>/<slug>/{desktop.wav, web.wav, spectrogram.png, snippet.rb, report.md}
 *   test_results/<rosterDir>.json
 */
import { readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, statSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')
const CAPTURES = resolve(ROOT, '.captures')

// --- Roster config (selectable via --roster) -------------------------------
interface Roster {
  examplesDir: string
  outDirName: string     // test_results/<this>/
  outJsonName: string    // test_results/<this>.json
  recursive: boolean     // recurse into subdirs to collect .rb files?
}
const ROSTERS: Record<string, Roster> = {
  'official': {
    examplesDir: '/Applications/Sonic Pi.app/Contents/Resources/etc/examples',
    outDirName: 'examples-sweep',
    outJsonName: 'examples-sweep.json',
    recursive: true,
  },
  'book-examples': {
    examplesDir: resolve(ROOT, 'tests', 'book-examples'),
    outDirName: 'book-examples-sweep',
    outJsonName: 'book-examples-sweep.json',
    recursive: false,           // top-level only — community/in-thread-forum subdirs are their own rosters
  },
}

const argv = process.argv.slice(2)
// --public (or DASHBOARD_PUBLIC=1) → user-facing build: clean the per-row verdict
// explanation strings, zero the PRNG manifest flags (so no PRNG badges render),
// and strip the static viewer's PRNG chrome + methodology prose. The verdict
// badge, spectrogram, tempo/stats, dates and snippet stay. Dev build (no flag)
// keeps full diagnostic detail.
const PUBLIC = argv.includes('--public') || process.env.DASHBOARD_PUBLIC === '1'
const rosterName = (argv.find(a => a.startsWith('--roster=')) ?? '').split('=')[1]
  || (argv.includes('--roster') ? argv[argv.indexOf('--roster') + 1] : 'official')
if (!ROSTERS[rosterName]) {
  console.error(`Unknown roster '${rosterName}'. Valid: ${Object.keys(ROSTERS).join(', ')}`)
  process.exit(1)
}
const ROSTER = ROSTERS[rosterName]
const EXAMPLES_DIR = ROSTER.examplesDir
const OUT_DIR = resolve(ROOT, 'test_results', ROSTER.outDirName)
const OUT_JSON = resolve(ROOT, 'test_results', ROSTER.outJsonName)
console.log(`[build] roster='${rosterName}' src='${EXAMPLES_DIR}' → ${OUT_JSON}`)

// PRNG-indicating identifiers in user code → classifies row as PRNG-driven.
// Must stay IN SYNC with the same regex in `tools/compare-desktop-vs-web.ts`.
// The original `/\b(...|\.choose|\.shuffle|...)\b/` was buggy: (a) `\b\.choose`
// requires a word boundary before `.` which doesn't exist when `.choose`
// follows `]` or `)`, so `[1,2].choose` and `(x).shuffle` were missed
// entirely; (b) it had no support for Ruby's function-call form
// `choose([1,2])`/`shuffle(...)`/`pick(...)`. Net effect: 4 of the post-#370
// sweep's "8 PRNG-free actionable engine bugs" were mis-routed cross-engine-
// PRNG rows. Three call-shapes the corrected regex covers:
//   1. bare word:  rrand / rrand_i / rand / rand_i / one_in / dice / use_random_seed
//   2. dot-method: .choose / .shuffle / .pick   (any expression)
//   3. fn-call:    choose( / shuffle( / pick(    (Ruby's function form)
const PRNG_RE = /(\b(?:rrand|rrand_i|rand|rand_i|one_in|dice|use_random_seed)\b|\.(?:choose|shuffle|pick)\b|\b(?:choose|shuffle|pick)\s*\()/

interface SweepRow {
  n: number
  slug: string
  category: string
  example: string
  path: string
  verdict: 'match' | 'event-match' | 'diverge' | 'prng-variant' | 'invalid' | 'inconcl' | 'error' | 'engine-silent' | 'tool-fail'
  verdictRaw: string
  tempoDesktop: number | null
  tempoWeb: number | null
  divergeAt: string | null
  prng: boolean
  prngFreeReal: boolean
  heavy: boolean
  pitchDesktop: string | null
  pitchWeb: string | null
  detectMethodDesktop: string | null
  detectMethodWeb: string | null
  onsetDesktop: number | null
  onsetWeb: number | null
  tier0Soft: boolean
  tier0Hard: string | null
  rmsRatio: number | null
  peakRatio: number | null
  l2MelDb: number | null
  mfccDist: number | null
  desktopStats: { duration: number; peak: number; rms: number; clipping: number; sampleRate: number; channels: number } | null
  webStats: { duration: number; peak: number; rms: number; clipping: number; sampleRate: number; channels: number } | null
  artifacts: {
    snippet: string | null
    desktopWav: string | null
    webWav: string | null
    spectrogramPng: string | null
    report: string | null
  }
  consoleErrors: string[]
  reportTimestamp: string | null
  snippetSrc: string   // inlined .rb source so the viewer renders it on file:// without fetch()
}

// Relative paths under EXAMPLES_DIR — recursive or top-level per roster config.
const EXAMPLES: string[] = []
function collectRb(dir: string, recurse: boolean) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (recurse) collectRb(p, true)
    } else if (name.endsWith('.rb')) {
      EXAMPLES.push(p)
    }
  }
}
collectRb(EXAMPLES_DIR, ROSTER.recursive)
EXAMPLES.sort()

function findLatestReport(exampleBaseNoExt: string): string | null {
  if (!existsSync(CAPTURES)) return null
  // Match the report's NAME SEGMENT (everything after the ISO timestamp's `Z_`)
  // EXACTLY — not as a suffix. The old `endsWith('_<base>.md')` let a community /
  // in-thread-forum report `compare_<ts>Z_comm-<roster>__NN_<base>.md` (a DIFFERENT
  // remix that happens to share the bare basename, e.g. community__10_idm_breakbeat)
  // collide with the official/book `<base>` row. Because community runs LAST in the
  // full sweep its report has the newest mtime and wins the sort — poisoning the
  // official verdict (official idm_breakbeat EVENT-MATCH mis-read as the community
  // remix's DIVERGE). Anchoring on the timestamp boundary makes the match exact.
  const files = readdirSync(CAPTURES)
    .filter(f => {
      if (!f.startsWith('compare_') || !f.endsWith('.md')) return false
      const m = f.match(/Z_(.+)\.md$/)
      return m !== null && m[1] === exampleBaseNoExt
    })
    .map(f => resolve(CAPTURES, f))
  if (!files.length) return null
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return files[0]
}

function parseReport(reportPath: string): Partial<SweepRow> {
  const md = readFileSync(reportPath, 'utf8')
  const row: Partial<SweepRow> = {
    pitchDesktop: null, pitchWeb: null, divergeAt: null,
    tempoDesktop: null, tempoWeb: null,
    onsetDesktop: null, onsetWeb: null,
    rmsRatio: null, peakRatio: null, l2MelDb: null, mfccDist: null,
    desktopStats: null, webStats: null,
    tier0Soft: false, tier0Hard: null,
    verdictRaw: '',
    detectMethodDesktop: null, detectMethodWeb: null,
    consoleErrors: [],
    reportTimestamp: null,
  }

  // Timestamp
  const ts = md.match(/\*\*Timestamp:\*\*\s+([^\n]+)/)
  if (ts) row.reportTimestamp = ts[1].trim()

  // Verdict headline
  const verdictLine = md.match(/^###\s+(.+)$/m)
  if (verdictLine) {
    row.verdictRaw = verdictLine[1].trim()
    // SV61 (#377/#378): EVENT-MATCH MUST be matched FIRST. Its headline QUOTES
    // the superseded audio verdict (e.g. `…said "PITCH DIVERGENCE at note 2…"`),
    // so the PITCH DIVERGENCE / inconclusive branches below would mis-route it if
    // they ran first. EVENT-MATCH = the /s_new onset-sequence parity tiebreaker
    // promoted a false audio DIVERGE/INCONCL to a pass (engine plays the right
    // notes at the right times; residual is stage-7 rendering / tracker noise).
    if (/^✅ EVENT-MATCH\b/.test(row.verdictRaw)) row.verdict = 'event-match'
    // SV69 (EPIC #531 Phase 5b): EVENT-DIVERGE = the /s_new onset-sequence / per-tick
    // NOTE parity diverged from desktop. Matched BEFORE the PRNG-VARIANT rule below
    // (the headline mentions neither, but order-safety: a real PRNG divergence is no
    // longer demoted to the cos "variant" bucket — it is a real divergence).
    else if (/^❌ EVENT-DIVERGE\b/.test(row.verdictRaw)) row.verdict = 'diverge'
    // #371: match ERROR before INVALID — the ERROR header contains "❌" too,
    // and the ERROR root cause must NOT be re-bucketed as a generic INVALID.
    else if (/^❌ ERROR\b/.test(row.verdictRaw) || /\bERROR\b — Web engine threw/.test(row.verdictRaw)) row.verdict = 'error'
    else if (/PRNG-VARIANT/.test(row.verdictRaw)) row.verdict = 'prng-variant'
    else if (/PITCH-MATCH/.test(row.verdictRaw)) row.verdict = 'match'
    else if (/PITCH DIVERGENCE/.test(row.verdictRaw)) {
      row.verdict = 'diverge'
      const m = row.verdictRaw.match(/at (note|pc) (\d+)/)
      if (m) row.divergeAt = `${m[1]} ${m[2]}`
    }
    // SV48 (#427): name the missing-WAV layer — ENGINE-SILENT (engine ran, no
    // audio) and TOOL-FAIL (harness lost a real blob) are distinct from a
    // precondition INVALID. Matched before INVALID.
    else if (/^❌ ENGINE-SILENT\b/.test(row.verdictRaw)) row.verdict = 'engine-silent'
    else if (/^❌ TOOL-FAIL\b/.test(row.verdictRaw)) row.verdict = 'tool-fail'
    else if (/INVALID/.test(row.verdictRaw)) row.verdict = 'invalid'
    else if (/inconclusive/i.test(row.verdictRaw)) row.verdict = 'inconcl'
    else row.verdict = 'inconcl'
  }

  // Tier-0 SOFT / HARD
  if (/0\.2[^\n]*\(SOFT/.test(md)) row.tier0Soft = true
  const hard = md.match(/✗\s+(Web produced no WAV[^\n]*)/)
  if (hard) row.tier0Hard = hard[1]
  const hardSR = md.match(/✗\s+(Sample rate inconsistent[^\n]*)/)
  if (hardSR) row.tier0Hard = (row.tier0Hard ? row.tier0Hard + '; ' : '') + hardSR[1]

  // Pitch tracks and detect methods
  const pitchD = md.match(/desktop:\s+`([0-9,\s]+)`/)
  const pitchW = md.match(/web&nbsp;&nbsp;&nbsp;:\s+`([0-9,\s]+)`/)
  if (pitchD) row.pitchDesktop = pitchD[1]
  if (pitchW) row.pitchWeb = pitchW[1]
  const dm = md.match(/method:\s+desktop\s+`(\w+)`[^\n]*·\s+web\s+`(\w+)`/)
  if (dm) { row.detectMethodDesktop = dm[1]; row.detectMethodWeb = dm[2] }

  // Tempo
  const tempo = md.match(/Tempo \(inter-onset\):\*\*\s+[✓✗]\s+desktop\s+([\d.]+)s\s+·\s+web\s+([\d.]+)s/)
  if (tempo) { row.tempoDesktop = parseFloat(tempo[1]); row.tempoWeb = parseFloat(tempo[2]) }

  // Onset counts
  const onset = md.match(/Onset count:\*\*\s+desktop\s+(\d+)\s+·\s+web\s+(\d+)/)
  if (onset) { row.onsetDesktop = parseInt(onset[1]); row.onsetWeb = parseInt(onset[2]) }

  // Stats table
  const stats = md.match(/Duration \(s\)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+|—)/)
  if (stats) {
    const dDur = parseFloat(stats[1])
    const wDur = stats[2] === '—' ? null : parseFloat(stats[2])
    const peak = md.match(/\|\s+Peak\s+\|\s+([\d.]+)\s+\|\s+([\d.]+|—)/)
    const rms  = md.match(/\|\s+RMS\s+\|\s+([\d.]+)\s+\|\s+([\d.]+|—)/)
    const clip = md.match(/\|\s+Clipping[^|]+\|\s+([\d.]+)\s+\|\s+([\d.]+|—)/)
    const sr   = md.match(/\|\s+Sample rate \(Hz\)\s+\|\s+(\d+)\s+\|\s+(\d+|—)/)
    const ch   = md.match(/\|\s+Channels\s+\|\s+(\d+)\s+\|\s+(\d+|—)/)
    if (peak && rms) {
      row.desktopStats = {
        duration: dDur,
        peak: parseFloat(peak[1]),
        rms: parseFloat(rms[1]),
        clipping: clip ? parseFloat(clip[1]) : 0,
        sampleRate: sr ? parseInt(sr[1]) : 48000,
        channels: ch ? parseInt(ch[1]) : 2,
      }
      if (wDur !== null && peak[2] !== '—' && rms[2] !== '—') {
        row.webStats = {
          duration: wDur,
          peak: parseFloat(peak[2]),
          rms: parseFloat(rms[2]),
          clipping: clip && clip[2] !== '—' ? parseFloat(clip[2]) : 0,
          sampleRate: sr && sr[2] !== '—' ? parseInt(sr[2]) : 48000,
          channels: ch && ch[2] !== '—' ? parseInt(ch[2]) : 2,
        }
      }
    }
  }

  // Ratios (Tier 3)
  const rmsR = md.match(/RMS ratio web\/desktop\s+=\s+([\d.]+)×/)
  const peakR = md.match(/Peak ratio web\/desktop\s+=\s+([\d.]+)×/)
  if (rmsR) row.rmsRatio = parseFloat(rmsR[1])
  if (peakR) row.peakRatio = parseFloat(peakR[1])

  // L2 / MFCC
  const l2 = md.match(/L2 distance \(mel-dB\)\s+\|\s+([\d.]+)/)
  const mfcc = md.match(/MFCC distance \(timbre\)\s+\|\s+([\d.]+)/)
  if (l2) row.l2MelDb = parseFloat(l2[1])
  if (mfcc) row.mfccDist = parseFloat(mfcc[1])

  // Web stdout — capture error fragments
  const webStdout = md.match(/### Web\n```\n([\s\S]+?)```/)
  if (webStdout) {
    const errs = webStdout[1].match(/(Detail:[^\n]+|.+isn't available[^\n]*|.+is not a function[^\n]*)/g)
    if (errs) row.consoleErrors = errs.slice(0, 5)
  }

  // Source WAV paths
  const wavD = md.match(/\*\*Desktop:\*\*\s+([^\n]+\.wav)/)
  const wavW = md.match(/\*\*Web:\*\*\s+(?!_)([^\n]+\.wav)/)
  // Spectrogram PNG
  const png = md.match(/!\[spectrogram[^\]]*\]\(([^)]+\.png)\)/)
  row.artifacts = {
    snippet: null,
    desktopWav: wavD ? wavD[1].trim() : null,
    webWav: wavW ? wavW[1].trim() : null,
    spectrogramPng: png ? png[1].trim() : null,
    report: reportPath,
  }
  return row
}

// Short, clean verdict label for public mode — derived from the verdict category,
// replacing the verbose internal explanation in `verdictRaw`.
function publicVerdictLabel(v: SweepRow['verdict']): string {
  switch (v) {
    case 'match':
    case 'event-match':
    case 'prng-variant':
      return 'Matches desktop'
    case 'diverge':
      return 'Differs from desktop'
    case 'engine-silent':
    case 'tool-fail':
    case 'error':
      return 'Could not be captured'
    default:
      return 'Inconclusive'
  }
}

function slugify(path: string): string {
  // illusionist/chord_inversions.rb → illusionist__chord_inversions
  return path.replace(/\.rb$/, '').replace(/\//g, '__')
}

function copyArtifact(srcAbs: string, destAbs: string): boolean {
  if (!existsSync(srcAbs)) return false
  mkdirSync(dirname(destAbs), { recursive: true })
  copyFileSync(srcAbs, destAbs)
  return true
}

mkdirSync(OUT_DIR, { recursive: true })

const rows: SweepRow[] = []
let n = 0

for (const examplePath of EXAMPLES) {
  n++
  const rel = examplePath.substring(EXAMPLES_DIR.length + 1)
  // Two layouts handled:
  //   - nested (recursive=true):  "<category>/<file>.rb"  → category from prefix
  //   - flat   (recursive=false): "<file>.rb"             → category derived from filename prefix (chN_/eN_/etc.) or 'main'
  let category: string
  let file: string
  if (rel.includes('/')) {
    [category, file] = rel.split('/')
  } else {
    file = rel
    const m = file.match(/^(ch\d+|e2e_\d+|[a-z]+)_/)
    category = m ? m[1] : 'main'
  }
  const example = file.replace(/\.rb$/, '')
  const slug = slugify(rel)
  const exampleSrc = readFileSync(examplePath, 'utf8')
  const prng = PRNG_RE.test(exampleSrc)

  const report = findLatestReport(example)
  const parsed: Partial<SweepRow> = report ? parseReport(report) : { verdict: 'invalid', verdictRaw: 'NO REPORT — sweep not run for this example' }

  // Decide classification badges
  const heavyHint = parsed.tier0Hard?.includes('no WAV') ?? false

  const row: SweepRow = {
    n,
    slug,
    category,
    example,
    path: rel,
    verdict: parsed.verdict ?? 'invalid',
    verdictRaw: parsed.verdictRaw ?? '',
    tempoDesktop: parsed.tempoDesktop ?? null,
    tempoWeb: parsed.tempoWeb ?? null,
    divergeAt: parsed.divergeAt ?? null,
    prng,
    prngFreeReal: false, // set after verdict
    heavy: heavyHint,
    pitchDesktop: parsed.pitchDesktop ?? null,
    pitchWeb: parsed.pitchWeb ?? null,
    detectMethodDesktop: parsed.detectMethodDesktop ?? null,
    detectMethodWeb: parsed.detectMethodWeb ?? null,
    onsetDesktop: parsed.onsetDesktop ?? null,
    onsetWeb: parsed.onsetWeb ?? null,
    tier0Soft: parsed.tier0Soft ?? false,
    tier0Hard: parsed.tier0Hard ?? null,
    rmsRatio: parsed.rmsRatio ?? null,
    peakRatio: parsed.peakRatio ?? null,
    l2MelDb: parsed.l2MelDb ?? null,
    mfccDist: parsed.mfccDist ?? null,
    desktopStats: parsed.desktopStats ?? null,
    webStats: parsed.webStats ?? null,
    consoleErrors: parsed.consoleErrors ?? [],
    reportTimestamp: parsed.reportTimestamp ?? null,
    snippetSrc: exampleSrc,
    artifacts: { snippet: null, desktopWav: null, webWav: null, spectrogramPng: null, report: null },
  }
  // Real divergence = any DIVERGE verdict (the actionable backlog). Post-EPIC-#531
  // (Phase 5b, SV69) PRNG pieces are graded by event-parity, so a PRNG DIVERGE is a
  // REAL engine bug (a divergent random walk), no longer an SV49 non-goal — it
  // counts here too. ERROR rows are root-caused by a throw, not parity; they belong
  // to their own bucket (#371) and must NOT inflate the backlog. (Field name kept
  // for manifest back-compat; it now means "real divergences", PRNG included.)
  if (row.verdict === 'diverge') row.prngFreeReal = true

  // Public mode: the viewer renders `verdictRaw` verbatim in the detail panel and
  // emits PRNG / real badges from these flags. Replace the verbose internal
  // explanation with a short clean label and clear the PRNG flags so no PRNG
  // framing reaches the page. The clean `verdict` badge still carries the result.
  if (PUBLIC) {
    row.verdictRaw = publicVerdictLabel(row.verdict)
    row.prng = false
    row.prngFreeReal = false
  }

  // Copy artifacts into test_results/<rosterDir>/<slug>/. Manifest paths MUST use
  // ROSTER.outDirName, NOT a hardcoded 'examples-sweep' — otherwise a non-official
  // roster (e.g. book-examples-sweep) copies artifacts to the right dir but links
  // them under examples-sweep/, so every <img>/<a> 404s (spectrograms vanish).
  const rosterDir = ROSTER.outDirName
  const slugDir = resolve(OUT_DIR, slug)
  // Snippet (always — straight from EXAMPLES_DIR)
  const snippetDest = join(slugDir, 'snippet.rb')
  copyArtifact(examplePath, snippetDest)
  row.artifacts.snippet = `${rosterDir}/${slug}/snippet.rb`

  if (parsed.artifacts?.desktopWav) {
    const dest = join(slugDir, 'desktop.wav')
    if (copyArtifact(parsed.artifacts.desktopWav, dest)) {
      row.artifacts.desktopWav = `${rosterDir}/${slug}/desktop.wav`
    }
  }
  if (parsed.artifacts?.webWav) {
    const dest = join(slugDir, 'web.wav')
    if (copyArtifact(parsed.artifacts.webWav, dest)) {
      row.artifacts.webWav = `${rosterDir}/${slug}/web.wav`
    }
  }
  if (parsed.artifacts?.spectrogramPng) {
    const dest = join(slugDir, 'spectrogram.png')
    if (copyArtifact(parsed.artifacts.spectrogramPng, dest)) {
      row.artifacts.spectrogramPng = `${rosterDir}/${slug}/spectrogram.png`
    }
  }
  if (parsed.artifacts?.report) {
    const dest = join(slugDir, 'report.md')
    if (copyArtifact(parsed.artifacts.report, dest)) {
      row.artifacts.report = `${rosterDir}/${slug}/report.md`
    }
  }

  rows.push(row)
}

// Counts and the headline sweep metadata
const counts = {
  match: rows.filter(r => r.verdict === 'match').length,
  eventMatch: rows.filter(r => r.verdict === 'event-match').length, // SV61 tiebreaker pass
  diverge: rows.filter(r => r.verdict === 'diverge').length,
  prngVariant: rows.filter(r => r.verdict === 'prng-variant').length,
  invalid: rows.filter(r => r.verdict === 'invalid').length,
  inconcl: rows.filter(r => r.verdict === 'inconcl').length,
  error: rows.filter(r => r.verdict === 'error').length,
  engineSilent: rows.filter(r => r.verdict === 'engine-silent').length,
  toolFail: rows.filter(r => r.verdict === 'tool-fail').length,
  // In public mode the per-row PRNG flags are cleared above, so these collapse to
  // 0 — no PRNG framing in the summary/intro counts.
  prng: rows.filter(r => r.prng).length,
  prngFreeReal: rows.filter(r => r.prngFreeReal).length,
  heavy: rows.filter(r => r.heavy).length,
  totalRows: rows.length,
}

const manifest = {
  generatedAt: new Date().toISOString(),
  source: '/Applications/Sonic Pi.app/Contents/Resources/etc/examples/',
  toolUsed: 'tools/compare-desktop-vs-web.ts',
  durationMs: 15000,
  perExampleTimeoutSec: 90,
  counts,
  entries: rows,
}

// --- Public-mode viewer cleaning -------------------------------------------
// The two sweep viewers (examples-sweep.html / book-examples-sweep.html) are
// hand-maintained static templates; this builder only injects the manifest. In
// public mode we additionally strip their PRNG chrome + methodology prose so the
// published page is user-facing. Operations are anchored on the template's stable
// marker classes/attributes; JS stays valid (removed filter buttons just yield an
// empty NodeList in the chip-listener loop — no thrown error).
function cleanViewerForPublic(html: string): string {
  // 1) Remove the methodology "context note" (Sweep state / confounds / SV codes).
  html = html.replace(/<div class="context-note">[\s\S]*?<\/div>/, '')
  // 2) Remove the PRNG / PRNG-free filter buttons (the data-filter chips). The
  //    verdict chips (data-verdict) stay; the chip-click listener tolerates their
  //    absence (querySelectorAll → empty).
  html = html.replace(/\s*<button class="chip" data-filter="(?:prng|real)"[^>]*>[\s\S]*?<\/button>/g, '')
  // 3) Replace the renderIntro methodology body (tldr PRNG framing + the Confound
  //    sections + issue-list + "How to read each row" SV prose) with a clean
  //    intro that keeps the heading + the verdict stat-grid (still clickable).
  html = html.replace(
    /(\$\('detail'\)\.innerHTML = `\s*<div class="intro">)[\s\S]*?(<div class="stat-grid">[\s\S]*?)<div class="section-h">[\s\S]*?(`;\s*for \(const stat of \$\('detail'\)\.querySelectorAll\('\.stat\[data-only\]'\)\))/,
    `$1
            <h1>Sonic Pi Examples — Desktop &harr; Web Sweep</h1>
            <div style="color:var(--text-mute);font-family:var(--mono);font-size:11px;margin:4px 0 18px">
              Each example is run on desktop Sonic Pi and on the browser engine, then compared. Pitch (the note progression) is the verdict.
            </div>
            $2
            <div class="footer-meta">
              <strong>How to read each row:</strong> click an example in the sidebar to load its desktop &harr; web detail panel — both renderings, the spectrogram comparison, the note progression, and basic tempo/level stats. Pitch is the musical-correctness verdict; timbre and level are supporting only.
            </div>
          $3`,
  )
  // 4) Scrub any residual catalogue codes + PRNG framing in the remaining template
  //    text (per-row TLDR banners, "How to read this" Tier prose, badge labels).
  //    The manifest slot is overwritten afterwards, so scrubbing its old content
  //    here is harmless.
  html = html
    .replace(/\bPRNG[- ]?(?:VARIANT|variant)\b/g, 'variant')
    .replace(/\bPRNG[- ]?free\b/gi, 'genuine')
    .replace(/\bPRNG[- ]?driven\b/gi, 'randomness-driven')
    .replace(/\bcross-engine PRNG\b/gi, 'cross-engine randomness')
    .replace(/\bPRNG\b/g, 'randomness')
    .replace(/\brandom walk\b/gi, 'random stream')
    .replace(/\brand-stream\b/gi, 'random-stream')
    .replace(/\(\s*(?:SV|SP|SK)\d+(?:\s*[\/,]\s*(?:SV|SP|SK)?\d+)*\s*\)/g, '')
    .replace(/\bper (?:SV|SP|SK)\d+\b/gi, '')
    .replace(/\b(?:SV|SP|SK)\d+(?:\s*\/\s*(?:SV|SP|SK)\d+)*\b/g, '')
    .replace(/\bConfound\b/g, 'Caveat')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
  return html
}

writeFileSync(OUT_JSON, JSON.stringify(manifest, null, 2))

// Bake the manifest into the static viewer's inline <script id="__manifest__">
// slot so the page renders on file:// without fetch() (browsers block fetch()
// on the file:// protocol). The viewer falls back to fetch() when served over
// http and the slot is empty/null.
const VIEWER_HTML = resolve(ROOT, 'test_results', `${ROSTER.outDirName}.html`)
if (existsSync(VIEWER_HTML)) {
  let html = readFileSync(VIEWER_HTML, 'utf8')
  // Public mode: strip the static viewer's PRNG chrome + methodology prose at the
  // source (the chrome is hand-maintained in this template, not generated above).
  // NOTE: this mutates the on-disk template, so the publish flow must start from
  // the pristine git-tracked template (publish-dashboards.sh does `git checkout`
  // on these viewers first). Dev rebuilds (no --public) also start from git.
  if (PUBLIC) html = cleanViewerForPublic(html)
  const inlineJson = JSON.stringify(manifest).replace(/<\//g, '<\\/') // guard against </script>
  const slotRe = /(<script id="__manifest__" type="application\/json">)[\s\S]*?(<\/script>)/
  if (slotRe.test(html)) {
    writeFileSync(VIEWER_HTML, html.replace(slotRe, `$1${inlineJson}$2`))
    console.log(`✓ inlined manifest into ${ROSTER.outDirName}.html (renders on file://)${PUBLIC ? ' [public]' : ''}`)
  } else {
    console.log(`⚠ ${ROSTER.outDirName}.html has no __manifest__ slot — left fetch-only`)
  }
}

console.log(`✓ Built ${rows.length} entries → ${OUT_JSON}`)
console.log(`  match=${counts.match} · event-match=${counts.eventMatch} · prng-variant=${counts.prngVariant} · diverge=${counts.diverge} · invalid=${counts.invalid} · inconcl=${counts.inconcl} · error=${counts.error}`)
console.log(`  PRNG-driven=${counts.prng} · real divergences=${counts.prngFreeReal} (the actionable backlog, PRNG graded by event-parity, SV69) · heavy-tool-fail=${counts.heavy}`)
const missingDesk = rows.filter(r => !r.artifacts.desktopWav).length
const missingWeb = rows.filter(r => !r.artifacts.webWav).length
const missingPng = rows.filter(r => !r.artifacts.spectrogramPng).length
console.log(`  missing artifacts: desktop.wav=${missingDesk} · web.wav=${missingWeb} · spectrogram.png=${missingPng}`)
