#!/usr/bin/env node
/**
 * build-dashboard-publish.mjs — produce a web-deployable dashboard bundle.
 *
 * The local test_results/ tree is ~1.1 GB, almost all of it WAV recordings.
 * For public hosting we:
 *   - DROP every .wav (audio is not hosted)
 *   - MOVE every .png (spectrograms / per-beat plots, ~59 MB) to Cloudflare R2,
 *     rewriting each reference to the R2 public base URL
 *   - keep the HTML / JSON / MD / snippet files (~7.5 MB) for Vercel
 *
 * Asset references come in two flavours, both handled here:
 *   1. JSON-manifest string values embedded in the HTML / sidecar .json:
 *        "spectrogramPng":"examples-sweep/slug/spectrogram.png"
 *        "perBeatPng":"...", "desktopWav":"...", "webWav":"..."
 *   2. Static tags emitted by the Python builders (community.html, e2e.html):
 *        <img src="community/community/01_x/spectrogram.png">
 *        <audio controls preload="metadata" src="community/.../web.wav"></audio>
 *
 * Usage:
 *   R2_BASE="https://imgs.sonicpi.cc" node tools/build-dashboard-publish.mjs
 *   node tools/build-dashboard-publish.mjs --r2-base https://<bucket>.<acct>.r2.dev \
 *        [--src test_results] [--out dashboard-dist]
 *
 * The R2 object key for each image is its path relative to --src, so the upload
 * step is a straight mirror of the .png tree into the bucket root.
 */
import {
  readdirSync, statSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync,
} from 'node:fs'
import { join, dirname, relative, extname } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def }

const R2_BASE = (arg('--r2-base', process.env.R2_BASE) || '').replace(/\/+$/, '')
const SRC = arg('--src', 'test_results')
const OUT = arg('--out', 'dashboard-dist')

if (!R2_BASE) {
  console.error('ERROR: provide the R2 public base URL via R2_BASE env or --r2-base <url>.')
  console.error('       e.g. R2_BASE="https://<bucket>.<account>.r2.dev" node tools/build-dashboard-publish.mjs')
  process.exit(1)
}

// Every relative asset path is rooted at one of these dashboard sub-trees.
const PREFIXES = [
  'book-examples-sweep', 'community', 'e2e', 'examples-sweep',
  'experiments', 'gate-detail', 'raw-lpf', 'sp107',
]
const prefixAlt = PREFIXES.join('|')

const TEXT_EXT = new Set(['.html', '.json', '.md'])

const stats = {
  html: 0, json: 0, md: 0, copied: 0,
  droppedWav: 0, droppedPng: 0, pngRefs: 0, wavRefs: 0,
}

function rewrite(text) {
  // 1) PNG relative refs -> absolute R2 URL (covers both quoted JSON values and
  //    src="..."/href="..." attributes; both are quoted strings).
  const pngRe = new RegExp(`(["'])((?:${prefixAlt})\\/[^"']*?\\.png)\\1`, 'g')
  text = text.replace(pngRe, (_m, q, p) => { stats.pngRefs++; return `${q}${R2_BASE}/${p}${q}` })

  // 2) WAV manifest values -> null. The dashboards already render a graceful
  //    "missing artifact" state when these are null.
  const wavJsonRe = /"(desktopWav|webWav)"\s*:\s*"[^"]*\.wav"/g
  text = text.replace(wavJsonRe, (_m, k) => { stats.wavRefs++; return `"${k}":null` })

  // 3) Static <audio ...wav...></audio> -> inline "not hosted" note.
  const audioRe = /<audio\b[^>]*\.wav[^>]*>\s*<\/audio>/g
  text = text.replace(audioRe, () => {
    stats.wavRefs++
    return '<div class="audio-na" style="font-size:11px;color:#888;font-style:italic;padding:6px 0">audio not hosted (WAVs excluded from web deploy)</div>'
  })

  // 4) Any leftover quoted relative .wav (download links, <source>) -> '#'.
  const wavRelRe = new RegExp(`(["'])(?:${prefixAlt})\\/[^"']*?\\.wav\\1`, 'g')
  text = text.replace(wavRelRe, (_m, q) => { stats.wavRefs++; return `${q}#${q}` })

  return text
}

// One-time banner so the per-row "wav missing" placeholders read as deliberate.
const BANNER = '<div style="background:#1f2335;color:#c0caf5;border-bottom:1px solid #2a2f45;'
  + 'padding:8px 14px;font:500 12px/1.5 system-ui,sans-serif;text-align:center">'
  + '🔇 Audio playback is disabled on the hosted dashboard — WAV recordings are excluded to keep the deploy light. '
  + 'Spectrograms are served from Cloudflare R2. Run the sweep locally for audio.</div>'

function injectBanner(html) {
  // insert immediately after the opening <body ...> tag (once)
  return html.replace(/(<body\b[^>]*>)/i, (m) => `${m}\n${BANNER}`)
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) { walk(full); continue }

    const ext = extname(name).toLowerCase()
    if (ext === '.wav') { stats.droppedWav++; continue } // never ship WAVs
    if (ext === '.png') { stats.droppedPng++; continue } // images live on R2

    const rel = relative(SRC, full)
    const dest = join(OUT, rel)
    mkdirSync(dirname(dest), { recursive: true })

    if (TEXT_EXT.has(ext)) {
      let out = rewrite(readFileSync(full, 'utf8'))
      if (ext === '.html') out = injectBanner(out)
      writeFileSync(dest, out)
      stats[ext.slice(1)]++
    } else {
      copyFileSync(full, dest) // .rb snippets, .css, .svg, etc.
      stats.copied++
    }
  }
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
walk(SRC)

// Static-site Vercel config: no build, no install, serve the dir as-is.
// (Without this, Vercel inherits a build command and fails — there is no package.json here.)
writeFileSync(join(OUT, 'vercel.json'), JSON.stringify({
  $schema: 'https://openapi.vercel.sh/vercel.json',
  buildCommand: "echo 'static dashboard — no build'",
  installCommand: "echo 'static dashboard — no install'",
  outputDirectory: '.',
  framework: null,
}, null, 2) + '\n')

console.log(`[dashboard-publish] R2_BASE = ${R2_BASE}`)
console.log(`[dashboard-publish] out     = ${OUT}/`)
console.log(`  text: html=${stats.html} json=${stats.json} md=${stats.md} · other-copied=${stats.copied}`)
console.log(`  png refs -> R2:        ${stats.pngRefs}`)
console.log(`  wav refs nulled/stripped: ${stats.wavRefs}`)
console.log(`  excluded files:        wav=${stats.droppedWav} png=${stats.droppedPng}`)
console.log('')
console.log('Next: upload the .png tree to R2 (object key = path under ' + SRC + '), then deploy ' + OUT + '/ to Vercel.')
