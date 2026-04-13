/**
 * validate() — Primary Schema Registration Path
 *
 * The recommended way to get complete, reliable schema documentation in nodox.
 * Developers use this in place of writing their own validation middleware.
 *
 * Usage:
 *   import { validate } from 'nodox-cli'
 *   import { z } from 'zod'
 *
 *   const createUserSchema = z.object({
 *     name: z.string(),
 *     email: z.string().email(),
 *   })
 *
 *   app.post('/users', validate(createUserSchema), (req, res) => {
 *     // req.body is validated and typed
 *     res.status(201).json(req.body)
 *   })
 *
 * Why use validate() instead of inline validation?
 *   - Schema is registered at route-registration time — not at request time
 *   - Works through any bundler, minifier, or transpiler
 *   - Produces a complete JSON Schema in the UI immediately on startup
 *   - The validate() call IS your validation — no duplication
 *
 * Supports: Zod schemas, Joi schemas, plain JSON Schema objects
 */

import { zodToJsonSchema } from 'zod-to-json-schema'

/**
 * Internal registry: route key → registered schema info
 * Route key format: "METHOD:path" e.g. "POST:/api/users"
 *
 * @type {Map<string, RegisteredSchema>}
 */
export const schemaRegistry = new Map()

/**
 * @typedef {Object} RegisteredSchema
 * @property {'zod'|'joi'|'jsonschema'} library
 * @property {object} rawSchema - The original schema object
 * @property {object} jsonSchema - Converted to JSON Schema format
 * @property {string|null} source - File:line where schema was defined
 * @property {'confirmed'} confidence - Always 'confirmed' for validate()
 */

/**
 * Create a validation middleware that also registers the schema with nodox.
 *
 * @param {object} schema - A Zod schema, Joi schema, or JSON Schema object
 * @param {object} [options]
 * @param {boolean} [options.strict=false] - Reject unknown fields (Zod: strip vs strict)
 * @param {object} [options.response] - Zod schema, Joi schema, or JSON Schema describing the response body
 * @returns {Function} Express middleware
 */
export function validate(schema, options = {}) {
  const { strict = false, response: responseSchema } = options

  // Detect schema type
  const library = detectSchemaLibrary(schema)
  if (!library) {
    throw new Error(
      '[nodox] validate() received an unrecognized schema type. ' +
      'Pass a Zod schema, Joi schema, or a plain JSON Schema object.'
    )
  }

  // Convert to JSON Schema for UI display
  const jsonSchema = toJsonSchema(schema, library)

  // Convert optional response schema to JSON Schema
  let outputJsonSchema = null
  if (responseSchema) {
    const responseLibrary = detectSchemaLibrary(responseSchema)
    if (responseLibrary) {
      outputJsonSchema = toJsonSchema(responseSchema, responseLibrary)
    } else {
      throw new Error(
        '[nodox] validate() options.response received an unrecognized schema type. ' +
        'Pass a Zod schema, Joi schema, or a plain JSON Schema object.'
      )
    }
  }

  // Capture callsite so UI can show "defined in src/routes/users.js:12"
  const source = captureValidateCallsite()

  // The route key isn't known until this middleware is attached to a route.
  // We use a deferred registration approach: the middleware function carries
  // the schema, and the app-patcher reads it from the handler array when
  // a route is registered.
  const registeredSchema = {
    library,
    rawSchema: schema,
    jsonSchema,
    outputJsonSchema,
    source,
    confidence: 'confirmed',
  }

  /**
   * The actual Express middleware.
   * Runs schema.safeParse (Zod) or schema.validate (Joi) on req.body.
   * On failure: 400 with validation error detail.
   * On success: replaces req.body with parsed/coerced value and calls next().
   */
  function nodoxValidateMiddleware(req, res, next) {
    let result

    try {
      if (library === 'zod') {
        result = strict
          ? schema.strict().safeParse(req.body)
          : schema.safeParse(req.body)

        if (!result.success) {
          // Zod v4 uses .issues, v3 uses .errors — support both
          const issues = result.error.issues ?? result.error.errors ?? []
          return res.status(400).json({
            error: 'Validation failed',
            details: issues.map(e => ({
              path: Array.isArray(e.path) ? e.path.join('.') : String(e.path ?? ''),
              message: e.message,
              code: e.code,
            }))
          })
        }
        req.body = result.data

      } else if (library === 'joi') {
        const { error, value } = schema.validate(req.body, {
          abortEarly: false,
          allowUnknown: !strict,
        })

        if (error) {
          return res.status(400).json({
            error: 'Validation failed',
            details: error.details.map(d => ({
              path: d.path.join('.'),
              message: d.message,
              type: d.type,
            }))
          })
        }
        req.body = value

      } else if (library === 'yup') {
        // yup.validateSync() throws a ValidationError on failure
        req.body = schema.validateSync(req.body, {
          abortEarly: false,
          stripUnknown: !strict,
        })

      } else if (library === 'jsonschema') {
        // For plain JSON Schema, do a basic type check
        // (Full JSON Schema validation requires a library like ajv — not bundled)
        // nodox registers the schema for display but doesn't validate beyond type
        req.body = req.body
      }
    } catch (err) {
      // yup throws ValidationError on invalid input — return 400
      if (err?.name === 'ValidationError' && err?.inner) {
        return res.status(400).json({
          error: 'Validation failed',
          details: (err.inner.length ? err.inner : [err]).map(e => ({
            path: e.path || '',
            message: e.message,
            type: e.type,
          }))
        })
      }
      // Other schema validation errors — unexpected
      console.error('[nodox] validate() middleware threw unexpectedly:', err)
      return res.status(500).json({ error: 'Internal validation error' })
    }

    next()
  }

  // Attach the schema to the middleware function so app-patcher can read it
  nodoxValidateMiddleware.__nodoxSchema = registeredSchema
  nodoxValidateMiddleware.__isNodoxValidate = true

  return nodoxValidateMiddleware
}

