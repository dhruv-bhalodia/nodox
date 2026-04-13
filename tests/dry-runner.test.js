/**
 * Dry Runner Tests — Layer 3
 * Tests the infinite proxy + schema interception mechanism.
 */

import { z } from 'zod'
import { createInfiniteProxy, dryRunValidator, registerForDryRun, _schemaRegistryArray } from '../src/schema/dry-runner.js'

// Helper: register a schema manually (normally done by module patcher)
function withRegistered(schema, meta, fn) {
  registerForDryRun(schema, meta)
  return fn()
}

describe('createInfiniteProxy', () => {
  test('returns undefined for promise-related props (prevents Promise wrapping)', () => {
    const proxy = createInfiniteProxy()
    expect(proxy.then).toBeUndefined()
    expect(proxy.catch).toBeUndefined()
    expect(proxy.finally).toBeUndefined()
  })

  test('returns undefined for Symbol props', () => {
    const proxy = createInfiniteProxy()
    expect(proxy[Symbol.iterator]).toBeUndefined()
  })

  test('serves override values correctly', () => {
    const proxy = createInfiniteProxy({ method: 'POST', body: { id: 1 } })
    expect(proxy.method).toBe('POST')
    expect(proxy.body).toEqual({ id: 1 })
  })

  test('any unknown property returns another proxy (not undefined)', () => {
    const proxy = createInfiniteProxy()
    const nested = proxy.someUnknownProp
    expect(nested).toBeDefined()
    expect(typeof nested).toBe('function') // proxies are function-based
  })

  test('is callable without throwing', () => {
    const proxy = createInfiniteProxy()
    expect(() => proxy()).not.toThrow()
  })

  test('deep chaining does not throw', () => {
    const proxy = createInfiniteProxy()
    expect(() => proxy.a.b.c.d.e.f()).not.toThrow()
  })
})

describe('dryRunValidator', () => {
  test('detects Zod schema used inside a middleware function', async () => {
    const schema = z.object({ name: z.string(), age: z.number() })
    registerForDryRun(schema, { type: 'zod' })

    function myValidator(req, res, next) {
      const result = schema.safeParse(req.body)
      if (!result.success) return res.status(400).json({})
      req.body = result.data
      next()
    }

    const result = await dryRunValidator(myValidator, 'POST')
    expect(result.schema).toBe(schema)
    expect(result.library).toBe('zod')
  })

  test('blocks side effects (network and fs) during dry-run', async () => {
    const fs = (await import('fs')).default || await import('fs')
    const http = (await import('http')).default || await import('http')
    
    let fsCalled = false
    let httpCalled = false

    const schema = z.object({ name: z.string() })
    registerForDryRun(schema, { type: 'zod' })

    const handler = (req, res, next) => {
      // validator is called first
      schema.parse(req.body)

      // These should be blocked and the function should have aborted before reaching them
      try {
        fs.writeFileSync('test_nodox_temp.txt', 'hello')
        fsCalled = true
      } catch {}

      try {
        http.request('http://localhost:8080')
        httpCalled = true
      } catch {}
    }

    const result = await dryRunValidator(handler)
    
    expect(result.schema).toBe(schema)
    expect(fsCalled).toBe(false)
    expect(httpCalled).toBe(false)
  })

  test('blocks child processes during dry-run', async () => {
    const cp = (await import('child_process')).default || await import('child_process')
    let cpCalled = false

    const handler = (req, res, next) => {
      try {
        cp.execSync('ls')
        cpCalled = true
      } catch {}
      
      const schema = z.object({ id: z.string() })
      registerForDryRun(schema, { type: 'zod' })
      schema.parse(req.body)
    }

    await dryRunValidator(handler)
    expect(cpCalled).toBe(false)
  })

  test('blocks side effects even if they happen BEFORE validation', async () => {
    const fs = (await import('fs')).default || await import('fs')
    let fsCalled = false

    const handler = (req, res, next) => {
      // Side effect BEFORE validation
      try {
        fs.writeFileSync('test_nodox_temp_2.txt', 'hello')
        fsCalled = true
      } catch (e) {
        // console.log('--- Blocked as expected:', e.message)
      }
      
      const schema = z.object({ age: z.number() })
      registerForDryRun(schema, { type: 'zod' })
      schema.parse(req.body)
    }

    await dryRunValidator(handler)
    expect(fsCalled).toBe(false)
  })

  test('detects schema used via .parse() (throws on failure — caught internally)', async () => {
    const schema = z.object({ id: z.number() })
    registerForDryRun(schema, { type: 'zod' })

    function strictValidator(req, res, next) {
      req.body = schema.parse(req.body) // throws on invalid — we catch it
      next()
    }

    const result = await dryRunValidator(strictValidator, 'POST')
    expect(result.schema).toBe(schema)
  })

  test('returns null schema when no validator is invoked', async () => {
    function plainHandler(req, res, next) {
      req.user = { id: 1 }
      next()
    }

    const result = await dryRunValidator(plainHandler, 'GET')
    expect(result.schema).toBeNull()
    expect(result.library).toBeNull()
  })

  test('does not crash if middleware throws during dry run', async () => {
    function explosiveMiddleware(req, res, next) {
      throw new Error('something unexpected')
    }

    await expect(dryRunValidator(explosiveMiddleware, 'POST')).resolves.toBeDefined()
    const result = await dryRunValidator(explosiveMiddleware, 'POST')
    expect(result.schema).toBeNull()
  })

  test('restores schema parse methods after dry run', async () => {
    const schema = z.object({ x: z.string() })
    registerForDryRun(schema, { type: 'zod' })

    function validator(req, res, next) {
      schema.safeParse(req.body)
      next()
    }

    await dryRunValidator(validator, 'POST')

    // After dry run, schema should still work normally
    const result = schema.safeParse({ x: 'hello' })
    expect(result.success).toBe(true)
  })

  test('detects first schema in a multi-schema middleware', async () => {
    const schemaA = z.object({ a: z.string() })
    const schemaB = z.object({ b: z.number() })
    registerForDryRun(schemaA, { type: 'zod' })
    registerForDryRun(schemaB, { type: 'zod' })

    function multiValidator(req, res, next) {
      // Uses schemaA first
      const r = schemaA.safeParse(req.body)
      if (r.success) schemaB.safeParse(r.data)
      next()
    }

    const result = await dryRunValidator(multiValidator, 'POST')
    expect(result.schema).toBe(schemaA)
  })

  test('captures ZodError from uncaught schema.parse() — enables schema reconstruction', async () => {
    const unregisteredSchema = z.object({ email: z.string(), age: z.number() })

    function handler(req, res, next) {
      req.body = unregisteredSchema.parse(req.body)
      next()
    }

    const result = await dryRunValidator(handler, 'POST')
    expect(result.schema).toBeNull()
    expect(result.zodError).not.toBeNull()
  })

  test('detects async validator that validates before first real I/O (Promise.resolve chain)', async () => {
    const schema = z.object({ name: z.string() })
    registerForDryRun(schema, { type: 'zod' })

    async function asyncValidator(req, res, next) {
      await Promise.resolve()
      const result = schema.safeParse(req.body)
      if (!result.success) return res.status(400).json({})
      next()
    }

    const result = await dryRunValidator(asyncValidator, 'POST')
    expect(result.schema).toBe(schema)
  })
})
