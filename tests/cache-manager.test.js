/**
 * Cache Manager Tests
 *
 * Tests .apicache.json read/write/merge/prune logic.
 * Uses a real temp file for every test — no mocks.
 */

import { jest } from '@jest/globals'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { readCache, writeCache, mergeCacheEntry, pruneCache, getCacheStats } from '../src/layer4/cache-manager.js'
import { inferShape } from '../src/schema/response-interceptor.js'

// ── Helpers ───────────────────────────────────────────────────────────────

function tmpCacheFile() {
  return path.join(os.tmpdir(), `nodox-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

function cleanup(file) {
  try { fs.unlinkSync(file) } catch { /* already gone */ }
  try { fs.unlinkSync(file + '.tmp') } catch { /* already gone */ }
}

// ── readCache ─────────────────────────────────────────────────────────────

describe('readCache', () => {
  test('returns empty structure when file does not exist', () => {
    const file = tmpCacheFile() // does not exist
    const result = readCache(file)
    expect(result.version).toBe(1)
    expect(result.routes).toEqual({})
  })

  test('reads a valid cache file correctly', () => {
    const file = tmpCacheFile()
    const data = {
      version: 1,
      routes: {
        'GET:/users': {
          method: 'GET', path: '/users',
          input: null,
          output: { type: 'array' },
          inputConfidence: 'none',
          outputConfidence: 'observed',
          seenCount: 1,
          lastSeen: '2024-01-01T00:00:00Z',
        }
      }
    }
    fs.writeFileSync(file, JSON.stringify(data), 'utf8')

    const result = readCache(file)
    expect(result.routes['GET:/users'].output.type).toBe('array')
    expect(result.routes['GET:/users'].seenCount).toBe(1)
    cleanup(file)
  })

  test('returns empty structure for corrupt JSON', () => {
    const file = tmpCacheFile()
    fs.writeFileSync(file, 'this is not json {{{', 'utf8')
    const result = readCache(file)
    expect(result.routes).toEqual({})
    cleanup(file)
  })

  test('returns empty structure for empty file', () => {
    const file = tmpCacheFile()
    fs.writeFileSync(file, '', 'utf8')
    const result = readCache(file)
    expect(result.routes).toEqual({})
    cleanup(file)
  })

  test('handles missing routes key gracefully', () => {
    const file = tmpCacheFile()
    fs.writeFileSync(file, JSON.stringify({ version: 1 }), 'utf8')
    const result = readCache(file)
    expect(result.routes).toEqual({})
    cleanup(file)
  })
})

// ── writeCache ────────────────────────────────────────────────────────────

describe('writeCache', () => {
  test('writes readable JSON to disk', () => {
    const file = tmpCacheFile()
    writeCache(file, { routes: { 'GET:/ping': { method: 'GET', path: '/ping' } } })

    expect(fs.existsSync(file)).toBe(true)
    const content = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(content)
    expect(parsed.routes['GET:/ping'].method).toBe('GET')
    cleanup(file)
  })

  test('sets version and generatedAt', () => {
    const file = tmpCacheFile()
    writeCache(file, { routes: {} })
    const result = readCache(file)
    expect(result.version).toBe(1)
    expect(result.generatedAt).toBeDefined()
    expect(new Date(result.generatedAt).getFullYear()).toBeGreaterThanOrEqual(2024)
    cleanup(file)
  })

  test('is atomic — no .tmp file left on disk after write', () => {
    const file = tmpCacheFile()
    writeCache(file, { routes: {} })
    expect(fs.existsSync(file + '.tmp')).toBe(false)
    cleanup(file)
  })

  test('round-trips data correctly through read+write', () => {
    const file = tmpCacheFile()
    const original = {
      routes: {
        'POST:/items': {
          method: 'POST', path: '/items',
          input:  { type: 'object', properties: { name: { type: 'string' } } },
          output: { type: 'object', properties: { id: { type: 'integer' } } },
          inputConfidence: 'observed',
          outputConfidence: 'observed',
          seenCount: 3,
        }
      }
    }
    writeCache(file, original)
    const result = readCache(file)
    expect(result.routes['POST:/items'].input.properties.name.type).toBe('string')
    expect(result.routes['POST:/items'].seenCount).toBe(3)
    cleanup(file)
  })
})

// ── mergeCacheEntry ───────────────────────────────────────────────────────

describe('mergeCacheEntry', () => {
  test('creates a new entry when key does not exist', () => {
    const cache = { version: 1, routes: {} }
    const shape = inferShape([{ id: 1, name: 'Alice' }])
    const result = mergeCacheEntry(cache, 'GET:/users', {
      method: 'GET', path: '/users',
      reqShape: null, resShape: shape, resStatus: 200,
    })
    expect(result.routes['GET:/users']).toBeDefined()
    expect(result.routes['GET:/users'].output.type).toBe('array')
    expect(result.routes['GET:/users'].seenCount).toBe(1)
  })

  test('increments seenCount on subsequent merges', () => {
    const cache = { version: 1, routes: {} }
    const shape = inferShape({ id: 1 })
    let result = mergeCacheEntry(cache, 'GET:/item', {
      method: 'GET', path: '/item', reqShape: null, resShape: shape, resStatus: 200,
    })
    result = mergeCacheEntry(result, 'GET:/item', {
      method: 'GET', path: '/item', reqShape: null, resShape: shape, resStatus: 200,
    })
    expect(result.routes['GET:/item'].seenCount).toBe(2)
  })

  test('merges new response fields into existing shape', () => {
    let cache = { version: 1, routes: {} }
    // First run: only id + name
    cache = mergeCacheEntry(cache, 'GET:/users', {
      method: 'GET', path: '/users',
      reqShape: null,
      resShape: inferShape([{ id: 1, name: 'Alice' }]),
      resStatus: 200,
    })
    // Second run: adds email field
    cache = mergeCacheEntry(cache, 'GET:/users', {
      method: 'GET', path: '/users',
      reqShape: null,
      resShape: inferShape([{ id: 2, name: 'Bob', email: 'bob@example.com' }]),
      resStatus: 200,
    })

    const props = cache.routes['GET:/users'].output.items.properties
    expect(props.id).toBeDefined()
    expect(props.name).toBeDefined()
    expect(props.email).toBeDefined() // added by second merge
  })

  test('stores request body shape', () => {
    const cache = { version: 1, routes: {} }
    const reqShape = inferShape({ name: 'Alice', email: 'alice@example.com' })
    const result = mergeCacheEntry(cache, 'POST:/users', {
      method: 'POST', path: '/users',
      reqShape, resShape: inferShape({ id: 1 }), resStatus: 201,
    })
    expect(result.routes['POST:/users'].input.type).toBe('object')
    expect(result.routes['POST:/users'].input.properties.name).toBeDefined()
  })

  test('does not mutate original cache object', () => {
    const cache = { version: 1, routes: {} }
    const original = JSON.stringify(cache)
    mergeCacheEntry(cache, 'GET:/test', {
      method: 'GET', path: '/test', reqShape: null,
      resShape: inferShape({ ok: true }), resStatus: 200,
    })
    expect(JSON.stringify(cache)).toBe(original)
  })

  test('sets correct confidence levels', () => {
    const cache = { version: 1, routes: {} }
    const result = mergeCacheEntry(cache, 'POST:/data', {
      method: 'POST', path: '/data',
      reqShape: inferShape({ x: 1 }),
      resShape: inferShape({ y: 2 }),
      resStatus: 200,
    })
    const entry = result.routes['POST:/data']
    expect(entry.inputConfidence).toBe('observed')
    expect(entry.outputConfidence).toBe('observed')
  })

  test('handles null reqShape — only sets outputConfidence', () => {
    const cache = { version: 1, routes: {} }
    const result = mergeCacheEntry(cache, 'GET:/data', {
      method: 'GET', path: '/data',
      reqShape: null,
      resShape: inferShape({ result: 'ok' }),
      resStatus: 200,
    })
    const entry = result.routes['GET:/data']
    expect(entry.inputConfidence).toBe('none')
    expect(entry.outputConfidence).toBe('observed')
  })
})

// ── pruneCache ────────────────────────────────────────────────────────────

describe('pruneCache', () => {
  test('wipes all routes and writes empty cache', () => {
    const file = tmpCacheFile()
    // Write some data first
    writeCache(file, {
      routes: {
        'GET:/a': { method: 'GET', path: '/a' },
        'POST:/b': { method: 'POST', path: '/b' },
      }
    })

    pruneCache(file)
    const result = readCache(file)
    expect(Object.keys(result.routes)).toHaveLength(0)
    cleanup(file)
  })

  test('does not delete the file — just empties it', () => {
    const file = tmpCacheFile()
    writeCache(file, { routes: { 'GET:/x': { method: 'GET', path: '/x' } } })
    pruneCache(file)
    expect(fs.existsSync(file)).toBe(true)
    cleanup(file)
  })
})

// ── getCacheStats ─────────────────────────────────────────────────────────

describe('getCacheStats', () => {
  test('returns correct counts', () => {
    const cache = {
      routes: {
        'GET:/a': { input: null, output: { type: 'array' } },
        'POST:/b': { input: { type: 'object' }, output: { type: 'object' } },
        'DELETE:/c': { input: null, output: null },
      }
    }
    const stats = getCacheStats(cache)
    expect(stats.routeCount).toBe(3)
    expect(stats.withInput).toBe(1)
    expect(stats.withOutput).toBe(2)
  })

  test('handles empty routes', () => {
    const stats = getCacheStats({ routes: {} })
    expect(stats.routeCount).toBe(0)
    expect(stats.withInput).toBe(0)
    expect(stats.withOutput).toBe(0)
  })

  test('handles missing routes key', () => {
    const stats = getCacheStats({})
    expect(stats.routeCount).toBe(0)
  })
})
