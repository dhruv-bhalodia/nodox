/**
 * Response Interceptor — Layer 5 of the 5-layer fallback strategy
 *
 * Wraps res.json() on every request to silently capture the shape of
 * every response returned by the server. Shapes are inferred structurally
 * (field names + types, not values) and stored per route.
 *
 * This runs continuously during development. Every request a developer
 * makes — manually or via tests — teaches nodox what the response looks like.
 * The UI updates in real-time via WebSocket.
 *
 * Guards:
 *   - Only records routes with a concrete matched path (req.route?.path)
 *   - Skips wildcard routes (*, error handlers)
 *   - Skips nodox's own routes (/__nodox*)
 *   - Uses structuredClone to avoid holding references to large response objects
 */

/**
 * Infer the structural "shape" of a value.
 * Returns a JSON Schema-compatible structure describing field names and types,
 * not actual values.
 *
 * @param {any} value
 * @param {number} [depth=0] - Current recursion depth
 * @returns {object} JSON Schema fragment
 */
export function inferShape(value, depth = 0) {
  // Limit recursion depth to prevent runaway inference on deeply nested objects
  if (depth > 8) return { type: 'object', description: '(depth limit)' }

  if (value === null) return { type: 'null' }
  if (value === undefined) return { type: 'null' }
  if (value instanceof Date) return { type: 'string', format: 'date-time' }

  const type = typeof value

  if (type === 'boolean') return { type: 'boolean' }
  if (type === 'number') {
    return Number.isInteger(value)
      ? { type: 'integer' }
      : { type: 'number' }
  }
  if (type === 'string') {
    // Detect common string formats
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return { type: 'string', format: 'date-time' }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { type: 'string', format: 'date' }
    if (/^[a-f0-9-]{36}$/i.test(value)) return { type: 'string', format: 'uuid' }
    if (/^https?:\/\//.test(value)) return { type: 'string', format: 'uri' }
    return { type: 'string' }
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return { type: 'array', items: {} }
    // Infer from first item (sample) — merge with second if available for robustness
    const itemShape = inferShape(value[0], depth + 1)
    if (value.length > 1) {
      const secondShape = inferShape(value[1], depth + 1)
      return { type: 'array', items: mergeShapes(itemShape, secondShape) }
    }
    return { type: 'array', items: itemShape }
  }

  if (type === 'object') {
    const properties = {}
    const keys = Object.keys(value)

    // Cap at 50 fields — very large objects (e.g. debug dumps) aren't useful to display fully
    const limitedKeys = keys.slice(0, 50)
    for (const key of limitedKeys) {
      properties[key] = inferShape(value[key], depth + 1)
    }

    const result = { type: 'object', properties }
    if (keys.length > 50) {
      result.description = `(showing 50 of ${keys.length} fields)`
    }
    return result
  }

  return { type: 'any' }
}

/**
 * Merge two inferred shapes into one.
 * Used when we've seen multiple responses for the same route — we build
 * the union of all observed fields and types.
 *
 * @param {object} a
 * @param {object} b
 * @returns {object}
 */
export function mergeShapes(a, b) {
  if (!a) return b
  if (!b) return a

  // If types differ, use anyOf
  if (a.type !== b.type && a.type && b.type) {
    // Special case: integer + number → number
    if (
      (a.type === 'integer' && b.type === 'number') ||
      (a.type === 'number' && b.type === 'integer')
    ) {
      return { type: 'number' }
    }
    return { anyOf: [a, b] }
  }

  if (a.type === 'object' && b.type === 'object') {
    const allKeys = new Set([
      ...Object.keys(a.properties || {}),
      ...Object.keys(b.properties || {}),
    ])
    const properties = {}
    for (const key of allKeys) {
      if (a.properties?.[key] && b.properties?.[key]) {
        properties[key] = mergeShapes(a.properties[key], b.properties[key])
      } else {
        // Field only in one response — mark as potentially optional
        properties[key] = a.properties?.[key] || b.properties?.[key]
      }
    }
    return { type: 'object', properties }
  }

  if (a.type === 'array' && b.type === 'array') {
    return {
      type: 'array',
      items: mergeShapes(a.items, b.items),
    }
  }

  // Same primitive type
  if (a.type === b.type) {
    if (a.format !== b.format) {
      const merged = { ...a }
      delete merged.format
      return merged
    }
    return a
  }

  return a
}

/**
 * Check if a route path is a wildcard or catch-all that we should skip.
 * @param {string} path
 * @returns {boolean}
 */
function isWildcardRoute(path) {
  if (!path) return true
  return path === '*' ||
    path === '/*' ||
    path.startsWith('/__nodox') ||
    path === '/favicon.ico' ||
    /\*/.test(path)
}

/** HTTP methods that carry a request body (observed for input schema). */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

/** HTTP methods where req.query is the primary input (observed as querySchema). */
const QUERY_METHODS = new Set(['GET', 'DELETE', 'HEAD', 'OPTIONS'])

/**
 * Create the response interceptor middleware.
 *
 * @param {object} options
 * @param {Function} options.onResponseShape - Called with (method, path, shape, confidence)
 * @param {WeakMap} [options.parsedValueToSchema] - Weak map from schema-detector: if the
 *   response body was produced by a Zod/Joi/yup .parse() call the known schema is used
 *   (confidence: 'inferred') instead of structural inference (confidence: 'observed').
 * @param {Function} [options.onRequestBodyShape] - Called with (method, path, shape) when a
 *   request body is observed. Covers POST/PUT/PATCH routes with no explicit validation.
 * @param {Function} [options.onRequestQueryShape] - Called with (method, path, shape) when
 *   non-empty query parameters are observed on a GET/DELETE/etc. request.
 * @returns {Function} Express middleware
 */
export function createResponseInterceptor({ onResponseShape, parsedValueToSchema, onRequestBodyShape, onRequestQueryShape }) {
  return function responseInterceptorMiddleware(req, res, next) {
    // Wrap res.json before the handler runs
    const originalJson = res.json.bind(res)

    res.json = function interceptedJson(body) {
      // Only record if we have a concrete matched route.
      // We prepend req.baseUrl to handle routers mounted with a prefix (e.g. app.use('/api', router)).
      const routePath = req.route
        ? ((req.baseUrl || '') + req.route.path).replace(/\/+/g, '/')
        : null

      if (routePath && !isWildcardRoute(routePath)) {
        const method = req.method?.toUpperCase() ?? ''

        // ── Request body observation ──────────────────────────────────────
        // Observe req.body for methods that carry a body. This fires once per
        // real request and covers routes where no explicit schema validation exists.
        // req.body is already populated by body-parser at this point.
        if (typeof onRequestBodyShape === 'function' &&
            BODY_METHODS.has(method) &&
            req.body !== null && req.body !== undefined &&
            typeof req.body === 'object' &&
            Object.keys(req.body).length > 0) {
          try {
            onRequestBodyShape(method, routePath, inferShape(req.body))
          } catch {}
        }

        // ── Query parameter observation ───────────────────────────────────
        // For GET/DELETE/etc., observe req.query. These methods don't have a body,
        // so query params are the primary input. Only observe non-empty query strings.
        if (typeof onRequestQueryShape === 'function' &&
            QUERY_METHODS.has(method) &&
            req.query !== null && req.query !== undefined &&
            typeof req.query === 'object' &&
            Object.keys(req.query).length > 0) {
          try {
            onRequestQueryShape(method, routePath, inferShape(req.query))
          } catch {}
        }

        // ── Response body observation ─────────────────────────────────────
        if (body !== undefined) {
          try {
            // If the body was produced by a Zod/Joi/yup .parse() call, use the
            // known schema directly (higher confidence) instead of inferring.
            let shape, confidence
            if (parsedValueToSchema && body !== null && typeof body === 'object') {
              const knownSchema = parsedValueToSchema.get(body)
              if (knownSchema) {
                shape = knownSchema
                confidence = 'inferred'
              }
            }

            if (!shape) {
              shape = inferShape(body)
              confidence = 'observed'
            }

            onResponseShape(method, routePath, shape, confidence)
          } catch {
            // Shape inference failed — don't crash the response
          }
        }
      }

      return originalJson(body)
    }

    next()
  }
}
