#!/usr/bin/env node
/**
 * upload-dashboard-r2-s3.mjs — bulk-upload dashboard PNGs to Cloudflare R2 via the S3 API.
 *
 * Reads credentials from .env.r2.local (gitignored). Object key for each image is
 * its path relative to SRC (default test_results/), matching the references that
 * build-dashboard-publish.mjs bakes into the bundle.
 *
 * Requires @aws-sdk/client-s3 (install transiently with: npm i @aws-sdk/client-s3 --no-save).
 *
 * Usage:
 *   node tools/upload-dashboard-r2-s3.mjs            # uploads all *.png under test_results/
 *   node tools/upload-dashboard-r2-s3.mjs --src test_results --dry
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { S3Client, PutObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
const DRY = argv.includes('--dry')
const SRC = arg('--src', 'test_results')
const CONCURRENCY = Number(arg('--concurrency', '8'))

// --- load .env.r2.local ---
const env = {}
for (const line of readFileSync('.env.r2.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2]
}
const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env
const ENDPOINT = env.R2_S3_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
for (const [k, v] of Object.entries({ R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY })) {
  if (!v) { console.error(`ERROR: ${k} missing in .env.r2.local`); process.exit(1) }
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
})

// --- collect PNGs ---
const pngs = []
;(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (extname(name).toLowerCase() === '.png') pngs.push(full)
  }
})(SRC)
pngs.sort()

console.log(`R2 endpoint : ${ENDPOINT}`)
console.log(`bucket      : ${R2_BUCKET}`)
console.log(`source      : ${SRC}/  (${pngs.length} PNGs)`)
if (DRY) { pngs.slice(0, 5).forEach(f => console.log('  key:', relative(SRC, f))); console.log('  ... (--dry, nothing uploaded)'); process.exit(0) }

// --- validate creds / bucket reachable ---
try {
  await s3.send(new HeadBucketCommand({ Bucket: R2_BUCKET }))
  console.log('bucket reachable ✓')
} catch (e) {
  console.error('ERROR: cannot reach bucket — check creds / bucket name.')
  console.error(`  ${e.name}: ${e.message}`)
  process.exit(1)
}

// --- upload with bounded concurrency ---
let done = 0, failed = 0
async function put(file) {
  const Key = relative(SRC, file)
  try {
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key, Body: readFileSync(file), ContentType: 'image/png',
    }))
    done++
    if (done % 25 === 0 || done === pngs.length) console.log(`  ${done}/${pngs.length} uploaded`)
  } catch (e) {
    failed++
    console.error(`  FAIL ${Key}: ${e.name} ${e.message}`)
  }
}

const queue = [...pngs]
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) await put(queue.shift())
}))

console.log(`\nDone: ${done} uploaded, ${failed} failed, of ${pngs.length}.`)
process.exit(failed ? 1 : 0)
