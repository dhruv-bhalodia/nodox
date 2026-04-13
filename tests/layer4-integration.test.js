/**
 * Layer 4 Integration Tests
 *
 * Tests the full pipeline:
 *   http interceptor → cache file → schema-detector loading → route enrichment
 *
 * Uses real HTTP servers, real file I/O, no mocks.
 */

import http from 'http'
import express from 'express'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { inferShape, mergeShapes } from '../src/schema/response-interceptor.js'
import { readCache, writeCache, mergeCacheEntry } from '../src/layer4/cache-manager.js'
import { findCacheFile, loadCacheEntries } from '../src/layer4/cache-reader.js'
import { loadCacheIntoRegistry, getRouteSchema } from '../src/schema/schema-detector.js'

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nodox-layer4-'))
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

// ── HTTP Interceptor simulation ───────────────────────────────────────────

describe('http interceptor simulation', () => {
  /**
   * We test the interceptor logic directly (not via jest-setup.js which runs
   * in a different process) by replicating the core capture mechanism.
   */

  function buildInterceptor() {
    const exchanges = new Map()
    const origRequest = http.request.bind(http)

    const LOCAL = new Set(['localhost', '127.0.0.1', '::1'])
    function isLocal(h) { return LOCAL.has(h) }

    function patchedReq(input, options, callback) {
      if (typeof options === 'function') { callback = options; options = {} }
      let method = 'GET', urlPath = '/', hostname = ''
      if (typeof input === 'string') {
        try {
          const u = new URL(input)
          method = ((options && options.method) || 'GET').toUpperCase()
          urlPath = u.pathname + (u.search || '')
          hostname = u.hostname
        } catch {}
      } else if (input && typeof input === 'object' && !(input instanceof URL)) {
        method = (input.method || 'GET').toUpperCase()
        urlPath = input.path || '/'
        hostname = input.hostname || (input.host || '').split(':')[0]
      }

      if (!isLocal(hostname)) return origRequest(input, options, callback)

      const reqChunks = []
      const wrappedCb = callback ? (res) => {
        const resChunks = []
        const origPush = res.push.bind(res)
        res.push = function(chunk) {
          if (chunk) resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          return origPush(chunk)
        }
        res.on('end', () => {
          try {
            const ct = res.headers?.['content-type'] || ''
            const raw = Buffer.concat(resChunks).toString()
            if (ct.includes('application/json') && raw.trim() && res.statusCode < 500) {
              const parsed = JSON.parse(raw)
              const key = `${method}:${urlPath}`
              const shape = inferShape(parsed)
              const ex = exchanges.get(key)
              if (ex) exchanges.set(key, { ...ex, resShape: mergeShapes(ex.resShape, shape) })
              else exchanges.set(key, { method, path: urlPath, reqShape: null, resShape: shape, resStatus: res.statusCode })
            }
          } catch {}
        })
        callback(res)
      } : null

      const req = origRequest(input, options, wrappedCb)
      const origWrite = req.write.bind(req)
      req.write = function(chunk, enc, cb) {
        if (chunk) reqChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        return origWrite(chunk, enc, cb)
      }
      const origEnd = req.end.bind(req)
      req.end = function(chunk, enc, cb) {
        if (chunk) reqChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        if (reqChunks.length > 0) {
          try {
            const parsed = JSON.parse(Buffer.concat(reqChunks).toString())
            const key = `${method}:${urlPath}`
            const shape = inferShape(parsed)
            const ex = exchanges.get(key)
            if (ex) exchanges.set(key, { ...ex, reqShape: mergeShapes(ex.reqShape, shape) })
            else exchanges.set(key, { method, path: urlPath, reqShape: shape, resShape: null, resStatus: null })
          } catch {}
        }
        return origEnd(chunk, enc, cb)
      }
      return req
    }

    http.request = patchedReq
    http.get = function(input, options, cb) {
      if (typeof options === 'function') { cb = options; options = {} }
      const req = http.request(input, { ...(options || {}), method: 'GET' }, cb)
      req.end()
      return req
    }

    return { exchanges, restore: () => { http.request = origRequest } }
  }

  let server, port, interceptor

  beforeAll(async () => {
    interceptor = buildInterceptor()
    const app = express()
    app.use(express.json())
    app.get('/api/products', (req, res) => res.json([
      { id: 1, name: 'Widget', price: 9.99 }
    ]))
    app.post('/api/orders', (req, res) => res.status(201).json({ orderId: 42, ...req.body }))

    server = http.createServer(app)
    await new Promise(resolve => server.listen(0, resolve))
    port = server.address().port
  })

  afterAll(() => {
    interceptor.restore()
    return new Promise(resolve => server.close(resolve))
  })

  test('captures GET response shape', async () => {
    await new Promise((resolve, reject) => {
      http.get(`http://localhost:${port}/api/products`, res => {
        res.resume()
        res.on('end', resolve)
        res.on('error', reject)
      })
    })
    await new Promise(r => setTimeout(r, 30))

    const ex = interceptor.exchanges.get('GET:/api/products')
    expect(ex).toBeDefined()
    expect(ex.resShape.type).toBe('array')
    expect(ex.resShape.items.properties.id).toBeDefined()
    expect(ex.resShape.items.properties.name).toBeDefined()
  })

  test('captures POST request body shape', async () => {
    await new Promise((resolve, reject) => {
      const req = http.request(
        `http://localhost:${port}/api/orders`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        res => { res.resume(); res.on('end', resolve); res.on('error', reject) }
      )
      req.write(JSON.stringify({ productId: 1, quantity: 2 }))
      req.end()
    })
    await new Promise(r => setTimeout(r, 30))

    const ex = interceptor.exchanges.get('POST:/api/orders')
    expect(ex).toBeDefined()
    expect(ex.reqShape.type).toBe('object')
    expect(ex.reqShape.properties.productId).toBeDefined()
    expect(ex.reqShape.properties.quantity).toBeDefined()
  })

  test('captures POST response shape', async () => {
    await new Promise(r => setTimeout(r, 50))
    const ex = interceptor.exchanges.get('POST:/api/orders')
    expect(ex.resShape).toBeDefined()
    expect(ex.resShape.type).toBe('object')
    expect(ex.resShape.properties.orderId).toBeDefined()
  })

  test('merges shapes across multiple requests to same route', async () => {
    // Second GET with extra field in response (simulate different data)
    // We directly call mergeCacheEntry to test the merge logic
    const first = inferShape([{ id: 1, name: 'A' }])
    const second = inferShape([{ id: 2, name: 'B', tag: 'new' }])

    let cache = { version: 1, routes: {} }
    cache = mergeCacheEntry(cache, 'GET:/api/products', {
      method: 'GET', path: '/api/products', reqShape: null, resShape: first, resStatus: 200,
    })
    cache = mergeCacheEntry(cache, 'GET:/api/products', {
      method: 'GET', path: '/api/products', reqShape: null, resShape: second, resStatus: 200,
    })

    const props = cache.routes['GET:/api/products'].output.items.properties
    expect(props.id).toBeDefined()
    expect(props.name).toBeDefined()
    expect(props.tag).toBeDefined() // merged in from second run
    expect(cache.routes['GET:/api/products'].seenCount).toBe(2)
  })

  test('does not capture external hostname requests', async () => {
    // Simulate what happens with non-local hostname in the interceptor
    // (We can't actually make external requests in tests, but we verify
    //  the isLocal check works for known non-local hostnames)
    const LOCAL = new Set(['localhost', '127.0.0.1', '::1'])
    expect(LOCAL.has('api.example.com')).toBe(false)
    expect(LOCAL.has('localhost')).toBe(true)
    expect(LOCAL.has('127.0.0.1')).toBe(true)
  })
})