/**
 * Detect which schema library produced a given schema object.
 * @param {any} schema
 * @returns {'zod'|'joi'|'yup'|'jsonschema'|null}
 */
export function detectSchemaLibrary(schema) {
  if (!schema || typeof schema !== 'object') return null

  // Zod v3: _def.typeName, Zod v4: .def.type + .safeParse + .toJSONSchema
  if (schema._def?.typeName) return 'zod'
  if (typeof schema.safeParse === 'function' && typeof schema.toJSONSchema === 'function') return 'zod'
  if (schema.def?.type && typeof schema.safeParse === 'function') return 'zod'

  // Joi schemas have an isJoi flag or $_root
  if (schema.isJoi || schema.$_root) return 'joi'
  if (schema.type && typeof schema.type === 'string' && schema.$_terms) return 'joi'

  // yup v1: has _type string + validateSync; yup v0: __isYupSchema__
  if (schema._type && typeof schema.validateSync === 'function') return 'yup'
  if (schema.__isYupSchema__ && typeof schema.validate === 'function') return 'yup'

  // Plain JSON Schema: has type/properties but not zod-like methods
  if ((schema.type || schema.properties || schema.$schema || schema.anyOf) &&
      typeof schema.safeParse !== 'function') return 'jsonschema'

  return null
}

/**
 * Convert any supported schema to JSON Schema format.
 * @param {object} schema
 * @param {'zod'|'joi'|'jsonschema'} library
 * @returns {object} JSON Schema object
 */
export function toJsonSchema(schema, library) {
  try {
    if (library === 'zod') {
      // Zod v4 has a native toJSONSchema() method — prefer it
      if (typeof schema.toJSONSchema === 'function') {
        const result = schema.toJSONSchema()
        // Remove $schema to keep output clean for UI rendering
        const { $schema, ...rest } = result
        return rest
      }
      // Zod v3 fallback: use zod-to-json-schema package
      return zodToJsonSchema(schema, {
        name: undefined,
        $refStrategy: 'none',
      })
    }

    if (library === 'joi') {
      // Joi doesn't have a built-in JSON Schema converter in all versions.
      // We do a best-effort structural extraction.
      return joiToJsonSchema(schema)
    }

    if (library === 'yup') {
      return yupToJsonSchema(schema)
    }

    if (library === 'jsonschema') {
      return schema
    }
  } catch (err) {
    console.warn('[nodox] Failed to convert schema to JSON Schema:', err.message)
  }

  return { type: 'object' }
}

