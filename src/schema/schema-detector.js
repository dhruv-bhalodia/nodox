/**
 * Schema Detector — Orchestrator
 *
 * Coordinates all schema detection layers and maintains the complete
 * per-route schema registry. Called by the main middleware.
 *
 * Layer priority (highest confidence first):
 *   Tier 1: validate() wrapper          → confidence: 'confirmed'
 *   Layer 3: Dry run from flagged fns   → confidence: 'inferred'
 *   Layer 4: Test suite cache           → confidence: 'observed' (loaded at startup)
 *   Layer 5: Live response shapes       → confidence: 'observed'
 *
 * The UI marks each route's schema with its confidence level so developers
 * know what to trust.
 */

import { looksLikeValidator } from './source-screener.js'
import { dryRunValidator, registerForDryRun, _schemaRegistryArray } from './dry-runner.js'
import { patchZod, patchJoi, capturedSchemas } from './schema-patcher.js'
import { toJsonSchema, detectSchemaLibrary, schemaRegistry, registerSchemaForRoute } from './validate.js'
import { createRequire } from 'module'
import { loadCacheEntries } from '../layer4/cache-reader.js'

const require = createRequire(import.meta.url)

/**
 * @typedef {Object} RouteSchema
 * @property {object|null} input - JSON Schema for request body (POST/PUT/PATCH)
 * @property {object|null} output - JSON Schema for response body (from Layer 5)
 * @property {object|null} querySchema - JSON Schema for query string parameters (observed from live traffic)
 * @property {'confirmed'|'inferred'|'observed'|'none'} inputConfidence
 * @property {'observed'|'none'} outputConfidence
 * @property {'observed'|'none'} querySchemaConfidence
 * @property {string|null} source - Where the schema was defined
 */

/**
 * Per-route schema storage.
 * Key format: "METHOD:path" e.g. "POST:/api/users"
 * @type {Map<string, RouteSchema>}
 */
const routeSchemas = new Map()

/**
 * WeakMap from parsed value objects → their JSON Schema.
 * Populated by patched .parse() / .safeParse() / .validate() methods.
 * Checked by the response interceptor when res.json() fires.
 * Only object/array values can be WeakMap keys — primitives are skipped.
 *
 * @type {WeakMap<object, object>}
 */
export const parsedValueToSchema = new WeakMap()

/** Cache JSON Schema conversion per schema instance to avoid re-computing on every parse call. */
const schemaJsonSchemaCache = new WeakMap()

/** Confidence order — never downgrade. Shared for both input and output. */
const CONFIDENCE_ORDER = { confirmed: 3, inferred: 2, observed: 1, none: 0 }

/**
 * Raw cache entries from .apicache.json, kept after loadCacheIntoRegistry so that
 * enrichRoutesWithSchemas can do URL→template matching for parameterized routes.
 * e.g. cache entry "GET:/api/users/123" matches route template "GET:/api/users/:id".
 * @type {Record<string, object>|null}
 */
let _rawCacheEntries = null

/**
 * Check if a concrete URL path matches an Express route template.
 * Handles :param segments (wildcards) and strips query strings from the URL.
 * @param {string} urlPath  - actual URL e.g. "/api/users/123"
 * @param {string} template - Express template e.g. "/api/users/:id"
 * @returns {boolean}
 */
function urlMatchesTemplate(urlPath, templatePath) {
  if (!urlPath || !templatePath) return false
  if (templatePath === '*' || templatePath === '/*') return false

  const url = urlPath.split('?')[0]  // strip query string
  const urlSegs = url.split('/').filter(Boolean)
  const tplSegs = templatePath.split('/').filter(Boolean)

  if (urlSegs.length !== tplSegs.length) return false

  for (let i = 0; i < tplSegs.length; i++) {
    const seg = tplSegs[i]
    if (seg.startsWith(':')) continue              // named param — matches any segment
    if (seg.startsWith('(') && seg.endsWith(')')) continue  // Express regex group
    if (seg !== urlSegs[i]) return false
  }
  return true
}

/**
 * Scan raw cache entries to find one whose URL matches the given route template.
 * Used in enrichRoutesWithSchemas to fill schemas for parameterized routes.
 */
