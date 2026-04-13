/**
 * validate() Wrapper Tests
 */

import { jest } from '@jest/globals'
import { z } from 'zod'
import { validate, detectSchemaLibrary, toJsonSchema, schemaRegistry } from '../src/schema/validate.js'

// Minimal mock req/res/next for middleware testing
function mockReqRes(body = {}) {
  const req = { body }
  const res = {
    status(code) { this._status = code; return this },
    json(data) { this._body = data; return this },
    _status: 200,
    _body: null,
  }
  const next = jest.fn()
  return { req, res, next }
}

describe('detectSchemaLibrary', () => {
  test('detects Zod schema', () => {
    const schema = z.object({ name: z.string() })
    expect(detectSchemaLibrary(schema)).toBe('zod')
  })

  test('detects plain JSON Schema', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } }
    expect(detectSchemaLibrary(schema)).toBe('jsonschema')
  })

  test('returns null for non-schema values', () => {
    expect(detectSchemaLibrary(null)).toBeNull()
    expect(detectSchemaLibrary('string')).toBeNull()
    expect(detectSchemaLibrary(42)).toBeNull()
    expect(detectSchemaLibrary({})).toBeNull()
  })
})

describe('toJsonSchema', () => {
  test('converts Zod object schema to JSON Schema', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().int(),
      email: z.string().email().optional(),
    })
    const jsonSchema = toJsonSchema(schema, 'zod')

    expect(jsonSchema.type).toBe('object')
    expect(jsonSchema.properties).toBeDefined()
    expect(jsonSchema.properties.name).toMatchObject({ type: 'string' })
    expect(jsonSchema.properties.age).toBeDefined()
  })

  test('returns plain JSON Schema unchanged', () => {
    const schema = { type: 'object', properties: { id: { type: 'integer' } } }
    const result = toJsonSchema(schema, 'jsonschema')
    expect(result).toEqual(schema)
  })
})

describe('validate() middleware', () => {
  test('calls next() when body is valid', () => {
    const schema = z.object({ name: z.string(), age: z.number() })
    const mw = validate(schema)
    const { req, res, next } = mockReqRes({ name: 'Alice', age: 30 })

    mw(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res._status).toBe(200)
  })

  test('returns 400 when body is invalid', () => {
    const schema = z.object({ name: z.string(), age: z.number() })
    const mw = validate(schema)
    const { req, res, next } = mockReqRes({ name: 'Alice', age: 'not-a-number' })

    mw(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res._status).toBe(400)
    expect(res._body.error).toBe('Validation failed')
    expect(res._body.details).toBeInstanceOf(Array)
    expect(res._body.details.length).toBeGreaterThan(0)
  })

  test('replaces req.body with parsed/coerced value on success', () => {
    const schema = z.object({
      name: z.string().trim(),
    })
    const mw = validate(schema)
    const { req, res, next } = mockReqRes({ name: '  Alice  ' })

    mw(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.body.name).toBe('Alice')
  })

  test('includes path information in validation errors', () => {
    const schema = z.object({
      user: z.object({ email: z.string().email() })
    })
    const mw = validate(schema)
    const { req, res, next } = mockReqRes({ user: { email: 'not-an-email' } })

    mw(req, res, next)

    expect(res._status).toBe(400)
    const emailError = res._body.details.find(e => e.path.includes('email'))
    expect(emailError).toBeDefined()
  })

  test('attaches __isNodoxValidate flag to the middleware function', () => {
    const schema = z.object({ id: z.number() })
    const mw = validate(schema)
    expect(mw.__isNodoxValidate).toBe(true)
  })

  test('attaches __nodoxSchema with jsonSchema to the middleware', () => {
    const schema = z.object({ id: z.number(), name: z.string() })
    const mw = validate(schema)

    expect(mw.__nodoxSchema).toBeDefined()
    expect(mw.__nodoxSchema.library).toBe('zod')
    expect(mw.__nodoxSchema.jsonSchema).toBeDefined()
    expect(mw.__nodoxSchema.jsonSchema.type).toBe('object')
    expect(mw.__nodoxSchema.confidence).toBe('confirmed')
  })

  test('handles empty body gracefully (missing required fields → 400)', () => {
    const schema = z.object({ name: z.string() })
    const mw = validate(schema)
    const { req, res, next } = mockReqRes({})

    mw(req, res, next)

    expect(res._status).toBe(400)
    expect(next).not.toHaveBeenCalled()
  })

  test('throws for unrecognized schema type', () => {
    expect(() => validate('not a schema')).toThrow('[nodox]')
    expect(() => validate(42)).toThrow('[nodox]')
    expect(() => validate(null)).toThrow('[nodox]')
  })

  test('accepts plain JSON Schema objects', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    }
    const mw = validate(schema)
    expect(mw.__nodoxSchema.library).toBe('jsonschema')
    expect(mw.__isNodoxValidate).toBe(true)
  })
})

describe('validate() response schema option', () => {
  test('stores outputJsonSchema when response Zod schema is provided', () => {
    const inputSchema = z.object({ name: z.string() })
    const outputSchema = z.object({ id: z.number(), name: z.string() })
    const mw = validate(inputSchema, { response: outputSchema })

    expect(mw.__nodoxSchema.outputJsonSchema).toBeDefined()
    expect(mw.__nodoxSchema.outputJsonSchema.type).toBe('object')
    expect(mw.__nodoxSchema.outputJsonSchema.properties.id).toBeDefined()
    expect(mw.__nodoxSchema.outputJsonSchema.properties.name).toBeDefined()
  })

  test('stores outputJsonSchema when response is a plain JSON Schema', () => {
    const inputSchema = z.object({ name: z.string() })
    const outputSchema = { type: 'object', properties: { id: { type: 'integer' } } }
    const mw = validate(inputSchema, { response: outputSchema })

    expect(mw.__nodoxSchema.outputJsonSchema).toEqual(outputSchema)
  })

  test('outputJsonSchema is null when no response schema provided', () => {
    const mw = validate(z.object({ name: z.string() }))
    expect(mw.__nodoxSchema.outputJsonSchema).toBeNull()
  })

  test('throws for unrecognized response schema type', () => {
    const inputSchema = z.object({ name: z.string() })
    expect(() => validate(inputSchema, { response: 'not a schema' })).toThrow('[nodox]')
    expect(() => validate(inputSchema, { response: 42 })).toThrow('[nodox]')
  })

  test('input validation still works when response schema is provided', () => {
    const inputSchema = z.object({ name: z.string() })
    const outputSchema = z.object({ id: z.number() })
    const mw = validate(inputSchema, { response: outputSchema })
    const { req, res, next } = mockReqRes({ name: 'Alice' })

    mw(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
  })
})
