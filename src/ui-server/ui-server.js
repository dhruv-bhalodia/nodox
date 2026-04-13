/**
 * UI Server
 *
 * Serves the built React UI at /__nodox.
 * The UI bundle is embedded in the package at dist/ui/.
 *
 * In development (when running from source), serves from ui/dist/.
 * In production (installed from npm), serves from dist/ui/.
 */

import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Find the UI dist directory.
 * Tries multiple locations to support both dev and installed scenarios.
 */
function findUiDir() {
  const candidates = [
    // Installed from npm: dist/ui/ next to the middleware dist files
    path.resolve(__dirname, './ui'),
    path.resolve(__dirname, '../ui'),
    path.resolve(__dirname, '../../dist/ui'),
    // Running from source: ui/dist/ in the repo root
    path.resolve(__dirname, '../../ui/dist'),
    // Fallback for monorepo setups
    path.resolve(__dirname, '../ui'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      return candidate
    }
  }

  return null
}

/**
 * Create a self-contained UI handler that can be called directly from middleware.
 * Used by the no-app code path (when app wasn't provided to nodox() at construction).
 *
 * @param {object} options
 * @param {string} [options.uiPath='/__nodox']
 * @returns {Function} Express-compatible (req, res, next) handler
 */
export function createUiHandler({ uiPath = '/__nodox' } = {}) {
  const uiDir = findUiDir()
  const assetsPrefix = `${uiPath}/assets`

  return function uiHandler(req, res, next) {
    if (!req.path.startsWith(uiPath)) { return next() }

    _applySecurityHeaders(res)

    if (!uiDir) {
      res.setHeader('Content-Type', 'text/html')
      res.send(_notBuiltHtml(uiPath))
      return
    }

    if (req.path.startsWith(assetsPrefix)) {
      const filename = req.path.slice(assetsPrefix.length).replace(/^\//, '')
      const assetsDir = path.join(uiDir, 'assets')
      const filePath = path.resolve(assetsDir, filename)
      // Use path.sep suffix so /assets-evil doesn't bypass a plain startsWith('/assets') check
      if (!filePath.startsWith(assetsDir + path.sep) && filePath !== assetsDir) {
        res.status(403).end(); return
      }
      if (!fs.existsSync(filePath)) { return next() }
      _sendAsset(res, filePath)
    } else {
      res.sendFile(path.join(uiDir, 'index.html'))
    }
  }
}

/**
 * Attach nodox UI routes to an Express app.
 * Serves the React SPA at /__nodox and all its assets.
 *
 * @param {import('express').Application} app
 * @param {object} options
 * @param {string} [options.uiPath='/__nodox'] - URL prefix for the UI
 */
export function attachUiRoutes(app, { uiPath = '/__nodox' } = {}) {
  const uiDir = findUiDir()

  if (!uiDir) {
    app.get(`${uiPath}*`, (req, res) => {
      _applySecurityHeaders(res)
      res.send(_notBuiltHtml(uiPath))
    })
    return
  }

  // Serve static assets (JS chunks, CSS, icons)
  // Must come before the SPA catch-all
  app.use(`${uiPath}/assets`, (req, res, next) => {
    _applySecurityHeaders(res)
    createStaticHandler(path.join(uiDir, 'assets'))(req, res, next)
  })

  // SPA catch-all: every /__nodox/* request serves index.html
  // The React router handles client-side navigation
  app.get(`${uiPath}*`, (req, res) => {
    _applySecurityHeaders(res)
    res.sendFile(path.join(uiDir, 'index.html'))
  })
}

/**
 * Apply security headers to all /__nodox responses.
 * CSP allows: scripts/styles from same origin, WebSocket to same origin,
 * inline styles (Vite injects some), data URIs for fonts/icons.
 * @param {import('http').ServerResponse} res
 */
function _applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "connect-src 'self' ws: wss: http: https:; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data: https://fonts.gstatic.com; " +
    "frame-ancestors 'none'"
  )
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'same-origin')
}

function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function _notBuiltHtml(uiPath) {
  const safeUiPath = _escapeHtml(uiPath)
  return `<!DOCTYPE html><html><head><title>nodox — UI not built</title>
  <style>body{font-family:monospace;padding:40px;background:#0a0a0a;color:#888}h1{color:#fff}
  code{background:#1a1a1a;padding:4px 8px;border-radius:4px;color:#7dd3fc}</style></head>
  <body><h1>nodox</h1>
  <p>UI bundle not found. Run <code>npm run build:ui</code> to build the interface.</p>
  <p>Then open <code>${safeUiPath}</code></p></body></html>`
}

const MIME_TYPES = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

/**
 * Send a static asset file with appropriate headers.
 * @param {import('http').ServerResponse} res
 * @param {string} filePath - absolute path to the file
 */
function _sendAsset(res, filePath) {
  const ext = path.extname(filePath)
  const filename = path.basename(filePath)
  res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream')
  // Vite produces content-hashed filenames — safe to cache aggressively
  if (filename.match(/\.[a-f0-9]{8,}\./)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  } else {
    res.setHeader('Cache-Control', 'no-cache')
  }
  res.sendFile(filePath)
}

/**
 * Minimal static file handler — serves files from a directory.
 * @param {string} dir
 * @returns {Function} Express middleware
 */
function createStaticHandler(dir) {
  return (req, res, next) => {
    const filename = req.path.replace(/^\/+/, '')
    const filePath = path.resolve(dir, filename)

    // Use path.sep suffix so /assets-evil doesn't bypass a plain startsWith('/assets') check
    if (!filePath.startsWith(dir + path.sep) && filePath !== dir) { return res.status(403).end() }
    if (!fs.existsSync(filePath)) { return next() }

    _sendAsset(res, filePath)
  }
}
