/**
 * Integration Tests — nodox middleware end-to-end
 *
 * Boots a real Express server with nodox attached and verifies:
 *   - All routes are discovered correctly
 *   - The UI is served at /__nodox
 *   - WebSocket delivers FULL_STATE_SYNC with route data
 *   - validate() schemas are picked up immediately
 *   - Server passes through all non-nodox requests unchanged
 */

import express from 'express'
import http from 'http'
import { WebSocket } from 'ws'
import nodox, { validate } from '../src/index.js'
import { z } from 'zod'

/**
 * Build a test Express app with nodox and a set of routes.
 * Returns the app + a started HTTP server.
 */
async function buildTestApp(routeSetup) {
  const app = express()
  app.use(express.json())
  app.use(nodox(app, { log: false }))

  if (routeSetup) routeSetup(app)

  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, resolve)) // port 0 = random free port

  // Wait for nodox's setTimeout(0) deferred extraction to run
  await new Promise(resolve => setTimeout(resolve, 100))

  return { app, server }
}

function getPort(server) {
  return server.address().port
}

function cleanup(server) {
  return new Promise(resolve => server.close(resolve))
}

// ── Route discovery tests ────────────────────────────────────────────────────

describe('route discovery via HTTP', () => {
  let server, app

  beforeAll(async () => {
    ({ app, server } = await buildTestApp(a => {
      a.get('/users', (req, res) => res.json([]))
      a.post('/users', (req, res) => res.status(201).json({}))
      a.get('/users/:id', (req, res) => res.json({}))
      a.delete('/users/:id', (req, res) => res.status(204).end())

      const router = express.Router()
      router.get('/products', (req, res) => res.json([]))
      router.post('/products', (req, res) => res.json({}))
      a.use('/api', router)
    }))
  })

  afterAll(() => cleanup(server))

  test('non-nodox routes still respond normally', async () => {
    const port = getPort(server)
    const res = await fetch(`http://localhost:${port}/users`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  test('/__nodox serves the UI (or placeholder)', async () => {
    const port = getPort(server)
    const res = await fetch(`http://localhost:${port}/__nodox`)
    expect(res.status).toBe(200)
    const text = await res.text()
    // Either the full UI or the placeholder — both are HTML
    expect(text).toContain('nodox')
  })

  test('404 routes still return 404', async () => {
    const port = getPort(server)
    const res = await fetch(`http://localhost:${port}/does-not-exist`)
    expect(res.status).toBe(404)
  })
})

// ── WebSocket state sync tests ────────────────────────────────────────────────

describe('WebSocket FULL_STATE_SYNC', () => {
  let server

  beforeAll(async () => {
    ({ server } = await buildTestApp(a => {
      a.get('/ping', (req, res) => res.json({ ok: true }))
      a.post('/data', (req, res) => res.json({}))
      a.put('/data/:id', (req, res) => res.json({}))
    }))
  })

  afterAll(() => cleanup(server))

  test('delivers FULL_STATE_SYNC with routes on connection', async () => {
    const port = getPort(server)

    // Make one HTTP request first so nodox's middleware runs and attaches WebSocket
    await fetch(`http://localhost:${port}/ping`)
    await new Promise(r => setTimeout(r, 50))

    const msg = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/__nodox_ws`)
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error('Timeout: no FULL_STATE_SYNC received'))
      }, 3000)

      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString())
        if (parsed.type === 'FULL_STATE_SYNC') {
          clearTimeout(timer)
          ws.close()
          resolve(parsed)
        }
      })

      ws.on('error', reject)
    })

    expect(msg.type).toBe('FULL_STATE_SYNC')
    expect(Array.isArray(msg.routes)).toBe(true)
    expect(msg.routes.length).toBeGreaterThan(0)
  })

  test('FULL_STATE_SYNC includes GET /ping route', async () => {
    const port = getPort(server)
    await fetch(`http://localhost:${port}/ping`)
    await new Promise(r => setTimeout(r, 50))

    const msg = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/__nodox_ws`)
      const timer = setTimeout(() => { ws.close(); reject(new Error('Timeout')) }, 3000)
      ws.on('message', data => {
        const parsed = JSON.parse(data.toString())
        if (parsed.type === 'FULL_STATE_SYNC') {
          clearTimeout(timer); ws.close(); resolve(parsed)
        }
      })
      ws.on('error', reject)
    })

    const pingRoute = msg.routes.find(r => r.method === 'GET' && r.path === '/ping')
    expect(pingRoute).toBeDefined()
  })

  test('FULL_STATE_SYNC includes all registered methods', async () => {
    const port = getPort(server)
    await fetch(`http://localhost:${port}/ping`)
    await new Promise(r => setTimeout(r, 50))

    const msg = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/__nodox_ws`)
      const timer = setTimeout(() => { ws.close(); reject(new Error('Timeout')) }, 3000)
      ws.on('message', data => {
        const parsed = JSON.parse(data.toString())
        if (parsed.type === 'FULL_STATE_SYNC') {
          clearTimeout(timer); ws.close(); resolve(parsed)
        }
      })
      ws.on('error', reject)
    })

    const methods = msg.routes.map(r => r.method)
    expect(methods).toContain('GET')
    expect(methods).toContain('POST')
    expect(methods).toContain('PUT')
  })
})

// ── validate() schema integration tests ──────────────────────────────────────

describe('validate() schema detection', () => {
  let server, app

  const createUserSchema = z.object({
    name: z.string(),
    email: z.string().email(),
    age: z.number().int().min(0),
  })

  beforeAll(async () => {
    ({ app, server } = await buildTestApp(a => {
      a.post('/users', validate(createUserSchema), (req, res) => {
        res.status(201).json(req.body)
      })
      a.get('/users', (req, res) => res.json([]))
    }))
  })

  afterAll(() => cleanup(server))

  test('validate() rejects invalid body with 400', async () => {
    const port = getPort(server)
    const res = await fetch(`http://localhost:${port}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'not-an-email', age: 30 }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Validation failed')
    expect(Array.isArray(body.details)).toBe(true)
  })

  test('validate() accepts valid body and passes to handler', async () => {
    const port = getPort(server)
    const res = await fetch(`http://localhost:${port}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'alice@example.com', age: 30 }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.name).toBe('Alice')
  })

  test('WebSocket reports POST /users has schema confirmed', async () => {
    const port = getPort(server)
    // Trigger middleware attach
    await fetch(`http://localhost:${port}/users`)
    await new Promise(r => setTimeout(r, 100))

    const msg = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/__nodox_ws`)
      const timer = setTimeout(() => { ws.close(); reject(new Error('Timeout')) }, 3000)
      ws.on('message', data => {
        const parsed = JSON.parse(data.toString())
        if (parsed.type === 'FULL_STATE_SYNC') {
          clearTimeout(timer); ws.close(); resolve(parsed)
        }
      })
      ws.on('error', reject)
    })

    const postUsers = msg.routes.find(r => r.method === 'POST' && r.path === '/users')
    expect(postUsers).toBeDefined()
    expect(postUsers.hasValidator).toBe(true)
    expect(postUsers.schema).toBeDefined()
    expect(postUsers.schema.input).toBeDefined()
    expect(postUsers.schema.inputConfidence).toBe('confirmed')
  })
})

// ── Middleware transparency test ──────────────────────────────────────────────

describe('middleware transparency', () => {
  let server

  beforeAll(async () => {
    ({ server } = await buildTestApp(a => {
      a.get('/hello', (req, res) => res.json({ message: 'hello world' }))
      a.post('/echo', (req, res) => res.json(req.body))
    }))
  })

  afterAll(() => cleanup(server))

  test('GET request passes through with correct response', async () => {
    const port = getPort(server)
    const res = await fetch(`http://localhost:${port}/hello`)
    const body = await res.json()
    expect(body.message).toBe('hello world')
  })

  test('POST request body is preserved', async () => {
    const port = getPort(server)
    const payload = { foo: 'bar', num: 42 }
    const res = await fetch(`http://localhost:${port}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json()
    expect(body).toEqual(payload)
  })

  test('response headers are not modified by nodox', async () => {
    const port = getPort(server)
    const res = await fetch(`http://localhost:${port}/hello`)
    // nodox should not inject any custom headers into user responses
    expect(res.headers.get('x-nodox')).toBeNull()
  })
})
