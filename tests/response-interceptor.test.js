/**
 * Response Interceptor Tests — Layer 5
 * Tests shape inference and shape merging logic.
 */

import { inferShape, mergeShapes, createResponseInterceptor } from '../src/schema/response-interceptor.js'

describe('inferShape', () => {
  test('infers null', () => {
    expect(inferShape(null)).toEqual({ type: 'null' })
  })

  test('infers boolean', () => {
    expect(inferShape(true)).toEqual({ type: 'boolean' })
    expect(inferShape(false)).toEqual({ type: 'boolean' })
  })

  test('infers integer vs number', () => {
    expect(inferShape(42)).toEqual({ type: 'integer' })
    expect(inferShape(3.14)).toEqual({ type: 'number' })
  })

  test('infers plain string', () => {
    expect(inferShape('hello')).toEqual({ type: 'string' })
  })

  test('infers date-time string format', () => {
    expect(inferShape('2024-01-15T10:30:00Z')).toMatchObject({ type: 'string', format: 'date-time' })
  })

  test('infers date string format', () => {
    expect(inferShape('2024-01-15')).toMatchObject({ type: 'string', format: 'date' })
  })

  test('infers uuid string format', () => {
    expect(inferShape('550e8400-e29b-41d4-a716-446655440000')).toMatchObject({ type: 'string', format: 'uuid' })
  })

  test('infers uri string format', () => {
    expect(inferShape('https://example.com/api')).toMatchObject({ type: 'string', format: 'uri' })
  })

  test('infers empty array', () => {
    expect(inferShape([])).toMatchObject({ type: 'array' })
  })

  test('infers array with typed items', () => {
    const shape = inferShape([{ id: 1, name: 'Alice' }])
    expect(shape.type).toBe('array')
    expect(shape.items.type).toBe('object')
    expect(shape.items.properties.id).toMatchObject({ type: 'integer' })
    expect(shape.items.properties.name).toMatchObject({ type: 'string' })
  })

  test('infers object with nested fields', () => {
    const shape = inferShape({ id: 1, user: { name: 'Alice', email: 'alice@example.com' } })
    expect(shape.type).toBe('object')
    expect(shape.properties.id).toMatchObject({ type: 'integer' })
    expect(shape.properties.user.type).toBe('object')
    expect(shape.properties.user.properties.name).toMatchObject({ type: 'string' })
  })

  test('caps recursion depth at 8', () => {
    // Build deeply nested object
    let obj = { value: 1 }
    for (let i = 0; i < 12; i++) { obj = { nested: obj } }
    // Should not throw or recurse infinitely
    expect(() => inferShape(obj)).not.toThrow()
  })

  test('caps object fields at 50', () => {
    const bigObj = {}
    for (let i = 0; i < 60; i++) bigObj[`field${i}`] = i
    const shape = inferShape(bigObj)
    expect(Object.keys(shape.properties)).toHaveLength(50)
    expect(shape.description).toContain('50 of 60')
  })
})

describe('mergeShapes', () => {
  test('merges two object shapes — union of all fields', () => {
    const a = { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } }
    const b = { type: 'object', properties: { id: { type: 'integer' }, email: { type: 'string' } } }
    const merged = mergeShapes(a, b)
    expect(merged.type).toBe('object')
    expect(merged.properties.id).toBeDefined()
    expect(merged.properties.name).toBeDefined()
    expect(merged.properties.email).toBeDefined()
  })

  test('integer + number merges to number', () => {
    const a = { type: 'integer' }
    const b = { type: 'number' }
    expect(mergeShapes(a, b)).toEqual({ type: 'number' })
    expect(mergeShapes(b, a)).toEqual({ type: 'number' })
  })

  test('conflicting types produce anyOf', () => {
    const a = { type: 'string' }
    const b = { type: 'integer' }
    const merged = mergeShapes(a, b)
    expect(merged.anyOf).toBeDefined()
    expect(merged.anyOf).toHaveLength(2)
  })

  test('handles null inputs gracefully', () => {
    const a = { type: 'string' }
    expect(mergeShapes(null, a)).toEqual(a)
    expect(mergeShapes(a, null)).toEqual(a)
  })

  test('merges nested array items', () => {
    const a = { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } }
    const b = { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } }
    const merged = mergeShapes(a, b)
    expect(merged.type).toBe('array')
    expect(merged.items.properties.id).toBeDefined()
    expect(merged.items.properties.name).toBeDefined()
  })
})

