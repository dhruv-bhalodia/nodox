/**
 * ChainBuilder — Phase 4
 *
 * Visual canvas for wiring API endpoints into chains.
 * Each node is a route; edges represent data flow between them.
 *
 * Cycle detection (DFS) runs before any edge is accepted —
 * circular chains are rejected at the moment of connection.
 *
 * Lazy-loaded via React.lazy() — only the ~400kb React Flow chunk
 * is fetched when this tab is first opened.
 *
 * Simulation runner: topological sort → step-by-step execution
 * with {{step0.fieldName}} variable interpolation between steps.
 */

import { useCallback, useState, useRef, useEffect } from 'react'
import {
  ReactFlow,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  Handle,
  Position,
  Panel,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

// ── Cycle detection ───────────────────────────────────────────────────────────

function wouldCreateCycle(edges, newEdge) {
  const adj = new Map()
  for (const e of [...edges, newEdge]) {
    if (!adj.has(e.source)) adj.set(e.source, [])
    adj.get(e.source).push(e.target)
  }

  const visited = new Set()
  function dfs(node) {
    if (node === newEdge.source) return true
    if (visited.has(node)) return false
    visited.add(node)
    for (const neighbor of (adj.get(node) || [])) {
      if (dfs(neighbor)) return true
    }
    return false
  }
  return dfs(newEdge.target)
}

// ── Topological sort (Kahn's algorithm) ──────────────────────────────────────

function topoSort(nodes, edges) {
  const inDegree = new Map(nodes.map(n => [n.id, 0]))
  const adj = new Map(nodes.map(n => [n.id, []]))

  for (const e of edges) {
    if (adj.has(e.source)) adj.set(e.source, [])
    adj.get(e.source).push(e.target)
    inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1)
  }

  const queue = nodes.filter(n => (inDegree.get(n.id) || 0) === 0)
  const result = []

  while (queue.length) {
    const node = queue.shift()
    result.push(node)
    for (const targetId of (adj.get(node.id) || [])) {
      const deg = (inDegree.get(targetId) || 0) - 1
      inDegree.set(targetId, deg)
      if (deg === 0) {
        const targetNode = nodes.find(n => n.id === targetId)
        if (targetNode) queue.push(targetNode)
      }
    }
  }

  return result
}

// ── Schema helpers ────────────────────────────────────────────────────────────

function getSchemaFields(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties) return null
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return Object.entries(schema.properties).map(([key, def]) => ({
    key,
    type: def.type || 'string',
    required: required.has(key),
  }))
}

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

// ── Simulation helpers ────────────────────────────────────────────────────────

const BODY_METHODS_SIM = new Set(['POST', 'PUT', 'PATCH'])

function extractPathParamsSim(path) {
  const params = []
  const re = /:([a-zA-Z_][a-zA-Z0-9_]*)/g
  let m
  while ((m = re.exec(path)) !== null) params.push(m[1])
  return params
}

function getNestedValue(obj, path) {
  if (typeof obj !== 'object' || obj === null) return undefined
  return path.split('.').reduce((acc, k) => (acc != null ? acc[k] : undefined), obj)
}

function interpolate(text, results) {
  if (!text || !text.includes('{{')) return text
  return text.replace(/\{\{step(\d+)\.(.+?)\}\}/g, (match, idxStr, path) => {
    const idx = parseInt(idxStr, 10)
    const result = results[idx]
    if (!result || result.error || typeof result.body !== 'object') return match
    const val = getNestedValue(result.body, path)
    return val !== undefined ? String(val) : match
  })
}

// ── Simulation panel ──────────────────────────────────────────────────────────

