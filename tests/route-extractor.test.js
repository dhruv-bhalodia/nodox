/**
 * Route Extractor Tests
 *
 * Tests the core route extraction logic against real Express app instances.
 * We test against actual Express behavior — not mocks — because the internal
 * _router.stack API is what we depend on and mocks would give false confidence.
 */

import express from 'express'
import { extractRoutes, checkExpressCompatibility } from '../src/extractor/route-extractor.js'
import { patchApp } from '../src/middleware/app-patcher.js'

// Helper: create a minimal Express app with some routes
function makeApp(setup) {
  const app = express()
  app.use(express.json())
  setup(app)
  return app
}

// Force Express to initialize its router by adding a dummy middleware
function initRouter(app) {
  // Express lazily initializes _router on first use.
  // Accessing lazyrouter() triggers initialization.
  if (typeof app.lazyrouter === 'function') {
    app.lazyrouter()
  }
  return app
}

describe('extractRoutes', () => {
  test('extracts a single GET route', () => {
    const app = makeApp(a => {
      a.get('/users', (req, res) => res.json([]))
    })
    initRouter(app)

    const routes = extractRoutes(app)
    expect(routes).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/users' })
    )
  })

  test('extracts multiple HTTP methods', () => {
    const app = makeApp(a => {
      a.get('/items', (req, res) => res.json([]))
      a.post('/items', (req, res) => res.status(201).json({}))
      a.put('/items/:id', (req, res) => res.json({}))
      a.delete('/items/:id', (req, res) => res.status(204).end())
      a.patch('/items/:id', (req, res) => res.json({}))
    })

    const routes = extractRoutes(app)
    const methods = routes.map(r => r.method)

    expect(methods).toContain('GET')
    expect(methods).toContain('POST')
    expect(methods).toContain('PUT')
    expect(methods).toContain('DELETE')
    expect(methods).toContain('PATCH')
  })

  test('extracts routes from a mounted Router', () => {
    const app = express()
    const router = express.Router()

    router.get('/hello', (req, res) => res.json({}))
    router.post('/world', (req, res) => res.json({}))

    app.use('/api', router)

    const routes = extractRoutes(app)

    expect(routes).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/api/hello' })
    )
    expect(routes).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/api/world' })
    )
  })

  test('handles nested routers (router within router)', () => {
    const app = express()
    const v1 = express.Router()
    const users = express.Router()

    users.get('/', (req, res) => res.json([]))
    users.get('/:id', (req, res) => res.json({}))

    v1.use('/users', users)
    app.use('/api/v1', v1)

    const routes = extractRoutes(app)
    const paths = routes.map(r => r.path)

    expect(paths).toContain('/api/v1/users')
    expect(paths).toContain('/api/v1/users/:id')
  })

  test('returns empty array when no routes are registered', () => {
    const app = express()
    const routes = extractRoutes(app)
    expect(routes).toEqual([])
  })

  test('deduplicates routes extracted multiple times', () => {
    const app = makeApp(a => {
      a.get('/ping', (req, res) => res.json({ ok: true }))
    })

    // Extract twice — simulates the debounced re-extraction
    const first = extractRoutes(app)
    const second = extractRoutes(app)

    const pingRoutes = second.filter(r => r.method === 'GET' && r.path === '/ping')
    expect(pingRoutes).toHaveLength(1)
  })

  test('normalizes paths (no double slashes)', () => {
    const app = express()
    const router = express.Router()

    router.get('/health', (req, res) => res.json({ ok: true }))
    app.use('/', router) // This could naively produce //health

    const routes = extractRoutes(app)
    const health = routes.find(r => r.path.includes('health'))

    if (health) {
      expect(health.path).not.toContain('//')
    }
  })

  test('captures middleware names on routes', () => {
    const app = express()

    function authMiddleware(req, res, next) { next() }
    function getUsers(req, res) { res.json([]) }

    app.get('/users', authMiddleware, getUsers)

    const routes = extractRoutes(app)
    const usersRoute = routes.find(r => r.path === '/users' && r.method === 'GET')

    expect(usersRoute).toBeDefined()
    expect(usersRoute.middlewareNames).toContain('authMiddleware')
  })

  test('handles route parameters', () => {
    const app = makeApp(a => {
      a.get('/users/:id', (req, res) => res.json({}))
      a.get('/posts/:postId/comments/:commentId', (req, res) => res.json({}))
    })

    const routes = extractRoutes(app)
    const paths = routes.map(r => r.path)

    expect(paths).toContain('/users/:id')
    expect(paths).toContain('/posts/:postId/comments/:commentId')
  })

  test('extracts routes from a mounted sub-app (express())', () => {
    // When Express mounts a sub-app via app.use(), it wraps it in an internal
    // `mounted_app` closure — making the sub-app unreachable from the layer at
    // extraction time. patchApp tags the sub-app on the layer before the wrap,
    // which is how nodox handles this in production (nodox(app) applies the
    // patcher before any routes are registered).
    const app = express()
    patchApp(app, {})  // simulate nodox early-init

    const subApp = express()
    subApp.get('/orders', (req, res) => res.json([]))
    subApp.post('/orders', (req, res) => res.status(201).json({}))

    app.use('/shop', subApp)

    const routes = extractRoutes(app)
    const paths = routes.map(r => r.path)

    expect(paths).toContain('/shop/orders')
    expect(routes).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/shop/orders' })
    )
    expect(routes).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/shop/orders' })
    )
  })

  test('extracts routes from a nested sub-app within a router', () => {
    // router.use() does NOT wrap sub-apps — the sub-app is the layer handle directly.
    // This works without the patcher via the _router.stack fallback in walkStack.
    const app = express()
    const router = express.Router()
    const subApp = express()

    subApp.get('/items', (req, res) => res.json([]))

    router.use('/catalog', subApp)
    app.use('/v2', router)

    const routes = extractRoutes(app)
    const paths = routes.map(r => r.path)

    expect(paths).toContain('/v2/catalog/items')
  })
})

describe('checkExpressCompatibility', () => {
  test('returns compatible for a standard Express app', () => {
    const app = express()
    app.use(express.json()) // triggers router initialization
    const result = checkExpressCompatibility(app)
    expect(result.compatible).toBe(true)
  })

  test('returns incompatible for a non-Express object', () => {
    const fake = {}
    const result = checkExpressCompatibility(fake)
    expect(result.compatible).toBe(false)
    expect(result.warning).toBeDefined()
  })
})