describe('createResponseInterceptor', () => {
  test('calls onResponseShape when res.json() is called with matched route', () => {
    const shapes = []
    const interceptor = createResponseInterceptor({
      onResponseShape(method, path, shape, confidence) {
        shapes.push({ method, path, shape, confidence })
      }
    })

    const req = { method: 'GET', route: { path: '/users' } }
    const res = {
      json: (body) => body, // original json
    }
    const next = () => {}

    interceptor(req, res, next)
    res.json([{ id: 1, name: 'Alice' }])

    expect(shapes).toHaveLength(1)
    expect(shapes[0].method).toBe('GET')
    expect(shapes[0].path).toBe('/users')
    expect(shapes[0].shape.type).toBe('array')
    expect(shapes[0].confidence).toBe('observed')
  })

  test('correctly prepends req.baseUrl for mounted routers', () => {
    const shapes = []
    const interceptor = createResponseInterceptor({
      onResponseShape(method, path, shape) { shapes.push({ method, path, shape }) }
    })

    const req = {
      method: 'GET',
      baseUrl: '/api',
      route: { path: '/users' }
    }
    const res = { json: (body) => body }
    interceptor(req, res, () => {})
    res.json([])

    expect(shapes).toHaveLength(1)
    expect(shapes[0].path).toBe('/api/users')
  })

  test('skips wildcard routes', () => {
    const shapes = []
    const interceptor = createResponseInterceptor({
      onResponseShape(method, path, shape) { shapes.push({ method, path, shape }) }
    })

    const req = { method: 'GET', route: { path: '*' } }
    const res = { json: (body) => body }
    interceptor(req, res, () => {})
    res.json({ error: '404' })

    expect(shapes).toHaveLength(0)
  })

  test('skips nodox internal routes', () => {
    const shapes = []
    const interceptor = createResponseInterceptor({
      onResponseShape(method, path, shape) { shapes.push({ method, path, shape }) }
    })

    const req = { method: 'GET', route: { path: '/__nodox' } }
    const res = { json: (body) => body }
    interceptor(req, res, () => {})
    res.json({})

    expect(shapes).toHaveLength(0)
  })

  test('skips when req.route is null (unmatched request)', () => {
    const shapes = []
    const interceptor = createResponseInterceptor({
      onResponseShape(method, path, shape) { shapes.push({ method, path, shape }) }
    })

    const req = { method: 'GET', route: null }
    const res = { json: (body) => body }
    interceptor(req, res, () => {})
    res.json({ error: 'Not found' })

    expect(shapes).toHaveLength(0)
  })

  test('original res.json() return value is preserved', () => {
    const interceptor = createResponseInterceptor({ onResponseShape: () => {} })
    const expected = { sent: true }
    const req = { method: 'POST', route: { path: '/items' } }
    const res = { json: () => expected }
    interceptor(req, res, () => {})
    const result = res.json({ id: 1 })
    expect(result).toBe(expected)
  })

  test('observes req.body for POST routes and calls onRequestBodyShape', () => {
    const observed = []
    const interceptor = createResponseInterceptor({
      onResponseShape() {},
      onRequestBodyShape(method, path, shape) { observed.push({ method, path, shape }) }
    })

    const req = {
      method: 'POST',
      route: { path: '/users' },
      body: { name: 'Alice', age: 30 }
    }
    const res = { json: () => {} }
    interceptor(req, res, () => {})
    res.json({ id: 1 })

    expect(observed).toHaveLength(1)
    expect(observed[0].method).toBe('POST')
    expect(observed[0].path).toBe('/users')
    expect(observed[0].shape.properties.name).toBeDefined()
  })

  test('observes req.query for GET routes and calls onRequestQueryShape', () => {
    const observed = []
    const interceptor = createResponseInterceptor({
      onResponseShape() {},
      onRequestQueryShape(method, path, shape) { observed.push({ method, path, shape }) }
    })

    const req = {
      method: 'GET',
      route: { path: '/users' },
      query: { page: '1', limit: '10', search: 'alice' }
    }
    const res = { json: () => {} }
    interceptor(req, res, () => {})
    res.json([])

    expect(observed).toHaveLength(1)
    expect(observed[0].method).toBe('GET')
    expect(observed[0].path).toBe('/users')
    expect(observed[0].shape.type).toBe('object')
    expect(observed[0].shape.properties.page).toBeDefined()
    expect(observed[0].shape.properties.limit).toBeDefined()
  })

  test('does NOT call onRequestQueryShape for empty query strings', () => {
    const observed = []
    const interceptor = createResponseInterceptor({
      onResponseShape() {},
      onRequestQueryShape() { observed.push(true) }
    })

    const req = { method: 'GET', route: { path: '/users' }, query: {} }
    const res = { json: () => {} }
    interceptor(req, res, () => {})
    res.json([])

    expect(observed).toHaveLength(0)
  })

  test('does NOT call onRequestQueryShape for POST routes (use body instead)', () => {
    const observed = []
    const interceptor = createResponseInterceptor({
      onResponseShape() {},
      onRequestQueryShape() { observed.push(true) }
    })

    const req = {
      method: 'POST',
      route: { path: '/users' },
      query: { format: 'json' },
      body: { name: 'Alice' }
    }
    const res = { json: () => {} }
    interceptor(req, res, () => {})
    res.json({ id: 1 })

    expect(observed).toHaveLength(0)
  })
})

