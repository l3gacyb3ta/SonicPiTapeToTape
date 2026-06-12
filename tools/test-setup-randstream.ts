/**
 * Vitest setup — load desktop's frozen rand streams for Node tests (EPIC #531).
 *
 * Every ProgramBuilder indexes the shared frozen tables (the browser fetches them
 * at SonicPiEngine.init; here we read the served wavs from `public/` via fs). All
 * five distributions are loaded so `use_random_source` tests resolve (Phase 4).
 * Lives in tools/ (not src/engine/__tests__/) so it can use node:fs without the
 * src tsconfig — which has no @types/node — failing to type-check it. Registered
 * alongside the tree-sitter setup in vitest.config.ts.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  decodeRandStream,
  setRandStream,
  isWhiteRandStreamLoaded,
  RAND_SOURCES,
  RAND_SOURCE_FILES,
} from '../src/engine/RandStream'

if (!isWhiteRandStreamLoaded()) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  for (const source of RAND_SOURCES) {
    setRandStream(source, decodeRandStream(readFileSync(join(root, 'public', RAND_SOURCE_FILES[source]))))
  }
}
