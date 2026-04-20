/**
 * Playground — send live HTTP requests directly from the nodox UI.
 *
 * Builds the request from:
 *   - Method + path from the selected route
 *   - Path params extracted from route (e.g. :id)
 *   - Query params (key/value editor)
 *   - Headers (key/value editor)
 *   - Body (JSON editor, shown for POST/PUT/PATCH)
 *
 * Response is shown with: status code, status text, timing, pretty-printed body.
 *
 * Schema diffing: save a response as baseline, then compare against subsequent responses.
 */

import { useState, useCallback, useEffect, useRef } from 'react'

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

// ── Schema helpers ────────────────────────────────────────────────────────────

/**
 * Extract flat field descriptors from a JSON Schema object.
 * Returns null if the schema has no usable properties.
 */
function getSchemaFields(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties) return null
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return Object.entries(schema.properties).map(([key, def]) => ({
    key,
    type: def.type || 'string',
    required: required.has(key),
  }))
}

/**
 * Parse a string value according to the expected JSON Schema type.
 * Falls back to the raw string if coercion is not possible.
 */
function parseFieldValue(value, type) {
  if (value === '') return ''
  if (type === 'number' || type === 'integer') {
    const n = Number(value)
    return isNaN(n) ? value : n
  }
  if (type === 'boolean') {
    if (value === 'true') return true
    if (value === 'false') return false
    return value
  }
  if (type === 'object' || type === 'array') {
    try { return JSON.parse(value) } catch { return value }
  }
  return value
}

function extractPathParams(path) {
  const params = []
  const re = /:([a-zA-Z_][a-zA-Z0-9_]*)/g
  let m
  while ((m = re.exec(path)) !== null) params.push(m[1])
  return params
}

function buildUrl(path, pathParams, queryParams, baseUrl) {
  let url = baseUrl || window.location.origin

  let resolvedPath = path
  for (const [key, val] of Object.entries(pathParams)) {
    resolvedPath = resolvedPath.replace(`:${key}`, encodeURIComponent(val || `:${key}`))
  }
  url += resolvedPath

  const qs = queryParams.filter(p => p.key).map(p =>
    `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value || '')}`
  ).join('&')
  if (qs) url += '?' + qs

  return url
}

function KvEditor({ label, rows, onChange, placeholder = 'value' }) {
  return (
    <div className="kv-editor">
      <div className="kv-editor__label">{label}</div>
      {rows.map((row, i) => (
        <div key={i} className="kv-editor__row">
          <input
            className="kv-input"
            value={row.key}
            placeholder="key"
            onChange={e => onChange(rows.map((r, j) => j === i ? { ...r, key: e.target.value } : r))}
          />
          <span className="kv-sep">:</span>
          <input
            className="kv-input kv-input--value"
            value={row.value}
            placeholder={placeholder}
            onChange={e => onChange(rows.map((r, j) => j === i ? { ...r, value: e.target.value } : r))}
          />
          <button
            className="kv-btn-remove"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            title="Remove"
          >×</button>
        </div>
      ))}
      <button
        className="kv-btn-add"
        onClick={() => onChange([...rows, { key: '', value: '' }])}
      >
        + Add {label.toLowerCase().replace(' ', '-')}
      </button>
    </div>
  )
}

function StatusBadge({ status }) {
  const color = status < 300 ? '#4ade80' : status < 400 ? '#fbbf24' : '#f87171'
  return (
    <span className="status-badge" style={{ color, borderColor: color + '44', background: color + '11' }}>
      {status}
    </span>
  )
}

// ── Schema diff helpers ───────────────────────────────────────────────────────

function computeDiff(a, b, prefix = '') {
  const rows = []

  if (
    typeof a !== 'object' || typeof b !== 'object' || a === null || b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      rows.push({ path: prefix || '(root)', was: a, now: b, status: 'changed' })
    }
    return rows
  }

  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      rows.push({
        path: `${prefix || '(root)'}[length]`,
        was: a.length,
        now: b.length,
        status: 'changed',
      })
    }
    return rows
  }

  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key
    if (!(key in a)) {
      rows.push({ path, was: undefined, now: b[key], status: 'added' })
    } else if (!(key in b)) {
      rows.push({ path, was: a[key], now: undefined, status: 'removed' })
    } else if (
      typeof a[key] === 'object' && a[key] !== null &&
      typeof b[key] === 'object' && b[key] !== null &&
      !Array.isArray(a[key])
    ) {
      rows.push(...computeDiff(a[key], b[key], path))
    } else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      rows.push({ path, was: a[key], now: b[key], status: 'changed' })
    }
  }

  return rows
}

