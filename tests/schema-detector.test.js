/**
 * Schema Detector Tests
 *
 * Covers: prototype-level Zod tracking (chained schemas), onInputObserved
 * confidence ordering, yup mock detection, and async parse tracking.
 */

import { z } from 'zod'
import {
  parsedValueToSchema,
  onInputObserved,
  onResponseObserved,
  onQueryObserved,
  getRouteSchema,
  patchZodWithRegistry,
  tagParsedValue,
  wasRouteRegistered,
  onRouteRegistered,
} from '../src/schema/schema-detector.js'
import { toJsonSchema } from '../src/schema/validate.js'

// ─── tagParsedValue — core output-tracking primitive ──────────────────────

describe('tagParsedValue', () => {
  test('stores JSON Schema in parsedValueToSchema for object values', () => {
    const schema = z.object({ name: z.string() })
    const data = { name: 'Alice' }

    tagParsedValue(data, schema, 'zod')

    expect(parsedValueToSchema.has(data)).toBe(true)
    const stored = parsedValueToSchema.get(data)
    expect(stored.type).toBe('object')
    expect(stored.properties?.name).toBeDefined()
  })

  test('caches JSON Schema per schema instance on repeated calls', () => {
    const schema = z.object({ a: z.string() })
    const d1 = { a: 'x' }
    const d2 = { a: 'y' }

    tagParsedValue(d1, schema, 'zod')
    tagParsedValue(d2, schema, 'zod')

    // Both should point to the same cached JSON Schema object
    expect(parsedValueToSchema.get(d1)).toBe(parsedValueToSchema.get(d2))
  })

  test('silently ignores primitive values (not valid WeakMap keys)', () => {
    const schema = z.string()
    expect(() => tagParsedValue('hello', schema, 'zod')).not.toThrow()
    expect(() => tagParsedValue(42, schema, 'zod')).not.toThrow()
    expect(() => tagParsedValue(null, schema, 'zod')).not.toThrow()
  })
})

// ─── Zod per-instance output tracking ─────────────────────────────────────
// Note: Zod v4 uses a Module Namespace Object for `z` exports, which cannot
// be monkey-patched. Per-instance patching requires intercepting factory methods.
// In production, index.js patches z via async import('zod') at startup.
// Here we test per-instance patching directly on a mutable fake z.

describe('Zod per-instance output tracking via patchable z wrapper', () => {
  // Create a mutable wrapper so factory methods can be patched
  const fakeZ = Object.fromEntries(
    Object.getOwnPropertyNames(z)
      .filter(k => typeof z[k] === 'function')
      .map(k => [k, z[k].bind(z)])
  )
  patchZodWithRegistry(fakeZ)

  test('tags result of fakeZ.object().parse() in parsedValueToSchema', () => {
    const schema = fakeZ.object({ name: fakeZ.string() })
    const data = schema.parse({ name: 'Alice' })
    expect(parsedValueToSchema.has(data)).toBe(true)
    expect(parsedValueToSchema.get(data)?.type).toBe('object')
  })

  test('tags result of fakeZ.object().safeParse() data', () => {
    const schema = fakeZ.object({ id: fakeZ.number() })
    const result = schema.safeParse({ id: 42 })
    expect(result.success).toBe(true)
    expect(parsedValueToSchema.has(result.data)).toBe(true)
  })

  test('does not tag failed safeParse results', () => {
    const schema = fakeZ.object({ name: fakeZ.string() })
    const result = schema.safeParse({ name: 123 })
    expect(result.success).toBe(false)
    expect(parsedValueToSchema.has(result)).toBe(false)
  })

  test('caches JSON Schema per schema instance across multiple parse calls', () => {
    const schema = fakeZ.object({ a: fakeZ.string(), b: fakeZ.number() })
    const d1 = schema.parse({ a: 'x', b: 1 })
    const d2 = schema.parse({ a: 'y', b: 2 })
    expect(parsedValueToSchema.get(d1)).toBe(parsedValueToSchema.get(d2)) // same ref = cached
  })
})

// ─── onInputObserved confidence ordering ──────────────────────────────────

describe('onInputObserved', () => {
  const METHOD = 'POST'
  const PATH = '/test-input-observed-' + Date.now()

  test('sets input schema when none exists', () => {
    const shape = { type: 'object', properties: { name: { type: 'string' } } }
    onInputObserved(METHOD, PATH, shape)
    const entry = getRouteSchema(METHOD, PATH)
    expect(entry.input).toEqual(shape)
    expect(entry.inputConfidence).toBe('observed')
  })

  test('does not overwrite existing observed schema (same confidence)', () => {
    const path = '/test-no-overwrite-' + Date.now()
    const shape1 = { type: 'object', properties: { a: { type: 'string' } } }
    const shape2 = { type: 'object', properties: { b: { type: 'number' } } }
    onInputObserved(METHOD, path, shape1)
    onInputObserved(METHOD, path, shape2) // same confidence → no overwrite
    expect(getRouteSchema(METHOD, path).input).toEqual(shape1)
  })

  test('calls onUpdate callback when schema is first set', () => {
    const path = '/test-input-callback-' + Date.now()
    const updates = []
    onInputObserved(METHOD, path, { type: 'object' }, 'observed', (m, p, patch) => {
      updates.push({ m, p, patch })
    })
    expect(updates).toHaveLength(1)
    expect(updates[0].patch.inputConfidence).toBe('observed')
  })

  test('does not call onUpdate when schema is not upgraded', () => {
    const path = '/test-no-callback-' + Date.now()
    onInputObserved(METHOD, path, { type: 'object' })
    const updates = []
    onInputObserved(METHOD, path, { type: 'object', extra: true }, 'observed', () => {
      updates.push(true)
    })
    expect(updates).toHaveLength(0)
  })
})