describe('createResponseInterceptor — request body observation', () => {
  test('calls onRequestBodyShape for POST with a non-empty body', () => {
    const reqShapes = []
    const interceptor = createResponseInterceptor({
      onRequestBodyShape(method, path, shape) { reqShapes.push({ method, path, shape }) },
      onResponseShape: () => {},
    })

    const req = { method: 'POST', route: { path: '/users' }, body: { name: 'Alice', age: 30 } }
    const res = { json: (b) => b }
    interceptor(req, res, () => {})
    res.json({ id: 1 })

    expect(reqShapes).toHaveLength(1)
    expect(reqShapes[0].method).toBe('POST')
    expect(reqShapes[0].path).toBe('/users')
    expect(reqShapes[0].shape.type).toBe('object')
    expect(reqShapes[0].shape.properties.name).toMatchObject({ type: 'string' })
  })

  test('skips request body observation for GET (no body methods)', () => {
    const reqShapes = []
    const interceptor = createResponseInterceptor({
      onRequestBodyShape(method, path, shape) { reqShapes.push({ method, path, shape }) },
      onResponseShape: () => {},
    })

    const req = { method: 'GET', route: { path: '/users' }, body: { something: 'odd' } }
    const res = { json: (b) => b }
    interceptor(req, res, () => {})
    res.json([])

    expect(reqShapes).toHaveLength(0)
  })

  test('skips request body observation when body is empty', () => {
    const reqShapes = []
    const interceptor = createResponseInterceptor({
      onRequestBodyShape(method, path, shape) { reqShapes.push({ method, path, shape }) },
      onResponseShape: () => {},
    })

    const req = { method: 'POST', route: { path: '/users' }, body: {} }
    const res = { json: (b) => b }
    interceptor(req, res, () => {})
    res.json({ error: 'missing fields' })

    expect(reqShapes).toHaveLength(0)
  })

  test('works without onRequestBodyShape option (backward compat)', () => {
    const interceptor = createResponseInterceptor({ onResponseShape: () => {} })
    const req = { method: 'POST', route: { path: '/users' }, body: { name: 'test' } }
    const res = { json: (b) => b }
    expect(() => {
      interceptor(req, res, () => {})
      res.json({ ok: true })
    }).not.toThrow()
  })
})

describe('createResponseInterceptor — Zod/Joi schema detection via parsedValueToSchema', () => {
  test('uses known schema with inferred confidence when body is in parsedValueToSchema', () => {
    const knownSchema = { type: 'object', properties: { id: { type: 'integer' } } }
    const parsedValueToSchema = new WeakMap()
    const body = { id: 1 }
    parsedValueToSchema.set(body, knownSchema)

    const shapes = []
    const interceptor = createResponseInterceptor({
      parsedValueToSchema,
      onResponseShape(method, path, shape, confidence) {
        shapes.push({ shape, confidence })
      }
    })

    const req = { method: 'GET', route: { path: '/users/:id' } }
    const res = { json: (b) => b }
    interceptor(req, res, () => {})
    res.json(body)

    expect(shapes).toHaveLength(1)
    expect(shapes[0].shape).toBe(knownSchema)
    expect(shapes[0].confidence).toBe('inferred')
  })

  test('falls back to inferShape with observed confidence when body is not tagged', () => {
    const parsedValueToSchema = new WeakMap()
    const shapes = []
    const interceptor = createResponseInterceptor({
      parsedValueToSchema,
      onResponseShape(method, path, shape, confidence) {
        shapes.push({ shape, confidence })
      }
    })

    const req = { method: 'GET', route: { path: '/users' } }
    const res = { json: (b) => b }
    interceptor(req, res, () => {})
    res.json({ id: 1, name: 'Alice' })

    expect(shapes).toHaveLength(1)
    expect(shapes[0].confidence).toBe('observed')
    expect(shapes[0].shape.type).toBe('object')
    expect(shapes[0].shape.properties.id).toBeDefined()
  })

  test('primitives (non-object bodies) are not looked up in WeakMap — fall back to inferShape', () => {
    const parsedValueToSchema = new WeakMap()
    const shapes = []
    const interceptor = createResponseInterceptor({
      parsedValueToSchema,
      onResponseShape(method, path, shape, confidence) {
        shapes.push({ shape, confidence })
      }
    })

    const req = { method: 'GET', route: { path: '/count' } }
    const res = { json: (b) => b }
    interceptor(req, res, () => {})
    res.json(42)

    expect(shapes).toHaveLength(1)
    expect(shapes[0].confidence).toBe('observed')
    expect(shapes[0].shape).toEqual({ type: 'integer' })
  })

  test('works without parsedValueToSchema option (backward compat)', () => {
    const shapes = []
    const interceptor = createResponseInterceptor({
      onResponseShape(method, path, shape, confidence) {
        shapes.push({ shape, confidence })
      }
    })

    const req = { method: 'GET', route: { path: '/users' } }
    const res = { json: (b) => b }
    interceptor(req, res, () => {})
    res.json({ id: 1 })

    expect(shapes).toHaveLength(1)
    expect(shapes[0].confidence).toBe('observed')
  })
})
