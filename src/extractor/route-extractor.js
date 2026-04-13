/**
 * Route Extractor
 *
 * Reads Express's internal app._router.stack to discover every registered
 * route at startup — before any request is made. Handles nested routers,
 * mounted sub-routers, and Express Router instances.
 *
 * Compatible with Express 4.x and 5.x:
 *   Express 4 — app.lazyrouter() initializes _router lazily
 *   Express 5 — _router initializes on first use(); lazyrouter removed
 */

import { createRequire } from 'module'
const _require = createRequire(import.meta.url)

/**
 * @typedef {Object} ExtractedRoute
 * @property {string} method - HTTP method in uppercase (GET, POST, etc.)
 * @property {string} path - Full route path including any prefix
 * @property {string[]} middlewareNames - Names of middleware functions on this route
 * @property {Function[]} handlers - Actual handler functions (for retroactive schema detection)
 * @property {boolean} hasValidator - Whether a validation middleware was detected
 */

/**
 * Resolve the installed Express version string, or null if undetectable.
 * @returns {string|null}
 */
function getExpressVersion() {
  try {
    return _require('express/package.json').version || null
  } catch {
    return null
  }
}

/**
 * Extract all routes from an Express app.
 * @param {import('express').Application} app
 * @returns {ExtractedRoute[]}
 */
