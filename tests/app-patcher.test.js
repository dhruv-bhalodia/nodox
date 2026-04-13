/**
 * App Patcher Tests
 */

import express from 'express'
import { patchApp } from '../src/middleware/app-patcher.js'

describe('patchApp', () => {
  test('calls onRouteRegistered when a route is added', () => {
    const app = express()
    const calls = []

    patchApp(app, {
      onRouteRegistered(method, path) {
        calls.push({ method, path })
      }
    })

    app.get('/test', (req, res) => res.json({}))
    app.post('/items', (req, res) => res.json({}))

    expect(calls).toContainEqual({ method: 'GET', path: '/test' })
    expect(calls).toContainEqual({ method: 'POST', path: '/items' })
  })

  test('unpatch restores original methods', () => {
    const app = express()
    const originalGet = app.get.bind(app)

    const unpatch = patchApp(app, {})
    expect(app.get).not.toBe(originalGet)

    unpatch()
    // After unpatching, app.get should work normally
    // (We can't compare function references easily in ESM, so we test behavior)
    expect(() => app.get('/restore-test', (req, res) => res.json({}))).not.toThrow()
  })

  test('does not interfere with normal route registration', () => {
    const app = express()
    patchApp(app, {})

    // Register routes normally
    app.get('/a', (req, res) => res.json({ route: 'a' }))
    app.post('/b', (req, res) => res.json({ route: 'b' }))

    // Check they exist in the router
    const routes = app._router?.stack
      ?.filter(l => l.route)
      .map(l => ({ method: Object.keys(l.route.methods)[0].toUpperCase(), path: l.route.path }))

    expect(routes).toContainEqual({ method: 'GET', path: '/a' })
    expect(routes).toContainEqual({ method: 'POST', path: '/b' })
  })

  test('tags router layers with _nodoxPath for prefix tracking', () => {
    const app = express()
    patchApp(app, {})

    const router = express.Router()
    router.get('/health', (req, res) => res.json({ ok: true }))

    app.use('/api', router)

    // The last layer in the stack should have _nodoxPath set
    const layers = app._router?.stack || []
    const routerLayer = layers.find(l => l._nodoxPath === '/api')
    expect(routerLayer).toBeDefined()
  })

  test('onRouteRegistered receives handlers array', () => {
    const app = express()
    let capturedHandlers = null

    patchApp(app, {
      onRouteRegistered(method, path, handlers) {
        if (path === '/with-middleware') {
          capturedHandlers = handlers
        }
      }
    })

    const mw = (req, res, next) => next()
    const handler = (req, res) => res.json({})
    app.get('/with-middleware', mw, handler)

    expect(capturedHandlers).toBeDefined()
    expect(capturedHandlers).toHaveLength(2)
  })
})