function _findMatchingCacheEntry(method, templatePath) {
  if (!_rawCacheEntries) return null
  const upper = method.toUpperCase()
  for (const [key, entry] of Object.entries(_rawCacheEntries)) {
    const colon = key.indexOf(':')
    if (colon === -1) continue
    if (key.slice(0, colon).toUpperCase() !== upper) continue
    if (urlMatchesTemplate(key.slice(colon + 1), templatePath)) return entry
  }
  return null
}

// ── express-validator detection ───────────────────────────────────────────────

/**
 * Detect whether a handler is an express-validator ValidationChain.
 * Works with both v6 (._context) and v7 (.builder).
 * @param {any} fn
 * @returns {boolean}
 */
function _isExpressValidatorChain(fn) {
  if (!fn || typeof fn !== 'function') return false
  if (fn.builder?.fields && Array.isArray(fn.builder.fields)) return true
  if (fn._context?.fields && Array.isArray(fn._context.fields)) return true
  return false
}

/**
 * Infer a JSON Schema type from an express-validator chain's validator stack.
 * @param {any[]} validators
 * @returns {object} JSON Schema fragment
 */
function _inferEVFieldType(validators) {
  for (const v of validators) {
    const name = typeof v?.validator === 'function' ? v.validator.name
                : typeof v === 'function'            ? v.name
                : ''
    switch (name) {
      case 'isEmail':    return { type: 'string', format: 'email' }
      case 'isURL':      return { type: 'string', format: 'uri' }
      case 'isISO8601':
      case 'isDate':     return { type: 'string', format: 'date-time' }
      case 'isUUID':     return { type: 'string', format: 'uuid' }
      case 'isInt':
      case 'isNumeric':  return { type: 'integer' }
      case 'isFloat':
      case 'isDecimal':  return { type: 'number' }
      case 'isBoolean':  return { type: 'boolean' }
      case 'isArray':    return { type: 'array' }
      case 'isObject':
      case 'isJSON':     return { type: 'object' }
    }
  }
  return { type: 'string' }
}

/**
 * Extract a JSON Schema from express-validator chains found in a handler list.
 * Returns null if no express-validator chains are present.
 * @param {any[]} handlers
 * @returns {object|null}
 */
function _extractExpressValidatorSchema(handlers) {
  const properties = {}

  for (const fn of handlers) {
    if (!_isExpressValidatorChain(fn)) continue

    // v7 uses .builder; v6 uses ._context
    const ctx = fn.builder ?? fn._context
    const fields     = ctx?.fields     ?? []
    const validators = ctx?.stack      ??  // v7
                       ctx?.validators ??  // v6 alternate
                       []

    for (const field of fields) {
      if (typeof field !== 'string' || !field) continue
      properties[field] = _inferEVFieldType(validators)
    }
  }

  return Object.keys(properties).length > 0
    ? { type: 'object', properties }
    : null
}

function routeKey(method, path) {
  return `${method.toUpperCase()}:${path}`
}

function getOrCreateSchema(method, path) {
  const key = routeKey(method, path)
  if (!routeSchemas.has(key)) {
    routeSchemas.set(key, {
      input: null,
      output: null,
      querySchema: null,
      inputConfidence: 'none',
      outputConfidence: 'none',
      querySchemaConfidence: 'none',
      source: null,
    })
  }
  return routeSchemas.get(key)
}

/**
 * Load .apicache.json into the route schema registry (Layer 4).
 * Called once at startup, before routes are registered.
 * Cache entries have 'observed' confidence — lower than confirmed/inferred,
 * but they populate the UI immediately without waiting for test traffic.
 *
 * Priority rule: cache entries NEVER overwrite confirmed or inferred schemas.
 * They only fill slots where inputConfidence === 'none'.
 *
 * @param {string|null} [cacheFile] - override for testing
 */
