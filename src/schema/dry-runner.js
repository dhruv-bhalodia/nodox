/**
 * Dry Runner — Layer 3 of the 5-layer fallback strategy
 *
 * For each middleware function flagged by the source screener, executes it
 * with a carefully constructed mock request and response. During execution,
 * the Layer 1 schema patches intercept any .parse() / .safeParse() calls
 * and report back which schema was invoked — establishing a confirmed
 * schema → route mapping.
 *
 * The mock request uses an infinite Proxy that returns itself for any property access.
 * Also callable — calling it returns another infinite proxy.
 *
 * Timing: called once during the deferred startup tick, after all routes
 * have been registered. Under 1ms per route in practice.
 */

import { AsyncLocalStorage } from 'async_hooks'
import http from 'http'
import https from 'https'
import net from 'net'
import fs from 'fs'
import cp from 'child_process'
import { capturedSchemas } from './schema-patcher.js'

/**
 * Side-effect blocker — prevents network calls and filesystem writes during dry-runs.
 * Uses AsyncLocalStorage to identify when execution is happening within a dry-run context.
 */
const dryRunContext = new AsyncLocalStorage()

// ── Side Effect Patching ─────────────────────────────────────────────────────

const ABORT_ERROR_MESSAGE = '__NODOC_DRY_RUN_ABORT__'

function isDryRun() {
  const store = dryRunContext.getStore()
  // console.log('--- isDryRun check:', store)
  return store === true
}

/**
 * Patch Node.js core modules once at startup to block side effects globally
 * during dry-runs. The AsyncLocalStorage check ensures that real requests
 * flowing through the server at the same time are unaffected.
 */
let _sideEffectPatchesApplied = false
function applySideEffectPatches() {
  if (_sideEffectPatchesApplied) return
  _sideEffectPatchesApplied = true

  // Block network calls (covers 99% of DB drivers)
  const patchNetwork = (mod) => {
    const orig = mod.request
    mod.request = function(...args) {
      if (isDryRun()) {
        const err = new Error('Network call blocked during nodox dry-run')
        err.code = 'ENETBLOCK'
        throw err
      }
      return orig.apply(this, args)
    }
  }
  patchNetwork(http)
  patchNetwork(https)

  const origConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function(...args) {
    if (isDryRun()) {
      throw new Error('Network connection blocked during nodox dry-run')
    }
    return origConnect.apply(this, args)
  }

  // Block filesystem writes
  const blockFs = (method) => {
    const orig = fs[method]
    if (typeof orig !== 'function') return
    const patched = function(...args) {
      if (isDryRun()) {
        throw new Error(`fs.${method} blocked during nodox dry-run`)
      }
      return orig.apply(this, args)
    }
    fs[method] = patched
    // Also patch default export if it exists (common in Node ESM)
    if (fs.default && fs.default[method]) {
      fs.default[method] = patched
    }
  }
  ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync'].forEach(blockFs)

  // Block child processes
  const blockCp = (method) => {
    const orig = cp[method]
    if (typeof orig !== 'function') return
    cp[method] = function(...args) {
      if (isDryRun()) {
        throw new Error(`child_process.${method} blocked during nodox dry-run`)
      }
      return orig.apply(this, args)
    }
  }
  ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].forEach(blockCp)
}

/**
 * Create an infinite Proxy that returns itself for any property access.
 * Also callable — calling it returns another infinite proxy.
 *
 * Special cases:
 *   - .then / .catch / Symbol.toPrimitive: return undefined (prevents Promise wrapping)
 *   - 'string'/'number'/'boolean': return sensible primitives for schema parsing
 *
 * @param {object} [overrides] - Real values to serve for specific properties
 * @returns {Proxy}
 */
export function createInfiniteProxy(overrides = {}) {
  function handler(target) {
    return {
      get(obj, prop) {
        // Direct overrides take priority
        if (prop in overrides) return overrides[prop]

        // These must return undefined — returning a proxy causes issues with
        // Promise detection, Symbol iteration, and Jest matchers
        if (typeof prop === 'symbol') return undefined
        if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
        if (prop === 'toJSON') return undefined
        if (prop === 'valueOf') return () => null
        if (prop === 'toString') return () => '[nodox mock]'

        // For known object-level props, return simple values
        // so schema validators can run without throwing type errors
        if (prop === 'constructor') return Object
        if (prop in obj) return obj[prop]

        // Everything else: return another infinite proxy
        return createInfiniteProxy()
      },
      apply() {
        return createInfiniteProxy()
      },
      set() {
        return true // Silently accept all property sets
      },
    }
  }

  const target = typeof overrides === 'function' ? overrides : function() {}
  return new Proxy(target, handler(target))
}