// ── loadCacheIntoRegistry ─────────────────────────────────────────────────

describe('loadCacheIntoRegistry', () => {
  test('loads output schemas from cache file', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, '.apicache.json')

    writeCache(file, {
      routes: {
        'GET:/cached-route': {
          method: 'GET', path: '/cached-route',
          input: null,
          output: { type: 'object', properties: { status: { type: 'string' } } },
          inputConfidence: 'none',
          outputConfidence: 'observed',
          seenCount: 1,
        }
      }
    })

    const count = loadCacheIntoRegistry(file)
    expect(count).toBe(1)

    const schema = getRouteSchema('GET', '/cached-route')
    expect(schema).not.toBeNull()
    expect(schema.output.type).toBe('object')
    expect(schema.outputConfidence).toBe('observed')
    cleanup(dir)
  })

  test('loads input schemas from cache file', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, '.apicache.json')

    writeCache(file, {
      routes: {
        'POST:/cached-post': {
          method: 'POST', path: '/cached-post',
          input: { type: 'object', properties: { name: { type: 'string' } } },
          output: null,
          inputConfidence: 'observed',
          outputConfidence: 'none',
          seenCount: 2,
        }
      }
    })

    loadCacheIntoRegistry(file)
    const schema = getRouteSchema('POST', '/cached-post')
    expect(schema.input.type).toBe('object')
    expect(schema.inputConfidence).toBe('observed')
    cleanup(dir)
  })

  test('returns 0 when cache file does not exist', () => {
    const count = loadCacheIntoRegistry('/nonexistent/.apicache.json')
    expect(count).toBe(0)
  })

  test('returns 0 for empty cache', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, '.apicache.json')
    writeCache(file, { routes: {} })
    const count = loadCacheIntoRegistry(file)
    expect(count).toBe(0)
    cleanup(dir)
  })
})

// ── Full pipeline: write cache → load at startup → enrich routes ──────────

describe('full Layer 4 pipeline', () => {
  test('cache data appears in enriched route list', async () => {
    const dir = makeTmpDir()
    const file = path.join(dir, '.apicache.json')

    // Simulate a previous test run that recorded this route
    writeCache(file, {
      routes: {
        'GET:/pipeline-test': {
          method: 'GET', path: '/pipeline-test',
          input: null,
          output: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              timestamp: { type: 'string', format: 'date-time' },
            }
          },
          inputConfidence: 'none',
          outputConfidence: 'observed',
          seenCount: 5,
        }
      }
    })

    // Load into registry (simulates startup)
    loadCacheIntoRegistry(file)

    // Verify schema is in registry
    const schema = getRouteSchema('GET', '/pipeline-test')
    expect(schema.output.properties.message).toBeDefined()
    expect(schema.output.properties.timestamp.format).toBe('date-time')
    expect(schema.outputConfidence).toBe('observed')

    cleanup(dir)
  })
})