// ─── onResponseObserved confidence ordering ───────────────────────────────

describe('onResponseObserved confidence ordering', () => {
  const METHOD = 'GET'

  test('inferred confidence overwrites observed', () => {
    const path = '/test-resp-upgrade-' + Date.now()
    const observed = { type: 'object', properties: { id: { type: 'integer' } } }
    const inferred = { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } }
    onResponseObserved(METHOD, path, observed, 'observed')
    onResponseObserved(METHOD, path, inferred, 'inferred')
    const entry = getRouteSchema(METHOD, path)
    expect(entry.outputConfidence).toBe('inferred')
    expect(entry.output).toEqual(inferred)
  })

  test('observed does not overwrite inferred', () => {
    const path = '/test-resp-no-downgrade-' + Date.now()
    const inferred = { type: 'object', properties: { name: { type: 'string' } } }
    const observed = { type: 'object', properties: { other: { type: 'number' } } }
    onResponseObserved(METHOD, path, inferred, 'inferred')
    onResponseObserved(METHOD, path, observed, 'observed')
    const entry = getRouteSchema(METHOD, path)
    expect(entry.outputConfidence).toBe('inferred')
    expect(entry.output).toEqual(inferred)
  })
})

// ─── onQueryObserved ──────────────────────────────────────────────────────

describe('onQueryObserved', () => {
  test('stores query schema with observed confidence', () => {
    const path = '/test-query-observed-' + Date.now()
    const shape = { type: 'object', properties: { page: { type: 'string' }, limit: { type: 'string' } } }
    onQueryObserved('GET', path, shape)
    const entry = getRouteSchema('GET', path)
    expect(entry.querySchema).toEqual(shape)
    expect(entry.querySchemaConfidence).toBe('observed')
  })

  test('does not overwrite existing query schema', () => {
    const path = '/test-query-no-overwrite-' + Date.now()
    const shape1 = { type: 'object', properties: { a: { type: 'string' } } }
    const shape2 = { type: 'object', properties: { b: { type: 'string' } } }
    onQueryObserved('GET', path, shape1)
    onQueryObserved('GET', path, shape2)  // should be ignored
    expect(getRouteSchema('GET', path).querySchema).toEqual(shape1)
  })

  test('calls onUpdate callback on first observation', () => {
    const path = '/test-query-callback-' + Date.now()
    const updates = []
    onQueryObserved('GET', path, { type: 'object' }, () => updates.push(true))
    expect(updates).toHaveLength(1)
  })
})

// ─── wasRouteRegistered ───────────────────────────────────────────────────

describe('wasRouteRegistered', () => {
  test('returns false for routes not seen by onRouteRegistered', () => {
    expect(wasRouteRegistered('GET', '/never-registered-' + Date.now())).toBe(false)
  })

  test('returns true after onRouteRegistered is called', () => {
    const path = '/registered-route-' + Date.now()
    onRouteRegistered('POST', path, [function handler(req, res) { res.json({}) }])
    expect(wasRouteRegistered('POST', path)).toBe(true)
  })
})

// ─── yup-like schema (duck-typed mock) ────────────────────────────────────

describe('yup-like schema detection (duck-typed mock)', () => {
  // We don't have yup installed, so we test with a mock that matches the duck-typing
  // checks in detectSchemaLibrary and the JSON Schema converter.

  function makeMockYupSchema(type, fields) {
    return {
      _type: type,
      validateSync(data) { return data },
      validate(data) { return Promise.resolve(data) },
      describe() {
        if (type !== 'object') return { type }
        return {
          type: 'object',
          fields: Object.fromEntries(
            Object.entries(fields).map(([k, t]) => [k, { type: t }])
          ),
        }
      },
    }
  }

  test('detectSchemaLibrary identifies yup-like schema', async () => {
    const { detectSchemaLibrary } = await import('../src/schema/validate.js')
    const schema = makeMockYupSchema('object', { name: 'string' })
    expect(detectSchemaLibrary(schema)).toBe('yup')
  })

  test('toJsonSchema converts yup-like object schema', async () => {
    const { toJsonSchema } = await import('../src/schema/validate.js')
    const schema = makeMockYupSchema('object', { name: 'string', age: 'number' })
    const result = toJsonSchema(schema, 'yup')
    expect(result.type).toBe('object')
    expect(result.properties.name).toMatchObject({ type: 'string' })
    expect(result.properties.age).toMatchObject({ type: 'number' })
  })
})
