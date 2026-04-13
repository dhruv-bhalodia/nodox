/**
 * Cache Reader
 *
 * Reads .apicache.json at server startup and populates the schema registry
 * with shapes observed during past test runs (Layer 4).
 *
 * This runs once, synchronously, during nodox(app) initialization —
 * before routes are registered and before the deferred extraction tick.
 *
 * Confidence level for cache-loaded schemas: 'observed'
 * (Same as Layer 5 live interception, but from tests rather than manual requests.)
 *
 * Cache schemas are lower priority than:
 *   - Tier 1: validate() wrapper (confirmed)
 *   - Layer 3: dry-run inferred
 * But higher visibility than nothing — they populate the UI immediately on startup.
 */

import fs from 'fs'
import path from 'path'

/**
 * Find .apicache.json by searching from cwd upward.
 * This handles monorepos where the cache may be at the workspace root.
 * Stops at filesystem root or after 5 levels.
 *
 * @param {string} [startDir] - directory to start from (defaults to cwd)
 * @returns {string|null} absolute path if found, null if not
 */
export function findCacheFile(startDir = process.cwd()) {
  let dir = startDir
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.apicache.json')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break // reached filesystem root
    dir = parent
  }
  return null
}

/**
 * Load the cache and return all route entries.
 * Returns empty object if cache doesn't exist or is unreadable.
 *
 * @param {string|null} [cacheFile] - path override (for testing)
 * @returns {Record<string, CacheEntry>} map of "METHOD:path" → entry
 */
export function loadCacheEntries(cacheFile) {
  const filePath = cacheFile || findCacheFile()
  if (!filePath) return {}

  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed?.routes || {}
  } catch {
    return {}
  }
}

/**
 * @typedef {Object} CacheEntry
 * @property {string} method
 * @property {string} path
 * @property {object|null} input - JSON Schema for request body
 * @property {object|null} output - JSON Schema for response body
 * @property {'observed'|'none'} inputConfidence
 * @property {'observed'|'none'} outputConfidence
 * @property {number} seenCount
 * @property {string} lastSeen - ISO date string
 */