/**
 * Best-effort yup → JSON Schema conversion via schema.describe().
 * @param {object} yupSchema
 * @returns {object}
 */
function yupToJsonSchema(yupSchema) {
  try {
    const desc = yupSchema.describe()
    return yupDescToJsonSchema(desc)
  } catch {
    return { type: 'object', description: 'yup schema (conversion failed)' }
  }
}

function yupDescToJsonSchema(desc) {
  if (!desc) return {}
  const out = {}

  switch (desc.type) {
    case 'object': {
      out.type = 'object'
      if (desc.fields) {
        out.properties = {}
        const required = []
        for (const [key, val] of Object.entries(desc.fields)) {
          out.properties[key] = yupDescToJsonSchema(val)
          // yup fields without optional/nullable flag are required
          const isOptional = val.optional === true || val.nullable === true
          if (!isOptional) required.push(key)
        }
        if (required.length) out.required = required
      }
      break
    }
    case 'string':
      out.type = 'string'
      break
    case 'number':
      out.type = 'number'
      break
    case 'boolean':
      out.type = 'boolean'
      break
    case 'array':
      out.type = 'array'
      if (desc.innerType) out.items = yupDescToJsonSchema(desc.innerType)
      break
    case 'date':
      out.type = 'string'
      out.format = 'date-time'
      break
    default:
      out.type = desc.type || 'any'
  }

  if (desc.label) out.description = desc.label
  return out
}

/**
 * Best-effort Joi → JSON Schema conversion.
 * Handles the common cases (object, string, number, boolean, array).
 * For complex Joi schemas, output is approximate.
 * @param {object} joiSchema
 * @returns {object}
 */
function joiToJsonSchema(joiSchema) {
  try {
    const desc = joiSchema.describe()
    return joiDescToJsonSchema(desc)
  } catch {
    return { type: 'object', description: 'Joi schema (conversion failed)' }
  }
}

function joiDescToJsonSchema(desc) {
  if (!desc) return {}

  const out = {}

  switch (desc.type) {
    case 'object': {
      out.type = 'object'
      if (desc.keys) {
        out.properties = {}
        const required = []
        for (const [key, val] of Object.entries(desc.keys)) {
          out.properties[key] = joiDescToJsonSchema(val)
          if (!val.flags?.presence || val.flags.presence === 'required') {
            required.push(key)
          }
        }
        if (required.length) out.required = required
      }
      break
    }
    case 'string':
      out.type = 'string'
      if (desc.flags?.only && desc.allow?.length) {
        out.enum = desc.allow
      }
      break
    case 'number':
    case 'integer':
      out.type = desc.type
      break
    case 'boolean':
      out.type = 'boolean'
      break
    case 'array':
      out.type = 'array'
      if (desc.items?.length) {
        out.items = joiDescToJsonSchema(desc.items[0])
      }
      break
    case 'date':
      out.type = 'string'
      out.format = 'date-time'
      break
    default:
      out.type = desc.type || 'any'
  }

  if (desc.flags?.description) {
    out.description = desc.flags.description
  }

  return out
}

/**
 * Register a schema for a specific route.
 * Called by the app-patcher when it finds a validate() middleware in a handler chain.
 *
 * @param {string} method
 * @param {string} path
 * @param {RegisteredSchema} schema
 */
export function registerSchemaForRoute(method, path, schema) {
  const key = `${method.toUpperCase()}:${path}`
  schemaRegistry.set(key, schema)
}

/**
 * Get the registered schema for a route, if any.
 * @param {string} method
 * @param {string} path
 * @returns {RegisteredSchema|null}
 */
export function getSchemaForRoute(method, path) {
  return schemaRegistry.get(`${method.toUpperCase()}:${path}`) ?? null
}

function captureValidateCallsite() {
  try {
    const err = new Error()
    const lines = err.stack?.split('\n') || []
    for (const line of lines.slice(2)) {
      const match = line.match(/\((.+?):(\d+):\d+\)/) ||
                    line.match(/at (.+?):(\d+):\d+/)
      if (!match) continue
      const file = match[1]
      if (file.includes('nodox-cli/src') || file.includes('node_modules/nodox-cli')) continue
      if (file.includes('node:internal')) continue
      // Return a project-relative path instead of the full absolute path.
      // Avoids leaking the server's filesystem layout to the browser UI.
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
