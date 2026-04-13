/**
 * Cache Manager
 *
 * Manages .apicache.json — the persistent schema cache populated by test runs.
 *
 * Format:
 * {
 *   "version": 1,
 *   "generatedAt": "2024-01-15T10:30:00Z",
 *   "routes": {
 *     "GET:/api/users": {
 *       "method": "GET",
 *       "path": "/api/users",
 *       "input":  { ...JSON Schema... },   // inferred from request body
 *       "output": { ...JSON Schema... },   // inferred from response body
 *       "inputConfidence":  "observed",
 *       "outputConfidence": "observed",
 *       "seenCount": 3,                    // how many test runs observed this
 *       "lastSeen": "2024-01-15T10:30:00Z"
 *     }
 *   }
 * }
 *
 * Merge strategy: ONLY add fields, never remove them.
 * Rationale: a field absent from one test run may be optional, not deleted.
 * Use `nodox --prune` to wipe the cache and start fresh after major API changes.
 */

import fs from 'fs'
import { mergeShapes } from '../schema/response-interceptor.js'

const CACHE_VERSION = 1

/**
 * Read the cache file. Returns empty structure if file doesn't exist or is corrupt.
 * @param {string} cacheFile - absolute path to .apicache.json
 * @returns {object} cache object with `routes` map
 */
export function readCache(cacheFile) {
  try {
    if (!fs.existsSync(cacheFile)) {
      return { version: CACHE_VERSION, routes: {} }
    }

    const raw = fs.readFileSync(cacheFile, 'utf8')
    const parsed = JSON.parse(raw)

    // Validate basic structure
    if (!parsed || typeof parsed !== 'object') {
      return { version: CACHE_VERSION, routes: {} }
    }

    // Migrate if needed (future-proof)
    if (!parsed.routes || typeof parsed.routes !== 'object') {
      parsed.routes = {}
    }

    return parsed
  } catch {
    // Corrupt or unreadable — start fresh rather than crashing
    return { version: CACHE_VERSION, routes: {} }
  }
}

/**
 * Write the cache file atomically (write to temp, then rename).
 * Atomic write prevents corrupt cache if process is killed mid-write.
 * @param {string} cacheFile - absolute path to .apicache.json
 * @param {object} cache - cache object to write
 */
export function writeCache(cacheFile, cache) {
  const updated = {
    ...cache,
    version: CACHE_VERSION,
    generatedAt: new Date().toISOString(),
  }

  const json = JSON.stringify(updated, null, 2)
  const tmpFile = cacheFile + '.tmp'

  fs.writeFileSync(tmpFile, json, 'utf8')

  // Atomic rename — on most OS this is atomic for same-filesystem moves
  fs.renameSync(tmpFile, cacheFile)
}

/**
 * Merge a single exchange into the cache.
 * Always merges (union of fields), never removes existing fields.
 *
 * @param {object} cache - current cache object (with .routes)
 * @param {string} key - "METHOD:path" e.g. "GET:/api/users"
 * @param {object} exchange - { method, path, reqShape, resShape, resStatus }
 * @returns {object} updated cache (new object, no mutation)
 */
export function mergeCacheEntry(cache, key, exchange) {
  const routes = { ...cache.routes }
  const existing = routes[key]
  const now = new Date().toISOString()

  if (!existing) {
    routes[key] = {
      method: exchange.method,
      path: exchange.path,
      input: exchange.reqShape ?? null,
      output: exchange.resShape ?? null,
      inputConfidence: exchange.reqShape ? 'observed' : 'none',
      outputConfidence: exchange.resShape ? 'observed' : 'none',
      seenCount: 1,
      lastSeen: now,
    }
  } else {
    // Merge shapes — adds new fields, never removes existing ones
    const mergedInput = exchange.reqShape
      ? mergeShapes(existing.input, exchange.reqShape)
      : existing.input

    const mergedOutput = exchange.resShape
      ? mergeShapes(existing.output, exchange.resShape)
      : existing.output

    routes[key] = {
      ...existing,
      input: mergedInput,
      output: mergedOutput,
      inputConfidence: mergedInput ? 'observed' : existing.inputConfidence,
      outputConfidence: mergedOutput ? 'observed' : existing.outputConfidence,
      seenCount: (existing.seenCount || 0) + 1,
      lastSeen: now,
    }
  }

  return { ...cache, routes }
}

/**
 * Remove all entries from the cache (for `nodox --prune`).
 * Does NOT delete the file — writes an empty routes object instead.
 * @param {string} cacheFile
 */
export function pruneCache(cacheFile) {
  writeCache(cacheFile, { version: CACHE_VERSION, routes: {} })
}

/**
 * Get cache stats for display (e.g. in CLI output).
 * @param {object} cache
 * @returns {{ routeCount: number, withInput: number, withOutput: number }}
 */
export function getCacheStats(cache) {
  const routes = Object.values(cache.routes || {})
  return {
    routeCount: routes.length,
    withInput: routes.filter(r => r.input).length,
    withOutput: routes.filter(r => r.output).length,
  }
}
