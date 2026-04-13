/**
 * Schema Patcher — Layer 1 of the 5-layer fallback strategy
 *
 * Patches zod and joi at the module level the moment nodox is imported.
 * Every schema created anywhere in the application — regardless of file —
 * gets silently recorded in a global registry with its shape and callsite.
 *
 * This runs BEFORE any app code, so schemas defined at module-load time
 * (the common case: const schema = z.object({...}) at the top of a file)
 * are captured.
 *
 * The registry maps: schema instance → { shape, type, source }
 * The route→schema link is established later in Layer 3 (dry run).
 */

import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// WeakMap so captured schemas don't prevent garbage collection
export const capturedSchemas = new WeakMap()

// Track whether we've already patched each library
let zodPatched = false
let joiPatched = false

/**
 * Patch Zod's z object to intercept schema creation.
 * @param {object} z - The zod module export
 * @returns {object} The patched z
 */
export function patchZod(z) {
  if (zodPatched || !z) return z
  zodPatched = true

  const methodsToWrap = ['object', 'string', 'number', 'boolean', 'array',
    'union', 'intersection', 'tuple', 'record', 'map', 'set', 'literal',
    'enum', 'nativeEnum', 'optional', 'nullable', 'any', 'unknown', 'never',
    'void', 'date', 'bigint', 'symbol', 'undefined', 'null', 'nan',
    'promise', 'function', 'lazy', 'discriminatedUnion', 'effects']

  for (const method of methodsToWrap) {
    if (typeof z[method] !== 'function') continue

    const original = z[method].bind(z)
    z[method] = function patchedZodMethod(...args) {
      const schema = original(...args)
      if (schema && typeof schema === 'object') {
        capturedSchemas.set(schema, {
          type: 'zod',
          zodType: method,
          shape: method === 'object' ? args[0] : null,
          source: captureCallsite(),
        })
      }
      return schema
    }
    // Preserve the original name for stack trace readability
    Object.defineProperty(z[method], 'name', { value: `patched_${method}` })
  }

  return z
}

/**
 * Patch Joi to intercept schema creation.
 * @param {object} joi - The joi module export
 * @returns {object} The patched joi
 */
export function patchJoi(joi) {
  if (joiPatched || !joi) return joi
  joiPatched = true

  const methodsToWrap = ['object', 'string', 'number', 'boolean', 'array',
    'any', 'alternatives', 'binary', 'date', 'func', 'link', 'symbol']

  for (const method of methodsToWrap) {
    if (typeof joi[method] !== 'function') continue

    const original = joi[method].bind(joi)
    joi[method] = function patchedJoiMethod(...args) {
      const schema = original(...args)
      if (schema && typeof schema === 'object') {
        capturedSchemas.set(schema, {
          type: 'joi',
          joiType: method,
          source: captureCallsite(),
        })
      }
      return schema
    }
  }

  return joi
}

/**
 * Attempt to patch zod and joi if they're installed in the user's project.
 * Silently skips if a library isn't installed.
 */
export function patchAvailableSchemaLibraries() {
  // Try zod
  try {
    const zod = require('zod')
    if (zod?.z) patchZod(zod.z)
    else if (zod?.default?.z) patchZod(zod.default.z)
    else if (zod?.object) patchZod(zod)
    else if (zod?.default?.object) patchZod(zod.default)
  } catch {
    // zod not installed — fine
  }

  // Try joi
  try {
    const joi = require('joi')
    if (joi?.object) patchJoi(joi)
    else if (joi?.default?.object) patchJoi(joi.default)
  } catch {
    // joi not installed — fine
  }
}

/**
 * Capture the current call stack location.
 * Used to show developers where a schema was defined.
 * Returns a short string like "src/routes/users.js:12"
 */
function captureCallsite() {
  try {
    const err = new Error()
    const lines = err.stack?.split('\n') || []
    // Skip: Error, captureCallsite, patchedMethod, (internal nodox frames)
    // Find first frame that isn't nodox itself
    for (const line of lines.slice(3)) {
      const match = line.match(/\((.+?):(\d+):\d+\)/) ||
                    line.match(/at (.+?):(\d+):\d+/)
      if (!match) continue
      const file = match[1]
      if (file.includes('nodox-cli/src') || file.includes('node_modules/nodox-cli')) continue
      if (file.includes('node:internal')) continue
      // Return project-relative path — avoids leaking server filesystem layout
      const cwd = process.cwd()
      const relative = file.startsWith(cwd)
        ? file.slice(cwd.length).replace(/^[\\/]/, '')
        : file.split(/[\\/]node_modules[\\/]/).pop() ?? file
      return `${relative}:${match[2]}`
    }
    return null
  } catch {
    return null
  }
}