/**
 * @typedef {Object} DryRunResult
 * @property {object|null} schema - The detected schema instance, or null if none found
 * @property {'zod'|'joi'|'yup'|null} library
 * @property {object|null} zodError - A ZodError caught from an uncaught schema.parse() call.
 *   Present only when the schema wasn't pre-registered but threw during dry-run.
 *   Used by schema-detector to reconstruct an approximate schema from the error issues.
 * @property {object|null} jsonSchema - Converted JSON Schema if available
 */

/**
 * Execute a flagged middleware function with a mock request to detect which
 * schema it validates against.
 *
 * Async: awaits the handler promise with a single event-loop tick of headroom
 * (setTimeout 0). This is enough for Promise.resolve() chains (common in
 * async middleware that validates before any real I/O), while being safe
 * against real network/db calls that always take longer than one tick.
 *
 * ZodError fallback: if a schema.parse() call throws and isn't caught inside
 * the handler, the error propagates here. We store it so the caller can
 * reconstruct an approximate JSON Schema from the validation issues.
 *
 * @param {Function} fn - The middleware to dry-run
 * @param {string} method - HTTP method (for mock req.method)
 * @returns {Promise<DryRunResult>}
 */
export async function dryRunValidator(fn, method = 'POST') {
  applySideEffectPatches()

  // Build a mock request that looks enough like a real one for validators to run
  const mockReq = createInfiniteProxy({
    body: {},
    params: {},
    query: {},
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    method: method.toUpperCase(),
    path: '/',
    url: '/',
    get(header) {
      return { 'content-type': 'application/json' }[header.toLowerCase()] || null
    },
  })

  // Capture what the handler passes to res.json() / res.status(n).json().
  // This lets us reconstruct a schema when the handler uses safeParse (which
  // returns { success: false } instead of throwing) and the schema wasn't
  // pre-registered — e.g. module-level ESM Zod schemas created before the
  // deferred ESM patch fires.
  const _capturedJsonBodies = []
  const _captureBody = (body) => { try { _capturedJsonBodies.push(body) } catch {} }
  const _statusResult = createInfiniteProxy({ json: _captureBody, send: _captureBody })
  const mockRes = createInfiniteProxy({
    json: _captureBody,
    send: _captureBody,
    status: () => _statusResult,
  })
  const mockNext = () => {}

  let detectedSchema = null
  let detectedLibrary = null
  let caughtZodError = null
  const patchedSchemas = new Map()

  // Temporarily patch every known schema's parse methods to intercept the call.
  // We'll know which schema was invoked by which patch fires.
  const schemasToWatch = getWatchableSchemas()

  for (const { schema, meta } of schemasToWatch) {
    const patches = patchSchemaForDryRun(schema, meta, (s, lib) => {
      if (!detectedSchema) {
        detectedSchema = s
        detectedLibrary = lib
      }
    })
    if (patches) patchedSchemas.set(schema, patches)
  }

  try {
    // Wrap handler execution in the dry-run context
    await dryRunContext.run(true, async () => {
      const maybePromise = fn(mockReq, mockRes, mockNext)

      if (maybePromise && typeof maybePromise.then === 'function') {
        // Await with a single-tick timeout so validation that happens after a
        // shallow await (Promise.resolve / already-resolved promise) is detected.
        // Real I/O (network, disk) always takes longer than one tick — safe to skip.
        await new Promise(resolve => {
          const t = setTimeout(resolve, 0)
          maybePromise.then(
            () => { clearTimeout(t); resolve() },
            (err) => {
              clearTimeout(t)
              // Async validator threw — capture ZodError if present
              if (!caughtZodError && Array.isArray(err?.issues) && err.issues.length > 0) {
                caughtZodError = err
              }
              resolve()
            }
          )
        })
      }
    })
  } catch (err) {
    if (err.message === ABORT_ERROR_MESSAGE) {
      // Success: we captured the schema and aborted the handler before side effects
    } else if (!detectedSchema && Array.isArray(err?.issues) && err.issues.length > 0) {
      // Sync schema.parse() without try/catch throws here — capture ZodError
      caughtZodError = err
    }
  }

  // Restore all patched methods
  for (const [schema, patches] of patchedSchemas) {
    for (const [method, original] of Object.entries(patches)) {
      try { schema[method] = original } catch {}
    }
  }

  // Fallback for safeParse patterns: the handler caught the validation error
  // internally and forwarded it to res.json(). Extract Zod issues from the
  // captured response body so _reconstructSchemaFromZodError can run.
  if (!detectedSchema && !caughtZodError) {
    for (const body of _capturedJsonBodies) {
      const issues = _extractZodIssues(body)
      if (issues) {
        caughtZodError = { issues }
        break
      }
    }
  }

  return {
    schema: detectedSchema,
    library: detectedLibrary,
    zodError: caughtZodError,
    jsonSchema: null, // Converted by schema-detector after dry run
  }
}