export function loadCacheIntoRegistry(cacheFile) {
  const entries = loadCacheEntries(cacheFile)
  const keys = Object.keys(entries)
  if (keys.length === 0) return 0

  // Keep the raw entries so enrichRoutesWithSchemas can do template matching later
  // (e.g. "GET:/api/users/123" in cache → "GET:/api/users/:id" route template)
  _rawCacheEntries = entries

  for (const [key, entry] of Object.entries(entries)) {
    // Parse key back to method + path
    const colonIdx = key.indexOf(':')
    if (colonIdx === -1) continue
    const method = key.slice(0, colonIdx)
    const path = key.slice(colonIdx + 1)

    const existing = routeSchemas.get(key)

    // Never downgrade a confirmed or inferred input schema
    const canSetInput = !existing ||
      (existing.inputConfidence === 'none' && entry.input)

    // Output is always safe to set from cache (observed is the only level for output)
    const canSetOutput = !existing ||
      (!existing.output && entry.output)

    if (!canSetInput && !canSetOutput) continue

    const schema = getOrCreateSchema(method, path)

    if (canSetInput && entry.input) {
      schema.input = entry.input
      schema.inputConfidence = 'observed'
    }

    if (canSetOutput && entry.output) {
      schema.output = entry.output
      schema.outputConfidence = 'observed'
    }

    if (entry.seenCount) schema.seenCount = entry.seenCount
    if (entry.lastSeen) schema.lastSeen = entry.lastSeen
  }

  return keys.length
}

let _detectorInitialized = false

/**
 * Initialize the schema detector.
 * Patches Zod and Joi if they're available.
 * Idempotent — safe to call multiple times.
 */
export function initSchemaDetector() {
  if (_detectorInitialized) return
  _detectorInitialized = true

  // Patch schema libraries at startup
  try {
    const zod = require('zod')
    const z = zod?.z || zod?.default?.z || (zod?.object ? zod : zod?.default)
    if (z) {
      patchZodWithRegistry(z)
    }
  } catch { /* zod not installed */ }

  try {
    const joi = require('joi')
    const j = joi?.object ? joi : joi?.default
    if (j) {
      patchJoiWithRegistry(j)
    }
  } catch { /* joi not installed */ }

  try {
    const yup = require('yup')
    const y = yup?.object ? yup : yup?.default
    if (y) {
      patchYupWithRegistry(y)
    }
  } catch { /* yup not installed */ }
}

// Patch at module load time so schemas created after `import nodox from 'nodox-cli'`
// (including module-level const schema = z.object({...})) are registered
// before the dry-run fires.
initSchemaDetector()

/**
 * Tag a parsed value in parsedValueToSchema so the response interceptor can
 * identify when res.json(body) was called with a schema-validated value.
 * Computes and caches the JSON Schema for the schema instance on first call.
 * 
 * Note: Only object/array values can be tagged because WeakMap requires
 * object keys. Primitive responses (strings, numbers) will still be documented
 * via Layer 5 (structural inference) but will have 'observed' confidence.
 *
 * @param {any} value - The validated/parsed output
 * @param {object} schema - The schema instance that produced it
 * @param {'zod'|'joi'|'yup'} library
 */
function tagParsedValue(value, schema, library) {
  if (value === null || value === undefined || typeof value !== 'object') return
  try {
    let jsonSchema = schemaJsonSchemaCache.get(schema)
    if (!jsonSchema) {
      jsonSchema = toJsonSchema(schema, library)
      if (jsonSchema) schemaJsonSchemaCache.set(schema, jsonSchema)
    }
    if (jsonSchema) parsedValueToSchema.set(value, jsonSchema)
  } catch {}
}

/**
 * Patch a single Zod schema instance's parse/safeParse/parseAsync/safeParseAsync
 * to tag their output values in parsedValueToSchema.
 *
 * In Zod v4, these methods are OWN PROPERTIES on each instance (not prototype methods),
 * so we patch per-instance. In Zod v3, they live on ZodType.prototype — we handle that
 * via patchZodProtoForOutputTracking().
 */
