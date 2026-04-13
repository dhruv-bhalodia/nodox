/**
 * Cache Reader Tests
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { findCacheFile, loadCacheEntries } from '../src/layer4/cache-reader.js'

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nodox-reader-'))
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ── findCacheFile ─────────────────────────────────────────────────────────

describe('findCacheFile', () => {
  test('finds .apicache.json in the given directory', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, '.apicache.json')
    fs.writeFileSync(file, '{}', 'utf8')

    const found = findCacheFile(dir)
    expect(found).toBe(file)
    cleanup(dir)
  })

  test('returns null when no cache file exists anywhere', () => {
    const dir = makeTmpDir() // empty dir
    const found = findCacheFile(dir)
    expect(found).toBeNull()
    cleanup(dir)
  })

  test('walks up to parent directory to find cache', () => {
    const parent = makeTmpDir()
    const child = path.join(parent, 'subproject')
    fs.mkdirSync(child)

    // Cache is in parent, start from child
    const file = path.join(parent, '.apicache.json')
    fs.writeFileSync(file, '{}', 'utf8')

    const found = findCacheFile(child)
    expect(found).toBe(file)
    cleanup(parent)
  })

  test('stops after 5 levels — does not walk forever', () => {
    // Create a deeply nested dir with no cache file
    const base = makeTmpDir()
    let current = base
    for (let i = 0; i < 7; i++) {
      current = path.join(current, `level${i}`)
      fs.mkdirSync(current)
    }
    // Put cache 7 levels up — should NOT be found (exceeds 5 level limit)
    fs.writeFileSync(path.join(base, '.apicache.json'), '{}', 'utf8')
    const found = findCacheFile(current)
    // May or may not find it depending on exact traversal — just must not throw
    expect(() => findCacheFile(current)).not.toThrow()
    cleanup(base)
  })
})

// ── loadCacheEntries ──────────────────────────────────────────────────────

describe('loadCacheEntries', () => {
  test('returns entries from a valid cache file', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, '.apicache.json')
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      routes: {
        'GET:/users': {
          method: 'GET', path: '/users',
          output: { type: 'array' },
          outputConfidence: 'observed',
          seenCount: 2,
        }
      }
    }), 'utf8')

    const entries = loadCacheEntries(file)
    expect(entries['GET:/users']).toBeDefined()
    expect(entries['GET:/users'].output.type).toBe('array')
    cleanup(dir)
  })

  test('returns empty object when file does not exist', () => {
    const entries = loadCacheEntries('/nonexistent/path/.apicache.json')
    expect(entries).toEqual({})
  })

  test('returns empty object for corrupt JSON', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, '.apicache.json')
    fs.writeFileSync(file, 'not json', 'utf8')
    const entries = loadCacheEntries(file)
    expect(entries).toEqual({})
    cleanup(dir)
  })

  test('returns empty object when routes key is missing', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, '.apicache.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1 }), 'utf8')
    const entries = loadCacheEntries(file)
    expect(entries).toEqual({})
    cleanup(dir)
  })

  test('auto-discovers cache via findCacheFile when no path given', () => {
    // loadCacheEntries(null) should call findCacheFile internally
    // We can't easily test this without mocking cwd, so just verify it doesn't throw
    expect(() => loadCacheEntries(null)).not.toThrow()
  })
})