export function extractRoutes(app) {
  const routes = []

  // Resolve the router — Express 4 and 5 both store it on _router.
  // In Express 4 it may not exist until the first app.use() or lazyrouter().
  const router = _getRouter(app)
  if (!router) return routes

  walkStack(router.stack, '', routes)

  // Deduplicate by method+path in case of multiple extractions
  const seen = new Set()
  return routes.filter(r => {
    const key = `${r.method}:${r.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Resolve the underlying Express Router from an app instance.
 * Handles Express 4 (lazy init via lazyrouter) and Express 5 (no lazyrouter).
 * @param {import('express').Application} app
 * @returns {object|null}
 */
function _getRouter(app) {
  // Express 4: force lazy initialization so _router exists even before the
  // first middleware is registered (needed for early extraction).
  if (typeof app.lazyrouter === 'function') {
    try { app.lazyrouter() } catch {}
  }

  // Both Express 4 and 5 expose _router after initialization.
  if (app._router?.stack) return app._router

  // Express 5 fallback: some builds expose the router differently.
  if (app.router?.stack) return app.router

  return null
}

/**
 * Recursively walk Express router stack layers.
 * @param {any[]} stack
 * @param {string} prefix
 * @param {ExtractedRoute[]} routes
 */
function walkStack(stack, prefix, routes) {
  if (!Array.isArray(stack)) return

  for (const layer of stack) {
    if (!layer) continue

    if (layer.route) {
      // This is a concrete route (app.get, app.post, etc.)
      extractFromRoute(layer.route, prefix, routes)
    } else {
      // Resolve the child stack — three sources, checked in order:
      //
      //   1. express.Router() — stack lives directly on the handle function
      //   2. express() sub-app mounted via router.use() (no wrapping) —
      //      stack is at handle._router.stack; call lazyrouter() to force init
      //   3. express() sub-app mounted via app.use() — Express wraps it in an
      //      internal `mounted_app` closure, hiding the sub-app from the layer.
      //      app-patcher tags the original sub-app as layer._nodoxSubApp so we
      //      can reach it here.
      let childStack = layer.handle?.stack ?? null

      if (!childStack && layer.handle) {
        // Case 2: handle is an express() app passed directly (e.g. via router.use)
        if (typeof layer.handle.lazyrouter === 'function') {
          try { layer.handle.lazyrouter() } catch {}
        }
        childStack = layer.handle._router?.stack ?? null
      }

      if (!childStack && layer._nodoxSubApp) {
        // Case 3: sub-app mounted via app.use() — patcher saved the reference
        const subApp = layer._nodoxSubApp
        if (typeof subApp.lazyrouter === 'function') {
          try { subApp.lazyrouter() } catch {}
        }
        childStack = subApp._router?.stack ?? null
      }

      if (childStack) {
        const mountPath = extractMountPath(layer)
        walkStack(childStack, prefix + mountPath, routes)
      }
    }
  }
}

/**
 * Extract a mount path from a layer's regexp.
 * Express compiles path strings into regexp at registration time.
 * We reverse-engineer the path from the regexp source when possible.
 * @param {any} layer
 * @returns {string}
 */
function extractMountPath(layer) {
  // Priority 1: Use the original path string captured during registration.
  // This is the most accurate source and handles all Express versions.
  if (layer._nodoxPath) return layer._nodoxPath

  if (!layer.regexp) return ''

  // Express fast-path: exact path stored directly
  if (layer.regexp.fast_slash) return ''
  if (layer.regexp.fast_star) return '*'

  const src = layer.regexp.source

  // Fallback: Try to recover the path from the compiled regexp (brittle).
  // Express 4 compiles /api to: ^\/api\/?(?=\/|$)/i
  const match = src.match(/^\^\\\/(.+?)\\\/\?/)
  if (match) {
    return '/' + match[1].replace(/\\\//g, '/')
  }

  // Express 5 path-to-regexp pattern
  const match5 = src.match(/^\^\\\/(.+?)(?:\\\/\?|\/\?)?\$?\//)
  if (match5) {
    return '/' + match5[1].replace(/\\\//g, '/')
  }

  return ''
}

/**
 * Check if a route path is a pure catch-all that should be excluded.
 * We allow partial wildcards (splats) but skip global listeners.
 * @param {string} routePath
 * @returns {boolean}
 */
function isWildcardPath(routePath) {
  if (!routePath) return true
  if (routePath.startsWith('/__nodox')) return true

  // Pure catch-alls that pollute documentation
  const catchAlls = ['*', '/*', '(.*)', '/(.*)']
  return catchAlls.includes(routePath)
}

/**
 * Extract route info from an Express Route object.
 * @param {any} route - Express Route instance
 * @param {string} prefix
 * @param {ExtractedRoute[]} routes
 */
function extractFromRoute(route, prefix, routes) {
  const path = normalizePath(prefix + route.path)

  // Skip wildcard and catch-all routes — they pollute the route list
  if (isWildcardPath(path)) return

  // Collect shared per-route data once (same for every method layer on this route)
  const middlewareNames = route.stack
    .map(l => l.handle?.name || 'anonymous')
    .filter(Boolean)

  // Include actual handler functions so the schema detector can retroactively
  // process routes that were registered before patchApp was applied.
  const handlers = route.stack
    .map(l => l.handle)
    .filter(h => typeof h === 'function')

  // route.stack contains one layer per HTTP method on this route
  for (const layer of route.stack) {
    const method = layer.method?.toUpperCase()
    if (!method) continue

    routes.push({
      method,
      path,
      middlewareNames,
      handlers,
      hasValidator: false, // Updated by schema detector in Phase 2
    })
  }
}

/**
 * Normalize a path: collapse double slashes, ensure leading slash.
 * @param {string} path
 * @returns {string}
 */
function normalizePath(path) {
  return ('/' + path).replace(/\/+/g, '/').replace(/\/$/, '') || '/'
}

/**
 * Check Express version compatibility and return a structured result.
 *
 * Detects the installed Express version and validates it is supported.
 * Also forces router initialization so _router is available immediately.
 *
 * @param {import('express').Application} app
 * @returns {{ compatible: boolean, warning?: string, version?: string }}
 */
export function checkExpressCompatibility(app) {
  const version = getExpressVersion()
  const major = version ? parseInt(version.split('.')[0], 10) : null

  // Reject obviously incompatible versions
  if (major !== null && (major < 4 || major > 5)) {
    return {
      compatible: false,
      warning: `[nodox] Express ${version} is not supported. nodox requires Express 4.x or 5.x.`,
    }
  }

  // Validate that the argument is actually an Express app
  const isExpressApp = app != null &&
    typeof app.use === 'function' &&
    typeof app.get === 'function' &&
    typeof app.listen === 'function'

  if (!isExpressApp) {
    return {
      compatible: false,
      warning: '[nodox] The first argument to nodox() must be an Express app instance.',
    }
  }

  // Express 4 — call lazyrouter() to force _router initialization now
  // so that extractRoutes() works even before the first route is registered.
  if (typeof app.lazyrouter === 'function') {
    try { app.lazyrouter() } catch {}
  }

  // Express 5 removed lazyrouter. _router is created on first route registration,
  // so early extraction may return an empty list — that is expected and fine.

  return { compatible: true, version: version || 'unknown' }
}