function patchZodInstanceForOutputTracking(schema) {
  const handlers = {
    parse(orig) {
      return function nodoxTrackedParse(...args) {
        const result = orig.apply(this, args)
        tagParsedValue(result, this, 'zod')
        return result
      }
    },
    safeParse(orig) {
      return function nodoxTrackedSafeParse(...args) {
        const result = orig.apply(this, args)
        if (result?.success) tagParsedValue(result.data, this, 'zod')
        return result
      }
    },
    parseAsync(orig) {
      return async function nodoxTrackedParseAsync(...args) {
        const result = await orig.apply(this, args)
        tagParsedValue(result, this, 'zod')
        return result
      }
    },
    safeParseAsync(orig) {
      return async function nodoxTrackedSafeParseAsync(...args) {
        const result = await orig.apply(this, args)
        if (result?.success) tagParsedValue(result.data, this, 'zod')
        return result
      }
    },
  }

  for (const [method, wrap] of Object.entries(handlers)) {
    if (typeof schema[method] !== 'function') continue
    if (schema[method].__nodoxTracked) continue  // already patched
    const orig = schema[method]
    const patched = wrap(orig)
    patched.__nodoxTracked = true
    // Zod v4: parse methods are OWN writable properties on the instance
    // Direct assignment may fail on module namespace objects — use defineProperty fallback
    try {
      schema[method] = patched
    } catch {
      try { Object.defineProperty(schema, method, { value: patched, writable: true, configurable: false }) } catch {}
    }
  }
}

/**
 * Attempt to patch ZodType.prototype for Zod v3.
 * In Zod v3, parse/safeParse live on the prototype so one patch covers all schemas
 * including chained ones (.optional(), .transform(), etc.).
 * In Zod v4, ZodType.prototype is empty — per-instance patching (above) is used instead.
 * Idempotent.
 */
function patchZodProtoForOutputTracking(z) {
  // Walk up from a sample instance to find the deepest ancestor before
  // Object.prototype that still has parse(). That's ZodType.prototype in Zod v3.
  // In Zod v4, parse is an own property — no ancestor proto will have it.
  let baseProto
  try {
    let proto = Object.getPrototypeOf(z.string())
    while (proto && proto !== Object.prototype) {
      const parent = Object.getPrototypeOf(proto)
      if (!parent || parent === Object.prototype || typeof parent.parse !== 'function') {
        baseProto = proto
        break
      }
      proto = parent
    }
  } catch { return }

  // Only proceed if this prototype actually has parse (Zod v3)
  if (!baseProto || typeof baseProto.parse !== 'function' || baseProto.__nodoxZodProtoPatched) return
  baseProto.__nodoxZodProtoPatched = true

  const handlers = {
    parse: (orig) => function nodoxTrackedParse(...args) {
      const result = orig.apply(this, args)
      tagParsedValue(result, this, 'zod')
      return result
    },
    safeParse: (orig) => function nodoxTrackedSafeParse(...args) {
      const result = orig.apply(this, args)
      if (result?.success) tagParsedValue(result.data, this, 'zod')
      return result
    },
    parseAsync: (orig) => async function nodoxTrackedParseAsync(...args) {
      const result = await orig.apply(this, args)
      tagParsedValue(result, this, 'zod')
      return result
    },
    safeParseAsync: (orig) => async function nodoxTrackedSafeParseAsync(...args) {
      const result = await orig.apply(this, args)
      if (result?.success) tagParsedValue(result.data, this, 'zod')
      return result
    },
  }

  for (const [method, wrap] of Object.entries(handlers)) {
    if (typeof baseProto[method] !== 'function') continue
    baseProto[method] = wrap(baseProto[method])
  }
}

/**
 * Patch Joi prototype once for output tracking (covers all Joi schema types).
 */
function patchJoiProtoForOutputTracking(joi) {
  let baseProto
  try {
    let proto = Object.getPrototypeOf(joi.any())
    while (proto && proto !== Object.prototype) {
      const parent = Object.getPrototypeOf(proto)
      if (!parent || parent === Object.prototype || typeof parent.validate !== 'function') {
        baseProto = proto
        break
      }
      proto = parent
    }
  } catch { return }

  if (!baseProto || baseProto.__nodoxJoiProtoPatched) return
  baseProto.__nodoxJoiProtoPatched = true

  if (typeof baseProto.validate === 'function') {
    const orig = baseProto.validate
    baseProto.validate = function nodoxTrackedJoiValidate(...args) {
      const result = orig.apply(this, args)
      if (!result?.error) tagParsedValue(result?.value, this, 'joi')
      return result
    }
  }
}

/**
 * Patch yup prototype once for output tracking.
 */
