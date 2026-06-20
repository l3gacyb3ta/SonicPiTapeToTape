#!/usr/bin/env node
// Build the runtime needed to make the parity dashboards' code snippets
// PLAYABLE in-place (the Run/Stop control in audio-controls.js).
//
// Why a local bundle and not the npm CDN: the published @mjayb/sonicpijs is a
// code-split *library* — its dist/index.js dynamically imports a tree-sitter
// chunk that isn't even in the package, so a raw CDN load can init audio but
// never transpiles (verified: warmup → "parser not available"). esbuild-ing
// src/engine into ONE same-origin file inlines that chunk, so the transpiler
// comes alive (verified: warmup error=none, hasAudio=true).
//
// SuperSonic (GPL) is NEVER bundled — audio-controls.js injects it from the CDN
// at runtime, exactly as the app and the docs player do.
//
// Output (all gitignored — regenerate with `npm run dashboard:audio`):
//   test_results/spw-engine.mjs        the same-origin engine bundle
//   test_results/tree-sitter.wasm      tree-sitter runtime  (engine fetches /tree-sitter.wasm)
//   test_results/tree-sitter-ruby.wasm Ruby grammar          (engine fetches /tree-sitter-ruby.wasm)
//   test_results/rand-stream*.wav      frozen PRNG tables (EPIC #531)
//
// Inline audio therefore requires the dashboards to be SERVED with test_results/
// as the web root (npm run dashboard:serve, or the Vercel publish bundle). Opened
// via file:// the engine can't fetch /tree-sitter.wasm, so audio-controls.js shows
// only the "open in sonicpi.cc" link there — by design.

import { build } from 'esbuild'
import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'test_results')

// web-tree-sitter has dead Node-only branches (`require("fs")`/`require("path")`)
// guarded by environment detection. They never run in the browser; stub them to
// an empty module so esbuild's browser build resolves.
const stubNodeBuiltins = {
  name: 'stub-node-builtins',
  setup(b) {
    b.onResolve({ filter: /^(fs|path|module)$/ }, (a) => ({ path: a.path, namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {}', loader: 'js' }))
  },
}

await build({
  entryPoints: [join(root, 'src/engine/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  outfile: join(out, 'spw-engine.mjs'),
  plugins: [stubNodeBuiltins],
  logLevel: 'warning',
})

for (const f of [
  'tree-sitter.wasm',
  'tree-sitter-ruby.wasm',
  'rand-stream.wav',
  'rand-stream-pink.wav',
  'rand-stream-light-pink.wav',
  'rand-stream-dark-pink.wav',
  'rand-stream-perlin.wav',
]) {
  copyFileSync(join(root, 'public', f), join(out, f))
}

console.log('dashboard audio runtime → test_results/{spw-engine.mjs, tree-sitter*.wasm, rand-stream*.wav}')