function fmtVal(v) {
  if (v === undefined) return '–'
  if (typeof v === 'string') return `"${v}"`
  return JSON.stringify(v)
}

function DiffView({ baseline, current }) {
  const rows = computeDiff(baseline, current)
  if (rows.length === 0) {
    return <div className="diff-identical">Responses are identical</div>
  }
  return (
    <div className="diff-view">
      <div className="diff-view__header">
        <span>Diff vs baseline</span>
        <span className="diff-view__count">{rows.length} change{rows.length !== 1 ? 's' : ''}</span>
      </div>
      {rows.map((row, i) => (
        <div key={i} className={`diff-row diff-row--${row.status}`}>
          <span className="diff-row__status">
            {row.status === 'added' ? '+' : row.status === 'removed' ? '−' : '~'}
          </span>
          <span className="diff-row__path">{row.path}</span>
          {row.status !== 'added' && (
            <span className="diff-row__was">{fmtVal(row.was)}</span>
          )}
          {row.status === 'changed' && (
            <span className="diff-row__arrow">→</span>
          )}
          {row.status !== 'removed' && (
            <span className="diff-row__now">{fmtVal(row.now)}</span>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Playground ────────────────────────────────────────────────────────────────

export function Playground({ route, baseUrl = '', cache }) {
  const routeKey = `${route.method}:${route.path}`
  const cached = cache?.current?.[routeKey]

  const pathParams = extractPathParams(route.path)
  const showBody = BODY_METHODS.has(route.method)

  // Derive schema fields once — used to decide which body editor to show
  const schemaFields = showBody ? getSchemaFields(route.schema?.input) : null

  const [pathValues, setPathValues] = useState(
    cached?.pathValues ?? Object.fromEntries(pathParams.map(p => [p, '']))
  )
  const [queryParams, setQueryParams] = useState(cached?.queryParams ?? [{ key: '', value: '' }])
  const [headers, setHeaders] = useState(cached?.headers ?? [{ key: 'Content-Type', value: 'application/json' }])

  // Schema-based body: pre-filled key rows, user only fills values
  const [bodyFields, setBodyFields] = useState(
    cached?.bodyFields ?? (schemaFields
      ? schemaFields.map(f => ({ key: f.key, value: '', type: f.type, required: f.required }))
      : [])
  )
  // Raw JSON body fallback (when no schema)
  const [body, setBody] = useState(cached?.body ?? '')
  const [bodyError, setBodyError] = useState(null)

  const [response, setResponse] = useState(cached?.response ?? null)
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(cached?.elapsed ?? null)
  const [baseline, setBaseline] = useState(cached?.baseline ?? null)

  // Track latest state values for the unmount-save effect
  const stateRef = useRef({})
  stateRef.current = { pathValues, queryParams, headers, body, bodyFields, response, elapsed, baseline }

  useEffect(() => {
    return () => {
      if (cache?.current) {
        cache.current[routeKey] = { ...stateRef.current }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey])

  const handleBodyChange = (val) => {
    setBody(val)
    if (val.trim()) {
      try { JSON.parse(val); setBodyError(null) }
      catch { setBodyError('Invalid JSON') }
    } else {
      setBodyError(null)
    }
  }

  const sendRequest = useCallback(async () => {
    if (bodyError) return

    setLoading(true)
    setResponse(null)
    const start = performance.now()

    try {
      const url = buildUrl(route.path, pathValues, queryParams, baseUrl || window.location.origin)

      const reqHeaders = { 'Accept': 'application/json' }
      for (const { key, value } of headers) {
        if (key) reqHeaders[key] = value
      }

      const fetchOptions = {
        method: route.method,
        headers: reqHeaders,
      }

      if (showBody) {
        if (bodyFields.length > 0) {
          // Build JSON from schema-based key-value rows
          const obj = {}
          for (const f of bodyFields) {
            if (f.value !== '') {
              const parsed = parseFieldValue(f.value, f.type)
              if (parsed !== '') obj[f.key] = parsed
            }
          }
          if (Object.keys(obj).length > 0) {
            fetchOptions.body = JSON.stringify(obj)
          }
        } else if (body.trim()) {
          fetchOptions.body = body
        }
      }

      const res = await fetch(url, fetchOptions)
      const ms = Math.round(performance.now() - start)
      setElapsed(ms)

      const contentType = res.headers.get('content-type') || ''
      let responseBody
      if (contentType.includes('application/json')) {
        responseBody = await res.json()
      } else {
        responseBody = await res.text()
      }

      setResponse({ status: res.status, statusText: res.statusText, body: responseBody, isJson: contentType.includes('json') })
    } catch (err) {
      setElapsed(Math.round(performance.now() - start))
      setResponse({ error: err.message })
    } finally {
      setLoading(false)
    }
  }, [route, pathValues, queryParams, headers, body, bodyFields, bodyError, showBody, baseUrl])

  return (
    <div className="playground">

      {/* Baseline indicator */}
      {baseline && (
        <div className="baseline-bar">
          <span className="baseline-bar__label">◆ Baseline saved — next response will be diffed</span>
          <button className="baseline-bar__clear" onClick={() => setBaseline(null)}>Clear</button>
        </div>
      )}

      {/* URL bar */}
      <div className="playground__url-bar">
        <span className="playground__method">{route.method}</span>
        <div className="playground__url-parts">
          {pathParams.length > 0
            ? route.path.split('/').map((seg, i) => {
                const paramName = seg.startsWith(':') ? seg.slice(1) : null
                return (
                  <span key={i} className="url-segment">
                    {i > 0 && <span className="url-slash">/</span>}
                    {paramName
                      ? <input
                          className="url-param-input"
                          value={pathValues[paramName] || ''}
                          placeholder={`:${paramName}`}
                          onChange={e => setPathValues(v => ({ ...v, [paramName]: e.target.value }))}
                        />
                      : <span className="url-static">{seg}</span>
                    }
                  </span>
                )
              })
            : <span className="url-static">{route.path}</span>
          }
        </div>
        <button
          className={`playground__send-btn ${loading ? 'playground__send-btn--loading' : ''}`}
          onClick={sendRequest}
          disabled={loading || !!bodyError}
        >
          {loading ? '⟳' : 'Send'}
        </button>
      </div>

      {/* Query params */}
      <div className="playground__section">
        <KvEditor
          label="Query params"
          rows={queryParams}
          onChange={setQueryParams}
        />
      </div>

      {/* Headers */}
      <div className="playground__section">
        <KvEditor
          label="Headers"
          rows={headers}
          onChange={setHeaders}
        />
      </div>

      {/* Body editor */}
      {showBody && (
        <div className="playground__section">
          <div className="playground__section-label">
            Body
            {bodyError && <span className="body-error">{bodyError}</span>}
          </div>
          {bodyFields.length > 0 ? (
            <div className="schema-body-editor">
              {bodyFields.map((field, i) => (
                <div key={field.key} className="schema-body-row">
                  <span className={`schema-body-key ${field.required ? 'schema-body-key--required' : ''}`}>
                    {field.key}
                    {field.required && <span className="schema-body-required">*</span>}
                  </span>
                  <input
                    className="schema-body-value"
                    value={field.value}
                    placeholder={
                      field.type === 'object' || field.type === 'array'
                        ? 'JSON'
                        : field.type === 'boolean'
                        ? 'true / false'
                        : field.type
                    }
                    onChange={e => setBodyFields(fields =>
                      fields.map((f, j) => j === i ? { ...f, value: e.target.value } : f)
                    )}
                  />
                </div>
              ))}
            </div>
          ) : (
            <textarea
              className={`body-editor ${bodyError ? 'body-editor--error' : ''}`}
              value={body}
              onChange={e => handleBodyChange(e.target.value)}
              placeholder={`{\n  "key": "value"\n}`}
              rows={8}
              spellCheck={false}
            />
          )}
        </div>
      )}

      {/* Response */}
      {response && (
        <div className="playground__response">
          <div className="response__meta">
            <span className="response__label">Response</span>
            {response.status && <StatusBadge status={response.status} />}
            {response.statusText && <span className="muted">{response.statusText}</span>}
            {elapsed !== null && <span className="response__timing">{elapsed}ms</span>}
            {response.isJson && !response.error && !baseline && (
              <button
                className="save-baseline-btn"
                onClick={() => setBaseline(response)}
                title="Save this response to compare against the next one"
              >
                Save as baseline
              </button>
            )}
          </div>

          {response.error
            ? <div className="response__error">{response.error}</div>
            : <pre className="response__body">
                {response.isJson
                  ? JSON.stringify(response.body, null, 2)
                  : response.body
                }
              </pre>
          }

          {/* Schema diff */}
          {baseline && response.isJson && !response.error && (
            <DiffView baseline={baseline.body} current={response.body} />
          )}
        </div>
      )}
    </div>
  )
}