function patchYupProtoForOutputTracking(yup) {
  let baseProto
  try {
    let proto = Object.getPrototypeOf(yup.mixed ? yup.mixed() : yup.string())
    while (proto && proto !== Object.prototype) {
      const parent = Object.getPrototypeOf(proto)
      if (!parent || parent === Object.prototype ||
          (typeof parent.validateSync !== 'function' && typeof parent.validate !== 'function')) {
        baseProto = proto
        break
      }
      proto = parent
    }
  } catch { return }

  if (!baseProto || baseProto.__nodoxYupProtoPatched) return
  baseProto.__nodoxYupProtoPatched = true

  if (typeof baseProto.validateSync === 'function') {
    const orig = baseProto.validateSync
    baseProto.validateSync = function nodoxTrackedYupValidateSync(...args) {
      const result = orig.apply(this, args)
      tagParsedValue(result, this, 'yup')
      return result
    }
  }

  if (typeof baseProto.validate === 'function') {
    const orig = baseProto.validate
    baseProto.validate = async function nodoxTrackedYupValidate(...args) {
      const result = await orig.apply(this, args)
      tagParsedValue(result, this, 'yup')
      return result
    }
  }
}

/**
 * Patch Zod factory methods for dry-run registration and output tracking.
 *
 * Strategy (handles both Zod v3 and v4):
 *   - Try to patch factory methods (z.object, z.string, …) so every created
 *     schema is registered for dry-run AND has its parse methods patched.
 *     Factory method assignment may fail on module namespace objects (Zod v4 ESM);
 *     Object.defineProperty is used as a fallback.
 *   - Also try prototype-level patching (Zod v3 only, where parse is on ZodType.prototype).
 *
 * Idempotent per-z instance (guarded by a WeakSet).
 */
const _patchedZInstances = new WeakSet()

export function patchZodWithRegistry(z) {
  if (!z || _patchedZInstances.has(z)) return
  _patchedZInstances.add(z)

  const methodsToWrap = ['object', 'string', 'number', 'boolean', 'array',
    'union', 'intersection', 'tuple', 'record', 'literal', 'enum',
    'nativeEnum', 'any', 'unknown', 'date', 'bigint', 'discriminatedUnion']

  for (const method of methodsToWrap) {
    if (typeof z[method] !== 'function') continue
    const original = z[method].bind(z)
    const wrapped = function nodoxPatchedZodFactory(...args) {
      const schema = original(...args)
      if (schema && typeof schema === 'object') {
        const meta = { type: 'zod', zodType: method }
        capturedSchemas.set(schema, meta)
        registerForDryRun(schema, meta)
        patchZodInstanceForOutputTracking(schema)
      }
      return schema
    }

    // Direct assignment works for mutable z objects; fall back to defineProperty
    // for Zod v4 ESM namespace objects (writable but not directly assignable)
    try {
      z[method] = wrapped
    } catch {
      try { Object.defineProperty(z, method, { value: wrapped, writable: true }) } catch {}
    }
  }

  // Prototype-level patch for Zod v3 (covers chained schemas on ZodType.prototype)
  patchZodProtoForOutputTracking(z)
}

/**
 * Patch Joi factory methods for dry-run registration, then patch the prototype
 * for output tracking.
 */
function patchJoiWithRegistry(joi) {
  const methodsToWrap = ['object', 'string', 'number', 'boolean', 'array',
    'any', 'date', 'alternatives', 'binary']

  for (const method of methodsToWrap) {
    if (typeof joi[method] !== 'function') continue
    const original = joi[method].bind(joi)
    joi[method] = function(...args) {
      const schema = original(...args)
      if (schema && typeof schema === 'object') {
        const meta = { type: 'joi', joiType: method }
        capturedSchemas.set(schema, meta)
        registerForDryRun(schema, meta)
      }
      return schema
    }
  }

  patchJoiProtoForOutputTracking(joi)
}

/**
 * Patch yup factory methods for dry-run registration, then patch the prototype
 * for output tracking.
 */
function patchYupWithRegistry(yup) {
  const methodsToWrap = ['object', 'string', 'number', 'boolean', 'array', 'mixed', 'date']

  for (const method of methodsToWrap) {
    if (typeof yup[method] !== 'function') continue
    const original = yup[method].bind(yup)
    yup[method] = function(...args) {
      const schema = original(...args)
      if (schema && typeof schema === 'object') {
        const meta = { type: 'yup', yupType: method }
        capturedSchemas.set(schema, meta)
        registerForDryRun(schema, meta)
      }
      return schema
    }
  }

  patchYupProtoForOutputTracking(yup)
}