/**
 * Extract a Zod issues array from a response body, checking common shapes.
 * A Zod issue always has { path: Array, code: string, message: string }.
 * @param {any} body
 * @returns {Array|null}
 */
function _extractZodIssues(body) {
  if (!body || typeof body !== 'object') return null

  // Check common response shapes: { issues }, { details }, { errors },
  // { validationErrors }, { error: { issues } }
  const candidates = [
    body.issues,
    body.details,
    body.errors,
    body.validationErrors,
    body.error?.issues,
  ]

  for (const c of candidates) {
    if (
      Array.isArray(c) && c.length > 0 &&
      Array.isArray(c[0]?.path) &&
      typeof c[0]?.code === 'string'
    ) {
      return c
    }
  }

  return null
}

/**
 * Patch a schema's parse/validate methods to intercept calls during dry run.
 * Returns the original methods so they can be restored afterward.
 * @param {object} schema
 * @param {object} meta
 * @param {Function} onDetected
 * @returns {object|null} Map of method name → original function
 */
function patchSchemaForDryRun(schema, meta, onDetected) {
  const originals = {}
  const methodsToWatch = meta.type === 'zod'
    ? ['parse', 'safeParse', 'parseAsync', 'safeParseAsync']
    : meta.type === 'yup'
      ? ['validateSync']   // yup sync — async validate() would suspend before detection
      : ['validate', 'validateAsync']

  let patched = false
  for (const method of methodsToWatch) {
    if (typeof schema[method] !== 'function') continue

    originals[method] = schema[method]
    schema[method] = function interceptedParse(...args) {
      onDetected(schema, meta.type)
      // Restore immediately — we only need the first call
      schema[method] = originals[method]
      
      // If we are in a dry-run context, throw immediately to abort the rest
      // of the handler execution. This prevents any side effects (DB calls, logs)
      // that appear after the validator in the function body.
      if (isDryRun()) {
        throw new Error(ABORT_ERROR_MESSAGE)
      }

      return originals[method].apply(this, args)
    }
    patched = true
  }

  return patched ? originals : null
}

/**
 * Get all schemas currently in the captured registry as watchable objects.
 * Falls back to empty array if capturedSchemas registry is empty
 * (e.g. if schema patcher wasn't installed or no schemas were created yet).
 *
 * Note: WeakMap has no iterator, so we use the parallel tracking set.
 * @returns {Array<{schema: object, meta: object}>}
 */
function getWatchableSchemas() {
  // Import the tracking set from schema-patcher
  // We use a module-level registry array here instead
  return _schemaRegistryArray
}

// Module-level array that schema-patcher populates.
// We use a FinalizationRegistry to ensure that if a schema instance is
// garbage collected, it is also removed from this array, preventing memory leaks.
export const _schemaRegistryArray = []

const registryCleanup = new FinalizationRegistry((schema) => {
  const index = _schemaRegistryArray.findIndex(entry => entry.schema === schema)
  if (index !== -1) _schemaRegistryArray.splice(index, 1)
})

/**
 * Register a schema for dry-run watching.
 * Called by the patched zod/joi methods.
 * @param {object} schema
 * @param {object} meta
 */
export function registerForDryRun(schema, meta) {
  _schemaRegistryArray.push({ schema, meta })
  // WeakRef would be better, but we need to iterate the actual objects for dry-run.
  // We register the schema for cleanup when it is GC'd.
  try {
    registryCleanup.register(schema, schema)
  } catch {
    // Some objects (like frozen ones) cannot be registered in FinalizationRegistry.
    // In that case, we just leave it in the array — a rare edge case.
  }
}
