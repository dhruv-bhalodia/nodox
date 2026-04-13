/**
 * WebSocket Server
 *
 * Manages the real-time connection between the nodox middleware and the React UI.
 *
 * Protocol:
 *   FULL_STATE_SYNC  — sent to every new connection and on every server restart.
 *                      Client must OVERWRITE state, not merge, to prevent ghost routes.
 *   route-added      — incremental: a new route was registered (rare after startup)
 *   schema-update    — incremental: schema learned for a route (Phase 2+)
 *   ping             — keepalive from server
 *   pong             — keepalive response from client
 */

import { WebSocketServer, WebSocket } from 'ws'

export class NodoxWebSocketServer {
  /** @type {WebSocketServer|null} */
  #wss = null

  /** @type {Set<WebSocket>} */
  #clients = new Set()

  /** @type {() => object} */
  #getState

  /**
   * @param {object} options
   * @param {Function} options.getState - returns current full state object
   */
  constructor({ getState }) {
    this.#getState = getState
  }

  /**
   * Attach the WebSocket server to an existing HTTP server.
   * @param {import('http').Server} httpServer
   */
  attach(httpServer) {
    this.#wss = new WebSocketServer({
      server: httpServer,
      path: '/__nodox_ws',
      // Only accept connections from the same host (localhost/127.0.0.1).
      // This blocks cross-origin reads from malicious third-party web pages
      // while still allowing the nodox UI served on the same server to connect.
      verifyClient({ origin, req }) {
        if (!origin) return true // non-browser clients (curl, tests) have no Origin
        try {
          const url = new URL(origin)
          const host = req.headers.host || ''
          // Allow if the origin host matches the server host exactly,
          // or if it's any localhost variant (127.x.x.x, ::1, *.localhost)
          if (url.host === host) return true
          const hostname = url.hostname
          if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true
          if (hostname.endsWith('.localhost')) return true
          
          console.warn(`[nodox] WebSocket connection rejected from origin: ${origin} (server host: ${host})`)
          return false
        } catch {
          return false
        }
      },
    })

    this.#wss.on('connection', (ws) => {
      this.#clients.add(ws)

      // Send full state immediately on connect.
      // Client MUST overwrite its state on receiving this — not merge.
      this.#sendFullSync(ws)

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'pong') return // keepalive, ignore
        } catch {
          // Ignore malformed messages
        }
      })

      ws.on('close', () => {
        this.#clients.delete(ws)
      })

      ws.on('error', (err) => {
        // Log but don't crash — client errors should never take down the dev server
        console.warn('[nodox] WebSocket client error:', err.message)
        this.#clients.delete(ws)
      })
    })

    this.#wss.on('error', (err) => {
      console.warn('[nodox] WebSocket server error:', err.message)
    })

    // Keepalive ping every 30 seconds
    this.#startKeepalive()

    return this
  }

  /**
   * Send full state to one specific client.
   * @param {WebSocket} ws
   */
  #sendFullSync(ws) {
    this.#send(ws, {
      type: 'FULL_STATE_SYNC',
      ...this.#getState(),
      timestamp: Date.now(),
    })
  }

  /**
   * Broadcast full state to ALL connected clients.
   * Called when routes change significantly (e.g. after deferred extraction).
   */
  broadcastFullSync() {
    const state = {
      type: 'FULL_STATE_SYNC',
      ...this.#getState(),
      timestamp: Date.now(),
    }
    for (const ws of this.#clients) {
      this.#send(ws, state)
    }
  }

  /**
   * Broadcast an incremental update to all clients.
   * @param {object} message
   */
  broadcast(message) {
    for (const ws of this.#clients) {
      this.#send(ws, message)
    }
  }

  /**
   * Safe JSON send — swallows errors on closed connections.
   * @param {WebSocket} ws
   * @param {object} data
   */
  #send(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(data))
    } catch {
      // Client disconnected mid-send — remove and move on
      this.#clients.delete(ws)
    }
  }

  #startKeepalive() {
    const interval = setInterval(() => {
      for (const ws of this.#clients) {
        if (ws.readyState === WebSocket.OPEN) {
          this.#send(ws, { type: 'ping' })
        } else {
          this.#clients.delete(ws)
        }
      }
    }, 30_000)

    // Don't hold the process open just for keepalives
    interval.unref?.()
  }

  /**
   * Gracefully close the WebSocket server.
   */
  close() {
    for (const ws of this.#clients) {
      try { ws.close() } catch {}
    }
    this.#clients.clear()
    this.#wss?.close()
  }

  get clientCount() {
    return this.#clients.size
  }
}