/**
 * Set of "METHOD:path" strings that went through onRouteRegistered via the patcher.
 * Routes NOT in this set were registered before patchApp ran and need retroactive
 * schema detection when doExtraction() runs at startup.
 */
const _registeredRoutePaths = new Set()

/**
 * Returns true if this route was registered through patchApp's onRouteRegistered
 * callback (i.e., was defined after nodox(app) was called).
 * @param {string} method
 * @param {string} path
 * @returns {boolean}
 */
export function wasRouteRegistered(method, path) {
  return _registeredRoutePaths.has(routeKey(method, path))
}

/**
 * Called when query parameters are observed from a live request.
 * Stores as 'observed' confidence — only fills routes with no existing querySchema.
 *
 * @param {string} method
 * @param {string} path
 * @param {object} shape - Inferred JSON Schema shape of req.query
 * @param {Function} [onUpdate]
 */
export function onQueryObserved(method, path, shape, onUpdate) {
  const entry = getOrCreateSchema(method, path)
  if (entry.querySchemaConfidence !== 'none') return  // already have query schema
  entry.querySchema = shape
  entry.querySchemaConfidence = 'observed'
  if (typeof onUpdate === 'function') onUpdate()
}

/**
 * Called by app-patcher when a route is registered.
 * Checks for validate() wrapper (Tier 1) and flags fallback validators (Layer 2).
 *
 * @param {string} method
 * @param {string} path
 * @param {Function[]} handlers
 */
export function onRouteRegistered(method, path, handlers) {
  _registeredRoutePaths.add(routeKey(method, path))
  // Tier 1: Check if any handler is a nodox validate() middleware
  for (const handler of handlers) {
    if (handler?.__isNodoxValidate && handler?.__nodoxSchema) {
      const entry = getOrCreateSchema(method, path)
      entry.input = handler.__nodoxSchema.jsonSchema
      entry.inputConfidence = 'confirmed'
      entry.source = handler.__nodoxSchema.source

      // Register confirmed output schema if provided via validate(schema, { response })
      if (handler.__nodoxSchema.outputJsonSchema) {
        entry.output = handler.__nodoxSchema.outputJsonSchema
        entry.outputConfidence = 'confirmed'
      }

      registerSchemaForRoute(method, path, handler.__nodoxSchema)
      return // confirmed — no need for fallback layers
    }
  }

  // Tier 1.5: express-validator chains — read directly from chain metadata.
  // Works without dry-running; gives 'inferred' confidence (same level as dry-run).
  // Never overwrites a confirmed or already-inferred schema.
  const evSchema = _extractExpressValidatorSchema(handlers)
  if (evSchema) {
    const entry = getOrCreateSchema(method, path)
    if (CONFIDENCE_ORDER[entry.inputConfidence] < CONFIDENCE_ORDER.inferred) {
      entry.input = evSchema
      entry.inputConfidence = 'inferred'
    }
  }

  // Layer 2 / 3: Flag validators for dry-run (Zod / Joi / yup)
  const flagged = handlers.filter(fn => typeof fn === 'function' && looksLikeValidator(fn))
  if (flagged.length > 0) {
    if (_dryRunStartupComplete) {
      // Startup is done — run immediately so dynamic routes don't wait forever.
      // _dryRunRoute is async; fire-and-forget here since onRouteRegistered is sync.
      // scheduleExtraction() has a 50ms debounce — the dry-run will complete within
      // that window and the next extraction will see the updated schema.
      _dryRunRoute(method, path, flagged).catch(() => {})
    } else {
      pendingDryRuns.push({ method, path, handlers: flagged })
    }
  }
}

/** Accumulates routes flagged for dry-run during registration phase */
const pendingDryRuns = []

/**
 * Whether the initial deferred dry-run batch has completed.
 * After this point, new routes are dry-run immediately rather than queued.
 */
let _dryRunStartupComplete = false