function SimPanel({ steps, baseUrl, onClose }) {
  const [inputs, setInputs] = useState(() =>
    steps.map(s => {
      const schemaFields = getSchemaFields(s.data.schema?.input)
      return {
        pathParams: Object.fromEntries(
          extractPathParamsSim(s.data.path).map(p => [p, ''])
        ),
        body: '',
        bodyFields: schemaFields
          ? schemaFields.map(f => ({ key: f.key, value: '', type: f.type, required: f.required }))
          : [],
      }
    })
  )
  const [results, setResults] = useState(new Array(steps.length).fill(null))
  const [running, setRunning] = useState(false)
  const [runningStep, setRunningStep] = useState(-1)
  const [expanded, setExpanded] = useState(new Array(steps.length).fill(false))

  async function runAll() {
    if (running || steps.length === 0) return
    setRunning(true)
    setResults(new Array(steps.length).fill(null))

    const acc = []
    for (let i = 0; i < steps.length; i++) {
      setRunningStep(i)
      const step = steps[i]
      const method = step.data.method
      const path = step.data.path
      const pathParams = extractPathParamsSim(path)
      const input = inputs[i]

      // Resolve path params with interpolation
      let resolvedPath = path
      for (const p of pathParams) {
        const raw = input.pathParams[p] || ''
        const val = interpolate(raw, acc)
        resolvedPath = resolvedPath.replace(`:${p}`, encodeURIComponent(val || `:${p}`))
      }

      const url = (baseUrl || window.location.origin) + resolvedPath

      let resolvedBody
      if (BODY_METHODS_SIM.has(method)) {
        if (input.bodyFields.length > 0) {
          // Build body from schema-based key-value rows, interpolating each field
          const obj = {}
          for (const f of input.bodyFields) {
            if (f.value !== '') {
              const interpolated = interpolate(f.value, acc)
              const parsed = parseFieldValue(interpolated, f.type)
              if (parsed !== '') obj[f.key] = parsed
            }
          }
          if (Object.keys(obj).length > 0) resolvedBody = JSON.stringify(obj)
        } else {
          resolvedBody = interpolate(input.body, acc)
        }
      }

      try {
        const fetchOpts = {
          method,
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        }
        if (resolvedBody?.trim()) fetchOpts.body = resolvedBody

        const res = await fetch(url, fetchOpts)
        const contentType = res.headers.get('content-type') || ''
        const body = contentType.includes('json') ? await res.json() : await res.text()
        acc.push({ status: res.status, statusText: res.statusText, body, isJson: contentType.includes('json'), ok: res.ok })
      } catch (err) {
        acc.push({ error: err.message })
      }

      setResults([...acc, ...new Array(steps.length - acc.length).fill(null)])
    }

    setRunningStep(-1)
    setRunning(false)
    setExpanded(new Array(steps.length).fill(true))
  }

  function toggleStep(i) {
    setExpanded(e => e.map((v, j) => j === i ? !v : v))
  }

  return (
    <div className="sim-panel">
      <div className="sim-panel__header">
        <span className="sim-panel__title">Simulation</span>
        <div className="sim-panel__header-actions">
          <button
            className="sim-run-btn"
            onClick={runAll}
            disabled={running || steps.length === 0}
          >
            {running ? '⟳ Running…' : '▶ Run all'}
          </button>
          <button className="sim-close-btn" onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      {steps.length === 0 && (
        <div className="sim-empty">Add routes to the canvas to simulate a chain</div>
      )}

      <div className="sim-steps">
        {steps.map((step, i) => {
          const method = step.data.method
          const path = step.data.path
          const pathParams = extractPathParamsSim(path)
          const result = results[i]
          const isRunning = runningStep === i
          const c = METHOD_COLORS[method] || { border: '#555', text: '#aaa', bg: '#111' }
          const isExpanded = expanded[i]
          const isDone = result && !result.error && result.ok
          const isError = result && (result.error || !result.ok)

          return (
            <div
              key={step.id}
              className={`sim-step ${isRunning ? 'sim-step--running' : ''} ${isDone ? 'sim-step--done' : ''} ${isError ? 'sim-step--error' : ''}`}
            >
              <button className="sim-step__header" onClick={() => toggleStep(i)}>
                <span className="sim-step__num">{i + 1}</span>
                <span
                  className="sim-step__badge"
                  style={{ background: c.bg, color: c.text, borderColor: c.border }}
                >
                  {method}
                </span>
                <span className="sim-step__path">{path}</span>
                {result && !result.error && (
                  <span className={`sim-step__code ${result.ok ? 'sim-step__code--ok' : 'sim-step__code--err'}`}>
                    {result.status}
                  </span>
                )}
                {result?.error && (
                  <span className="sim-step__code sim-step__code--err">ERR</span>
                )}
                {isRunning && <span className="sim-step__spinner" />}
                <span className="sim-step__chevron">{isExpanded ? '▾' : '▸'}</span>
              </button>

              {isExpanded && (
                <div className="sim-step__body">
                  {pathParams.length > 0 && (
                    <div className="sim-input-group">
                      <div className="sim-input-group__label">Path params</div>
                      {pathParams.map(p => (
                        <div key={p} className="sim-param-row">
                          <span className="sim-param-name">:{p}</span>
                          <input
                            className="sim-param-input"
                            value={inputs[i].pathParams[p] || ''}
                            placeholder={i > 0 ? `{{step${i - 1}.id}}` : 'value'}
                            onChange={e => setInputs(inp => inp.map((x, j) =>
                              j === i
                                ? { ...x, pathParams: { ...x.pathParams, [p]: e.target.value } }
                                : x
                            ))}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {BODY_METHODS_SIM.has(method) && (
                    <div className="sim-input-group">
                      <div className="sim-input-group__label">
                        Body
                        {i > 0 && (
                          <span className="sim-hint">
                            {'{{step0.field}}'} to reference previous results
                          </span>
                        )}
                      </div>
                      {inputs[i].bodyFields.length > 0 ? (
                        <div className="schema-body-editor schema-body-editor--sim">
                          {inputs[i].bodyFields.map((field, fi) => (
                            <div key={field.key} className="schema-body-row">
                              <span className={`schema-body-key ${field.required ? 'schema-body-key--required' : ''}`}>
                                {field.key}
                                {field.required && <span className="schema-body-required">*</span>}
                              </span>
                              <input
                                className="schema-body-value"
                                value={field.value}
                                placeholder={
                                  i > 0
                                    ? `{{step${i - 1}.${field.key}}}`
                                    : field.type === 'object' || field.type === 'array'
                                    ? 'JSON'
                                    : field.type === 'boolean'
                                    ? 'true / false'
                                    : field.type
                                }
                                onChange={e => setInputs(inp => inp.map((x, j) =>
                                  j === i
                                    ? { ...x, bodyFields: x.bodyFields.map((bf, bj) =>
                                        bj === fi ? { ...bf, value: e.target.value } : bf
                                      )}
                                    : x
                                ))}
                              />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <textarea
                          className="sim-body-editor"
                          value={inputs[i].body}
                          onChange={e => setInputs(inp => inp.map((x, j) =>
                            j === i ? { ...x, body: e.target.value } : x
                          ))}
                          placeholder={`{\n  "field": "value"\n}`}
                          rows={3}
                          spellCheck={false}
                        />
                      )}
                    </div>
                  )}

                  {result && (
                    <div className={`sim-result ${result.error ? 'sim-result--error' : ''}`}>
                      {result.error
                        ? <div className="sim-result__error">{result.error}</div>
                        : <>
                            <div className="sim-result__meta">
                              <span className={`sim-result__code ${result.ok ? 'sim-result__code--ok' : 'sim-result__code--err'}`}>
                                {result.status} {result.statusText}
                              </span>
                            </div>
                            <pre className="sim-result__body">
                              {result.isJson
                                ? JSON.stringify(result.body, null, 2)
                                : String(result.body)
                              }
                            </pre>
                          </>
                      }
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {steps.length > 0 && (
        <div className="sim-panel__footer">
          <span className="muted">{'{{step0.field}}'} — reference a previous step's response</span>
        </div>
      )}
    </div>
  )
}

// ── Route node ────────────────────────────────────────────────────────────────

const METHOD_COLORS = {
  GET:    { border: '#22c55e', text: '#4ade80', bg: '#0d2b0d' },
  POST:   { border: '#3b82f6', text: '#60a5fa', bg: '#0d1f2b' },
  PUT:    { border: '#f59e0b', text: '#fbbf24', bg: '#2b1f0d' },
  PATCH:  { border: '#a78bfa', text: '#c4b5fd', bg: '#1f1a2b' },
  DELETE: { border: '#ef4444', text: '#f87171', bg: '#2b0d0d' },
}

function RouteNode({ data, selected, id }) {
  const c = METHOD_COLORS[data.method] || { border: '#555', text: '#aaa', bg: '#111' }
  return (
    <div className={`chain-node ${selected ? 'chain-node--selected' : ''}`}
      style={{ borderColor: selected ? c.border : '#2a2a2a' }}>
      <Handle type="target" position={Position.Left} className="chain-handle chain-handle--in" />
      <div className="chain-node__top">
        <div className="chain-node__badge" style={{ background: c.bg, color: c.text, borderColor: c.border }}>
          {data.method}
        </div>
        <button
          className="chain-node__delete"
          onClick={(e) => { e.stopPropagation(); data.onDelete(id) }}
          title="Remove from canvas"
        >×</button>
      </div>
      <div className="chain-node__path">{data.path}</div>
      <Handle type="source" position={Position.Right} className="chain-handle chain-handle--out" />
    </div>
  )
}

const NODE_TYPES = { route: RouteNode }

// ── Unique node ID ────────────────────────────────────────────────────────────

let _nodeCounter = 0
function nextId() { return `n${++_nodeCounter}` }

// ── ChainBuilder ──────────────────────────────────────────────────────────────

/**
 * savedState  — nodes/edges/simOpen saved by App when ChainBuilder last unmounted.
 *               Passed back on remount so state survives Routes↔Chain tab switches.
 * onStateChange — called on unmount so App can persist the latest state.
 */
export default function ChainBuilder({ routes, baseUrl = '', addRequest, savedState, onStateChange }) {
  // deleteNodeRef + onDeleteStable must be defined BEFORE useNodesState so the
  // initialiser can attach onDelete to restored nodes without a second render pass.
  const deleteNodeRef = useRef(null)
  const onDeleteStable = useCallback((id) => { deleteNodeRef.current(id) }, [])

  // Restore nodes from savedState, re-attaching the current onDelete callback.
  const [nodes, setNodes, onNodesChange] = useNodesState(
    () => (savedState?.nodes ?? []).map(n => ({
      ...n,
      data: { ...n.data, onDelete: onDeleteStable },
    }))
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState(savedState?.edges ?? [])
  const [cycleError, setCycleError] = useState(null)
  const [simOpen, setSimOpen] = useState(savedState?.simOpen ?? false)

  // Reconstruct placedRef from restored nodes so duplicate-route tracking works.
  const placedRef = useRef(null)
  if (placedRef.current === null) {
    const m = new Map()
    for (const n of (savedState?.nodes ?? [])) {
      m.set(`${n.data.method}:${n.data.path}`, n.id)
    }
    placedRef.current = m
  }

  const rfRef = useRef(null)     // ReactFlow instance (set via onInit)
  const canvasRef = useRef(null) // canvas wrapper div

  // Always keep a ref to the latest state so we can save it on unmount without
  // adding nodes/edges/simOpen as deps to the cleanup effect.
  const latestRef = useRef({ nodes, edges, simOpen })
  latestRef.current = { nodes, edges, simOpen }

  // Save state when unmounting (tab switch or page unload).
  // Strip onDelete (non-serialisable) from node data before saving.
  useEffect(() => {
    return () => {
      const { nodes, edges, simOpen } = latestRef.current
      onStateChange?.({
        nodes: nodes.map(n => ({
          ...n,
          data: { method: n.data.method, path: n.data.path, schema: n.data.schema },
        })),
        edges,
        simOpen,
      })
    }
  }, []) // eslint-disable-line

  // ── Drag-glitch fix ───────────────────────────────────────────────────────
  // When the simulation panel closes the canvas resizes (grid column collapses).
  // This can leave d3-drag's pointer tracking in a stuck state for ~1 second.
  // Dispatching pointercancel on the canvas forces d3-drag to release the pointer.
  useEffect(() => {
    if (!simOpen && canvasRef.current) {
      canvasRef.current.dispatchEvent(
        new PointerEvent('pointercancel', { bubbles: true, cancelable: false, pointerId: 1 })
      )
    }
  }, [simOpen])

  // deleteNode — stored in ref so the stable callback above never goes stale
  function deleteNode(id) {
    setNodes(ns => ns.filter(n => n.id !== id))
    setEdges(es => es.filter(e => e.source !== id && e.target !== id))
    for (const [key, nId] of placedRef.current.entries()) {
      if (nId === id) { placedRef.current.delete(key); break }
    }
  }
  deleteNodeRef.current = deleteNode

  const onConnect = useCallback((params) => {
    if (wouldCreateCycle(edges, params)) {
      setCycleError('Connection creates a cycle — chains cannot loop.')
      setTimeout(() => setCycleError(null), 3000)
      return
    }
    setCycleError(null)
    setEdges(eds => addEdge({ ...params, animated: true }, eds))
  }, [edges])

  function addRoute(route) {
    const key = `${route.method}:${route.path}`
    const id = nextId()
    placedRef.current.set(key, id)

    // Place node at current viewport center so it always appears where the user is looking.
    // Falls back to a simple grid position if the RF instance isn't ready yet.
    let pos = { x: 100, y: 100 }
    if (rfRef.current && canvasRef.current) {
      try {
        const rect = canvasRef.current.getBoundingClientRect()
        const flowPos = rfRef.current.screenToFlowPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        })
        // Small random jitter so back-to-back additions don't stack exactly
        pos = {
          x: flowPos.x - 70 + (Math.random() - 0.5) * 50,
          y: flowPos.y - 22 + (Math.random() - 0.5) * 50,
        }
      } catch {}
    }

    setNodes(ns => [...ns, {
      id,
      type: 'route',
      position: pos,
      data: { method: route.method, path: route.path, schema: route.schema, onDelete: onDeleteStable },
    }])
  }

  // Watch for add-route requests from App sidebar
  useEffect(() => {
    if (addRequest?.route) addRoute(addRequest.route)
  }, [addRequest]) // eslint-disable-line

  function clearCanvas() {
    setNodes([])
    setEdges([])
    setCycleError(null)
    setSimOpen(false)
    placedRef.current.clear()
  }

  const simSteps = simOpen ? topoSort(nodes, edges) : []

  return (
    <div className={`chain-builder ${simOpen ? 'chain-builder--sim' : ''}`}>
      {/* Canvas */}
      <div className="chain-builder__canvas" ref={canvasRef}>
        {cycleError && (
          <div className="chain-cycle-error">{cycleError}</div>
        )}

        {nodes.length === 0 && (
          <div className="chain-canvas-hint">
            <span className="chain-canvas-hint__glyph">◆</span>
            <p>Click + next to a route in the sidebar to add it to the canvas</p>
            <p className="chain-canvas-hint__sub">Connect output → input to map data flow between endpoints</p>
          </div>
        )}

        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={(instance) => { rfRef.current = instance }}
          nodeTypes={NODE_TYPES}
          fitView
          deleteKeyCode="Backspace"
          selectNodesOnDrag={false}
          elevateNodesOnSelect={false}
          autoPanOnNodeDrag={false}
          style={{ background: '#080808' }}
        >
          <Background color="#1a1a1a" gap={20} />
          <Controls />
          <Panel position="top-right">
            <div className="chain-panel-actions">
              <button
                className={`chain-sim-btn ${simOpen ? 'chain-sim-btn--active' : ''}`}
                onClick={() => setSimOpen(s => !s)}
                title="Open simulation runner"
              >
                {simOpen ? '◼ Close sim' : '▶ Simulate'}
              </button>
              <button className="chain-clear-btn" onClick={clearCanvas} title="Clear canvas">
                Clear
              </button>
            </div>
          </Panel>
        </ReactFlow>
      </div>

      {/* Simulation panel */}
      {simOpen && (
        <SimPanel
          key={[...nodes.map(n => n.id)].sort().join(',')}
          steps={simSteps}
          baseUrl={baseUrl}
          onClose={() => setSimOpen(false)}
        />
      )}
    </div>
  )
}
