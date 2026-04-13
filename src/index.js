/**
 * nodox — Main Entry Point
 *
 * Usage — minimal, one line:
 *
 *   app.use(nodox())          // app is optional — detected from req.app
 *   app.use(nodox(app))       // explicit app — enables Layer 2 source screening
 *
 * Full example:
 *
 *   import express from 'express'
 *   import nodox from 'nodox'
 *
 *   const app = express()
 *   app.use(express.json())
 *   app.use(nodox())
 *
 *   app.get('/users', handler)
 *   app.listen(3000)
 *   // UI at http://localhost:3000/__nodox
 */

import { patchApp } from './middleware/app-patcher.js'
import { extractRoutes, checkExpressCompatibility } from './extractor/route-extractor.js'
import { NodoxWebSocketServer } from './websocket/ws-server.js'
import { attachUiRoutes, createUiHandler } from './ui-server/ui-server.js'
import { createResponseInterceptor } from './schema/response-interceptor.js'
import {
  onRouteRegistered as schemaOnRouteRegistered,
  runDeferredDryRuns,
  enrichRoutesWithSchemas,
  onResponseObserved,
  onInputObserved,
  onQueryObserved,
  initSchemaDetector,
  loadCacheIntoRegistry,
  parsedValueToSchema,
  patchZodWithRegistry,
  wasRouteRegistered,
} from './schema/schema-detector.js'
import { findCacheFile } from './layer4/cache-reader.js'

export { validate } from './schema/validate.js'

/**
 * @typedef {Object} NodoxOptions
 * @property {string}  [uiPath='/__nodox']
 * @property {boolean} [log=true]
 * @property {boolean} [schema=true]
 * @property {boolean} [intercept=true]
 * @property {boolean} [force=false] - Allow nodox to run in production (opt-in)
 */

/**
 * @param {import('express').Application|NodoxOptions} [appOrOptions]
 * @param {NodoxOptions} [options]
 * @returns {Function} Express middleware
 */
