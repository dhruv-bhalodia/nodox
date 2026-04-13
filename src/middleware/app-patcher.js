/**
 * App Patcher
 *
 * Wraps Express app.use() and route registration methods (get, post, put,
 * delete, patch) before the developer's routes are registered.
 *
 * Two purposes:
 * 1. Capture mount prefixes for sub-routers (so paths reconstruct correctly)
 * 2. Flag middleware functions that look like validators (Phase 2)
 *
 * Must be called BEFORE any app.use() or route registration in user code.
 */

// Express 4 also exposed `del` as an alias for `delete`.
// Express 5 removed it. We include it here so patching is harmless on both versions
// (the `typeof app[method] !== 'function'` guard below handles its absence in v5).
const ROUTE_METHODS = ['get', 'post', 'put', 'delete', 'del', 'patch', 'options', 'head', 'all']

/**
 * @typedef {Object} PatchState
 * @property {Map<string, any[]>} pendingValidators - route path -> flagged middleware fns
 * @property {Function[]} onRouteRegistered - callbacks called when any route is added
 */

/**
 * Patch an Express app to intercept route and middleware registration.
 *
 * @param {import('express').Application} app
 * @param {Object} options
 * @param {Function} options.onRouteRegistered - called with (method, path) after each route is registered
 * @returns {Function} unpatch - call to restore original methods
 */
export function patchApp(app, { onRouteRegistered, onUse } = {}) {
  const originalMethods = {}

  // Patch app.use to capture router mount paths
  originalMethods.use = app.use.bind(app)
  app.use = function patchedUse(...args) {
    // Tag the router layer with the path so extractMountPath can read it
    // even when the regexp has been compiled and the original string is gone.
    const result = originalMethods.use.apply(app, args)

    // After registration, tag the last added layer in the router stack
    // with the original path string so our extractor can use it.
    if (app._router?.stack?.length) {
      const lastLayer = app._router.stack[app._router.stack.length - 1]
      const pathArg = typeof args[0] === 'string' ? args[0] : null
      if (pathArg && lastLayer && !lastLayer._nodoxPath) {
        lastLayer._nodoxPath = pathArg
      }

      // Express wraps mounted sub-apps (express()) in an internal `mounted_app`
      // closure, which makes the sub-app unreachable from the layer at extraction
      // time. Tag the sub-app directly on the layer now while we still have it.
      const fnArgs = args.filter(a => a && typeof a === 'function')
      for (const fn of fnArgs) {
        // Heuristic: an Express app has both .handle (dispatch fn) and .set (config fn)
        if (typeof fn.handle === 'function' && typeof fn.set === 'function') {
          if (lastLayer && !lastLayer._nodoxSubApp) {
            lastLayer._nodoxSubApp = fn
          }
          break
        }
      }
    }

    // Notify listener — a mounted router/sub-app may add new routes
    if (typeof onUse === 'function') onUse()

    return result
  }

  // Patch each HTTP method to notify when a route is registered
  for (const method of ROUTE_METHODS) {
    if (typeof app[method] !== 'function') continue

    originalMethods[method] = app[method].bind(app)
    app[method] = function patchedMethod(path, ...handlers) {
      const result = originalMethods[method].call(app, path, ...handlers)

      // Notify listener that a new route was registered
      if (typeof onRouteRegistered === 'function') {
        onRouteRegistered(method.toUpperCase(), path, handlers)
      }

      return result
    }
  }

  // Return unpatch function for clean teardown (useful in tests)
  return function unpatch() {
    app.use = originalMethods.use
    for (const method of ROUTE_METHODS) {
      if (originalMethods[method]) {
        app[method] = originalMethods[method]
      }
    }
  }
}
