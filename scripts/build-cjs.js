/**
 * build-cjs.js
 *
 * Produces CommonJS builds of the nodox middleware and jest-setup so that
 * projects using "type": "commonjs" (or no "type" field) can require() nodox.
 *
 * Output:
 *   dist/index.cjs        — main middleware entry (require('nodox'))
 *   dist/jest-setup.cjs   — jest setup file (require('nodox/jest-setup'))
 *
 * Strategy:
 *   - Use esbuild to bundle each entry with --format=cjs --platform=node
 *   - All runtime deps (express, ws, zod, joi, zod-to-json-schema) are
 *     externalized so they're not inlined into the bundle
 *   - import.meta.url is replaced with the standard Node.js CJS equivalent
 *     automatically by esbuild when targeting node+cjs
 *
 * Run via: npm run build:cjs
 */

import { build } from 'esbuild'
import { mkdir } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const outDir = path.join(root, 'dist')

// All runtime dependencies that must not be bundled
const external = [
  'express',
  'ws',
  'zod',
  'joi',
  'zod-to-json-schema',
  'path',
  'fs',
  'fs/promises',
  'http',
  'https',
  'url',
  'module',
  'child_process',
  'os',
  'crypto',
]

async function main() {
  await mkdir(outDir, { recursive: true })

  // In CJS, import.meta is not available. We inject a tiny shim that provides
  // the same value (the file's URL) using Node's built-in url module.
  const importMetaShimBanner =
    `const __importMetaUrl = require('url').pathToFileURL(__filename).href;`

  const shared = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external,
    // Replace import.meta.url references with the shim variable
    define: { 'import.meta.url': '__importMetaUrl' },
    // Inject the shim variable definition at the top of each output file
    banner: { js: importMetaShimBanner },
  }

  await Promise.all([
    build({
      ...shared,
      entryPoints: [path.join(root, 'src/index.js')],
      outfile: path.join(outDir, 'index.cjs'),
    }),
    build({
      ...shared,
      entryPoints: [path.join(root, 'src/layer4/jest-setup.js')],
      outfile: path.join(outDir, 'jest-setup.cjs'),
    }),
  ])

  console.log('✓ CJS build complete → dist/index.cjs + dist/jest-setup.cjs')
}

main().catch(err => {
  console.error('CJS build failed:', err.message)
  process.exit(1)
})