/**
 * Reconstruct an approximate JSON Schema from a ZodError thrown by schema.parse().
 *
 * Works for handlers that call schema.parse() without a try/catch — the error
 * propagates to the dry-runner's catch block. Only required fields are visible
 * (optional fields produce no error on an empty body). Marks the result with a
 * description so the UI can indicate the schema is approximate.
 *
 * @param {object} error - ZodError with .issues array
 * @returns {object|null} JSON Schema fragment, or null if nothing useful
 */
function _reconstructSchemaFromZodError(error) {
  if (!Array.isArray(error?.issues) || error.issues.length === 0) return null

  const properties = {}
  const required = []

  for (const issue of error.issues) {
    // Only handle top-level field errors (path.length === 1)
    if (!issue.path || issue.path.length !== 1) continue
    const field = String(issue.path[0])
    if (!field) continue

    if (issue.code === 'invalid_type') {
      const typeMap = {
        string: 'string', number: 'number', integer: 'integer',
        boolean: 'boolean', object: 'object', array: 'array',
        date: 'string', bigint: 'integer', null: 'null',
        undefined: 'null',
      }
      const jsType = typeMap[issue.expected] ?? 'string'
      properties[field] = issue.expected === 'date'
        ? { type: 'string', format: 'date-time' }
        : { type: jsType }

      if (issue.received === 'undefined') required.push(field)
    }
  }

  if (Object.keys(properties).length === 0) return null

  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = [...new Set(required)]
  // Mark as approximate — optional fields and nested shapes are not visible from errors
  schema.description = '(inferred from validation errors — optional fields may be absent)'
  return schema
}

/**
 * Run a dry-run attempt for a single route and update the registry if a schema
 * is detected. Used both by the deferred batch and inline post-startup.
 *
 * Async because dryRunValidator is now async (awaits one event-loop tick to catch
 * validation that happens after shallow Promise.resolve() chains).
 *
 * @param {string} method
 * @param {string} path
 * @param {Function[]} handlers
 * @returns {Promise<boolean>} true if a schema was detected
 */
async function _dryRunRoute(method, path, handlers) {
  const existing = routeSchemas.get(routeKey(method, path))
  if (existing?.inputConfidence === 'confirmed') return false

  for (const handler of handlers) {
    const result = await dryRunValidator(handler, method)

    if (result.schema) {
      const meta = capturedSchemas.get(result.schema)
      // meta may be null for Zod v4 schemas created before the ESM z instance was patched
      // (module-level schemas in the user's app). result.library is still set from the
      // dry-run detection. We can convert directly using the schema instance + library.
      const library = result.library || meta?.type
      if (!library) continue

      const jsonSchema = toJsonSchema(result.schema, library)
      if (!jsonSchema) continue

      const entry = getOrCreateSchema(method, path)
      entry.input = jsonSchema
      entry.inputConfidence = 'inferred'
      return true // First successful dry-run wins for this route
    }

    // Fallback: if the handler called schema.parse() without a try/catch,
    // the ZodError propagated to the dry-runner. Reconstruct an approximate
    // schema from the validation issues (covers Zod v4 module-level ESM schemas
    // that weren't registered — we at least get the required field names + types).
    if (result.zodError && !existing?.input) {
      const jsonSchema = _reconstructSchemaFromZodError(result.zodError)
      if (jsonSchema) {
        const entry = getOrCreateSchema(method, path)
        entry.input = jsonSchema
        entry.inputConfidence = 'inferred'
        return true
      }
    }
  }
  return false
}

/**
 * Run Layer 3 (dry run) for all flagged routes.
 * Called once, deferred to after all routes are registered.
 * Async because _dryRunRoute awaits one event-loop tick per handler.
 */
export async function runDeferredDryRuns() {
  for (const { method, path, handlers } of pendingDryRuns) {
    const success = await _dryRunRoute(method, path, handlers)
    if (success) {
      console.log(`\x1b[32m  ✓ nodox\x1b[0m \x1b[2mInferred schema for ${method} ${path}\x1b[0m`)
    } else {
      // console.log(`\x1b[33m  ! nodox\x1b[0m \x1b[2mCould not infer schema for ${method} ${path}\x1b[0m`)
    }
  }

  pendingDryRuns.length = 0
  _dryRunStartupComplete = true
}