export default function nodox(appOrOptions, options = {}) {
  // Distinguish nodox(app, opts) vs nodox(opts) vs nodox()
  // Express apps are functions (typeof === 'function'), not plain objects,
  // so we check for the .use method to identify them rather than typeof === 'object'.
  let app = null
  if (appOrOptions && typeof appOrOptions.use === 'function') {
    app = appOrOptions
  } else if (appOrOptions && typeof appOrOptions === 'object') {
    options = appOrOptions
  }

  const {
    uiPath = '/__nodox',
    log = true,
    schema = true,
    intercept = true,
    force = false,
  } = options

  // Production safety guard.
  // nodox exposes all routes, schemas, and a request playground — never run in prod.
  // Opt out with { force: true } only if you know what you're doing.
  if (process.env.NODE_ENV === 'production' && !force) {
    console.warn(
      '[nodox] Disabled in production (NODE_ENV=production).\n' +
      '        Pass { force: true } to override — but do not expose /__nodox publicly.'
    )
    return function nodoxDisabledMiddleware(_req, _res, next) { next() }
  }

  /** @type {import('./extractor/route-extractor.js').ExtractedRoute[]} */
  let routes = []
  /** @type {NodoxWebSocketServer|null} */
  let wsServer = null
  let serverAttached = false
  let extractionTimer = null
  let appInitDone = false
  let portLogged = false // track whether we've logged the real URL yet

  // Layer 1: patch zod/joi at module level (doesn't need app)
  if (schema) initSchemaDetector()

  // Layer 4: load .apicache.json from previous test runs into registry (doesn't need app)
  const cacheCount = schema ? loadCacheIntoRegistry() : 0

  function scheduleExtraction() {
    if (extractionTimer) clearTimeout(extractionTimer)
    extractionTimer = setTimeout(doExtraction, 50)
  }

  function doExtraction() {
    if (!app) return
    extractionTimer = null
    const raw = extractRoutes(app)

    if (schema) {
      // Retroactively process routes that were registered before patchApp was
      // applied — i.e., routes defined before nodox(app) was called. These never
      // triggered onRouteRegistered so were never source-screened or dry-run.
      // _dryRunStartupComplete is true by the time this runs at startup, so
      // _dryRunRoute fires immediately (fire-and-forget, see onRouteRegistered).
      for (const route of raw) {
        if (!wasRouteRegistered(route.method, route.path) && route.handlers?.length) {
          schemaOnRouteRegistered(route.method, route.path, route.handlers)
        }
      }
    }

    routes = schema ? enrichRoutesWithSchemas(raw) : raw
    wsServer?.broadcastFullSync()
  }

  const logStartup = (port = 'PORT') => {
    if (portLogged) return
    portLogged = true

    // Force extraction if it hasn't happened yet so the log is accurate
    if (routes.length === 0) {
      const raw = extractRoutes(app)
      routes = schema ? enrichRoutesWithSchemas(raw) : raw
    }

    console.log(
      `\n  \x1b[36m◆ nodox\x1b[0m  \x1b[2mUI →\x1b[0m \x1b[4;36mhttp://localhost:${port}${uiPath}\x1b[0m`
    )
    const count = routes.length
    const schemaCount = routes.filter(r => r.hasValidator).length
    console.log(
      `  \x1b[2m         ${count} route${count !== 1 ? 's' : ''} discovered` +
      (schemaCount > 0 ? `, ${schemaCount} with schema` : '') + `\x1b[0m\n`
    )
  }

  function getState() { return { routes } }

  /**
   * Run once with a known app reference — either at construction (early) or
   * on first middleware call (late). Idempotent.
   */
  function _initWithApp(theApp) {
    if (appInitDone) return
    appInitDone = true
    app = theApp

    const compat = checkExpressCompatibility(theApp)
    if (!compat.compatible) console.warn(compat.warning)

    // Patch listen to capture the server and log the real port immediately
    if (typeof theApp.listen === 'function') {
      const originalListen = theApp.listen
      theApp.listen = function nodoxPatchedListen(...args) {
        const server = originalListen.apply(this, args)
        server.once('listening', () => {
          const addr = server.address()
          const port = typeof addr === 'string' ? addr : addr?.port
          
          // Before logging, try to run dry-runs for any routes discovered so far
          if (schema) runDeferredDryRuns()

          if (log && port && !portLogged) logStartup(port)
          
          // Proactively attach WebSocket as soon as the server is listening
          if (!serverAttached) {
            serverAttached = true
            wsServer = new NodoxWebSocketServer({ getState })
            wsServer.attach(server)
          }
        })
        return server
      }
    }

    patchApp(theApp, {
      onRouteRegistered(method, path, handlers) {
        if (schema) schemaOnRouteRegistered(method, path, handlers)
        scheduleExtraction()
      },
      onUse() {
        scheduleExtraction()
      }
    })

    attachUiRoutes(theApp, { uiPath })
  }

  // Early init — only possible when app was passed to nodox()
  const wasEarlyInit = !!app
  if (wasEarlyInit) _initWithApp(app)

  // Deferred startup tick: dry-runs, initial extraction, startup log
  setTimeout(async () => {
    if (schema) {
      // Async-import Zod/Joi/yup so we get the same ESM module instance the user's
      // code imports. This is the reliable path for Zod v4 where require() returns
      // a different object than import(). Fire-and-forget; errors are harmless.
      try {
        const zodMod = await import('zod').catch(() => null)
        if (zodMod) {
          const z = zodMod?.z || zodMod?.default?.z || zodMod
          if (z) patchZodWithRegistry(z)
        }
      } catch {}
      runDeferredDryRuns()
    }
    doExtraction()

    if (log) {
      // Body-parser warning — app is always known here when wasEarlyInit is true
      if (app) _warnIfNoBodyParser(app)

      // Hint if no .apicache.json exists yet
      if (schema && cacheCount === 0 && !findCacheFile()) {
        console.log('[nodox] Run `npx nodox init` once to enable test suite schema seeding.')
      }

      // Try to detect the actual port from the app's server if it's already listening.
      // If not, we wait for the listen() callback (patched above) or the first request.
      const server = app?._router?.server || app?.server
      if (server?.listening) {
        logStartup(server.address().port)
      } else if (!portLogged) {
        // Only log placeholder if we STILL haven't captured the port via listen().
        // For apps that use app.listen(port, () => ...), the patch will usually
        // have fired by now.
        logStartup()
      }
    }

    wsServer?.broadcastFullSync()
  }, 0)

  // Layer 5: response interceptor + live request body observer (doesn't need app)
  const responseInterceptor = intercept
    ? createResponseInterceptor({
        parsedValueToSchema,
        onRequestBodyShape(method, routePath, shape) {
          if (!schema) return
          onInputObserved(method, routePath, shape, 'observed', () => {
            doExtraction()
            wsServer?.broadcast({ type: 'schema-update', method, path: routePath })
          })
        },
        onRequestQueryShape(method, routePath, shape) {
          if (!schema) return
          onQueryObserved(method, routePath, shape, () => {
            doExtraction()
            wsServer?.broadcast({ type: 'schema-update', method, path: routePath })
          })
        },
        onResponseShape(method, routePath, shape, confidence) {
          if (!schema) return
          onResponseObserved(method, routePath, shape, confidence, () => {
            doExtraction()
            wsServer?.broadcast({ type: 'schema-update', method, path: routePath })
          })
        }
      })
    : null

  // Inline UI handler — only used in the no-early-app path.
  // When app IS provided early, attachUiRoutes registers routes that handle /__nodox.
  const inlineUiHandler = !wasEarlyInit ? createUiHandler({ uiPath }) : null

  return function nodoxMiddleware(req, res, next) {
    // Late init: grab app from req.app on the first request (no-arg path)
    if (!appInitDone && req.app) {
      _initWithApp(req.app)
      // Trigger extraction since routes may already be registered
      scheduleExtraction()
    }

    // In the no-early-app case, attachUiRoutes was called AFTER routes were registered,
    // so its routes land at the end of the stack. Serve the UI inline instead — always.
    if (inlineUiHandler && req.path.startsWith(uiPath)) {
      return inlineUiHandler(req, res, next)
    }

    // Attach WebSocket on the first request (needs HTTP server reference)
    if (!serverAttached) {
      serverAttached = true
      const httpServer = req.socket?.server
      if (httpServer) {
        wsServer = new NodoxWebSocketServer({ getState })
        wsServer.attach(httpServer)
        
        // Log the real URL once the server is available.
        if (log && !portLogged) {
          const address = httpServer.address()
          const port = typeof address === 'string' ? address : address?.port
          if (port) logStartup(port)
        }
      } else {
        console.warn('[nodox] Could not obtain HTTP server reference — WebSocket disabled.')
      }
    }

    if (responseInterceptor) responseInterceptor(req, res, () => {})
    next()
  }
}

function _warnIfNoBodyParser(app) {
  if (!app._router?.stack) return
  const hasBodyParser = app._router.stack.some(layer => {
    const name = layer.handle?.name || ''
    return ['jsonParser', 'urlencodedParser', 'json', 'bodyParser'].includes(name)
  })
  if (!hasBodyParser) {
    console.warn(
      '[nodox] Warning: no body parser detected.\n' +
      '        Add express.json() before nodox() for the playground to work.\n'
    )
  }
}
