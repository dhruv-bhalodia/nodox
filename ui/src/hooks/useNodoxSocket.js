/**
 * useNodoxSocket
 *
 * Manages the WebSocket connection to the nodox middleware server.
 *
 * Reconnection strategy: exponential backoff at 500ms, 1s, 2s, 4s, 8s (capped).
 * On FULL_STATE_SYNC: OVERWRITE state entirely (prevents ghost routes after restart).
 * On incremental updates: merge into existing state.
 */

import { useState, useEffect, useRef, useCallback } from 'react'

const BACKOFF_STEPS = [500, 1000, 2000, 4000, 8000]

/**
 * @typedef {Object} Route
 * @property {string} method
 * @property {string} path
 * @property {string[]} middlewareNames
 * @property {boolean} hasValidator
 */

/**
 * @typedef {'connecting'|'connected'|'disconnected'|'reconnecting'} ConnectionStatus
 */

export function useNodoxSocket() {
  const [routes, setRoutes] = useState([])
  const [status, setStatus] = useState('connecting')
  const [lastSync, setLastSync] = useState(null)

  const wsRef = useRef(null)
  const attemptRef = useRef(0)
  const unmountedRef = useRef(false)
  const timerRef = useRef(null)

  const connect = useCallback(() => {
    if (unmountedRef.current) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/__nodox_ws`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      if (unmountedRef.current) { ws.close(); return }
      attemptRef.current = 0
      setStatus('connected')
    }

    ws.onmessage = (event) => {
      if (unmountedRef.current) return

      try {
        const msg = JSON.parse(event.data)

        switch (msg.type) {
          case 'FULL_STATE_SYNC':
            // OVERWRITE — never merge on full sync.
            // This clears ghost routes from the previous server instance.
            setRoutes(msg.routes ?? [])
            setLastSync(msg.timestamp)
            break

          case 'route-added':
            // Incremental — a new route was registered after startup
            setRoutes(prev => {
              const exists = prev.some(r => r.method === msg.route.method && r.path === msg.route.path)
              return exists ? prev : [...prev, msg.route]
            })
            break

          case 'schema-update':
            // Phase 2: update schema for a specific route
            setRoutes(prev => prev.map(r =>
              r.method === msg.method && r.path === msg.path
                ? { ...r, schema: msg.schema }
                : r
            ))
            break

          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }))
            break

          default:
            break
        }
      } catch {
        // Ignore malformed messages
      }
    }

    ws.onclose = () => {
      if (unmountedRef.current) return

      const attempt = attemptRef.current
      const delay = BACKOFF_STEPS[Math.min(attempt, BACKOFF_STEPS.length - 1)]
      attemptRef.current = attempt + 1

      setStatus(attempt === 0 ? 'disconnected' : 'reconnecting')

      timerRef.current = setTimeout(() => {
        if (!unmountedRef.current) {
          setStatus('reconnecting')
          connect()
        }
      }, delay)
    }

    ws.onerror = () => {
      // onclose will handle reconnection — onerror always fires before onclose
    }
  }, [])

  useEffect(() => {
    unmountedRef.current = false
    connect()

    return () => {
      unmountedRef.current = true
      clearTimeout(timerRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  return { routes, status, lastSync }
}