/**
 * Called when a real request body shape is observed for a route.
 * Only fills in slots where no better (higher-confidence) input schema exists.
 * Covers routes where the user does no explicit validation — observed from live traffic.
 *
 * @param {string} method
 * @param {string} path
 * @param {object} shape - Inferred JSON Schema shape of req.body
 * @param {'observed'} [confidence='observed']
 * @param {Function} [onUpdate]
 */
export function onInputObserved(method, path, shape, confidence = 'observed', onUpdate) {
  const entry = getOrCreateSchema(method, path)

  const existing = CONFIDENCE_ORDER[entry.inputConfidence] ?? 0
  const incoming = CONFIDENCE_ORDER[confidence] ?? 0
  if (incoming <= existing) return

  entry.input = shape
  entry.inputConfidence = confidence

  if (typeof onUpdate === 'function') {
    onUpdate(method, path, { input: shape, inputConfidence: confidence })
  }
}

/**
 * Called by response interceptor when a response shape is observed.
 * Never downgrades an existing higher-confidence output schema.
 *
 * @param {string} method
 * @param {string} path
 * @param {object} shape - JSON Schema for the response body
 * @param {'observed'|'inferred'} [confidence='observed']
 * @param {Function} [onUpdate] - Callback when schema is updated (for WebSocket broadcast)
 */
export function onResponseObserved(method, path, shape, confidence = 'observed', onUpdate) {
  const entry = getOrCreateSchema(method, path)

  // Never overwrite a higher-confidence output schema
  const existing = CONFIDENCE_ORDER[entry.outputConfidence] ?? 0
  const incoming = CONFIDENCE_ORDER[confidence] ?? 0
  if (incoming <= existing) return

  entry.output = shape
  entry.outputConfidence = confidence

  if (typeof onUpdate === 'function') {
    onUpdate(method, path, { output: shape, outputConfidence: confidence })
  }
}

/**
 * Get schema info for a specific route.
 * @param {string} method
 * @param {string} path
 * @returns {RouteSchema|null}
 */
export function getRouteSchema(method, path) {
  return routeSchemas.get(routeKey(method, path)) ?? null
}

/**
 * Get all route schemas as a plain object (for WebSocket sync).
 * @returns {object}
 */
export function getAllSchemas() {
  const result = {}
  for (const [key, schema] of routeSchemas) {
    result[key] = schema
  }
  return result
}

/**
 * Enrich an array of extracted routes with schema information.
 * @param {import('../extractor/route-extractor.js').ExtractedRoute[]} routes
 * @returns {import('../extractor/route-extractor.js').ExtractedRoute[]}
 */
export function enrichRoutesWithSchemas(routes) {
  return routes.map(route => {
    let schema = getRouteSchema(route.method, route.path)

    // Fallback: if no exact-key schema was found, scan raw cache entries using
    // URL→template matching.  This handles parameterised routes where the cache
    // stores concrete URLs (e.g. "GET:/api/users/123") but the route template is
    // "GET:/api/users/:id".  Without this the entire Layer 4 cache is useless for
    // any route that has path parameters.
    if (!schema && _rawCacheEntries) {
      const cacheEntry = _findMatchingCacheEntry(route.method, route.path)
      if (cacheEntry) {
        const s = getOrCreateSchema(route.method, route.path)
        if (cacheEntry.input && s.inputConfidence === 'none') {
          s.input  = cacheEntry.input
          s.inputConfidence = 'observed'
        }
        if (cacheEntry.output && !s.output) {
          s.output = cacheEntry.output
          s.outputConfidence = 'observed'
        }
        if (cacheEntry.seenCount) s.seenCount = cacheEntry.seenCount
        schema = s
      }
    }

    return {
      ...route,
      hasValidator: schema?.inputConfidence === 'confirmed' || schema?.inputConfidence === 'inferred',
      schema: schema ?? null,
      // Exclude raw handler functions from the serialized route — they're only
      // needed for retroactive schema detection and must not be sent over WebSocket.
      handlers: undefined,
    }
  })
}

/**
 * Directly tag a parsed value in parsedValueToSchema.
 * Normally called internally by patched parse methods; exported for testing.
 *
 * @param {any} value - The validated/parsed output
 * @param {object} schema - The schema instance that produced it
 * @param {'zod'|'joi'|'yup'} library
 */
export { tagParsedValue }
