import { useState, useMemo, lazy, Suspense, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNodoxSocket } from './hooks/useNodoxSocket'
import { SchemaTree } from './components/SchemaTree'
import { Playground } from './components/Playground'
import './styles.css'

// Lazy-load the chain builder — only fetches the React Flow chunk when the Chain tab opens
const ChainBuilder = lazy(() => import('./components/ChainBuilder'))

// ── Tour ──────────────────────────────────────────────────────────────────────

const TOUR_STEPS = [
  {
    target: null,
    title: 'Welcome to nodox ◆',
    body: 'Auto-generated interactive API docs for your Express app — zero annotations, zero config, one line of setup.',
  },
  {
    target: '.route-list',
    title: 'Your API routes',
    body: 'Every Express route is discovered at startup. Click any route to see its input schema, output schema, and playground.',
  },
  {
    target: '.sidebar__controls',
    title: 'Schema confidence badges',
    body: '✓ green = confirmed via validate(). ~ yellow = auto-inferred. Output schemas populate live as real requests flow in.',
  },
  {
    target: '.detail-tabs',
    title: 'Schema & Playground',
    body: 'Schema tab shows field names, types, required badges. Playground sends real requests — path params render as inline inputs.',
    needsRoute: true,
  },
  {
    target: '.env-switcher',
    title: 'Environment switcher',
    body: 'Type a base URL to target staging or production. Leave blank to use the current origin (localhost). This also applies in Chain simulation.',
  },
  {
    target: '.view-tabs',
    title: 'Chain builder',
    body: 'Switch to Chain to wire endpoints together. Add routes to the canvas, connect them, then click Simulate. Use {{step0.field}} to pipe data between steps.',
  },
]

function Tour({ step, routes, selectedRoute, onSelectRoute, onNext, onPrev, onFinish }) {
  const s = TOUR_STEPS[step]
  const total = TOUR_STEPS.length
  const isFirst = step === 0
  const isLast  = step === total - 1

  useEffect(() => {
    // Remove any previous highlight
    document.querySelectorAll('.tour-target').forEach(el => el.classList.remove('tour-target'))

    // Auto-select first route for steps that need a route visible
    if (s.needsRoute && !selectedRoute && routes.length > 0) {
      onSelectRoute(routes[0])
    }

    // Highlight target element
    if (s.target) {
      const el = document.querySelector(s.target)
      if (el) {
        el.classList.add('tour-target')
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }

    return () => {
      document.querySelectorAll('.tour-target').forEach(el => el.classList.remove('tour-target'))
    }
  }, [step])  // eslint-disable-line

  return createPortal(
    <div className="tour-card" key={step}>
      <div className="tour-card__header">
        <span className="tour-card__step">{step + 1} / {total}</span>
        <span className="tour-card__title">{s.title}</span>
        <button className="tour-card__skip" onClick={onFinish} title="Close tour">✕</button>
      </div>
      <p className="tour-card__body">{s.body}</p>
      <div className="tour-card__actions">
        {!isFirst && (
          <button className="tour-btn tour-btn--ghost" onClick={onPrev}>← Back</button>
        )}
        <button className="tour-btn tour-btn--primary" onClick={isLast ? onFinish : onNext}>
          {isLast ? 'Get started →' : 'Next →'}
        </button>
      </div>
    </div>,
    document.body
  )
}

const METHOD_COLORS = {
  GET:     { bg: '#0d2b0d', border: '#22c55e', text: '#4ade80' },
  POST:    { bg: '#0d1f2b', border: '#3b82f6', text: '#60a5fa' },
  PUT:     { bg: '#2b1f0d', border: '#f59e0b', text: '#fbbf24' },
  PATCH:   { bg: '#1f1a2b', border: '#a78bfa', text: '#c4b5fd' },
  DELETE:  { bg: '#2b0d0d', border: '#ef4444', text: '#f87171' },
  OPTIONS: { bg: '#0d2b2b', border: '#06b6d4', text: '#22d3ee' },
  HEAD:    { bg: '#1a1a1a', border: '#6b7280', text: '#9ca3af' },
}

function MethodBadge({ method }) {
  const colors = METHOD_COLORS[method] || METHOD_COLORS.GET
  return (
    <span className="method-badge" style={{
      background: colors.bg,
      border: `1px solid ${colors.border}`,
      color: colors.text,
    }}>
      {method}
    </span>
  )
}

function StatusDot({ status }) {
  const map = {
    connected:    { color: '#4ade80', label: 'connected',    pulse: true },
    connecting:   { color: '#fbbf24', label: 'connecting…',  pulse: true },
    reconnecting: { color: '#f59e0b', label: 'reconnecting…',pulse: true },
    disconnected: { color: '#ef4444', label: 'disconnected', pulse: false },
  }
  const s = map[status] || map.disconnected
  return (
    <span className="status-dot-wrap">
      <span className={`status-dot ${s.pulse ? 'status-dot--pulse' : ''}`}
        style={{ '--dot-color': s.color }} />
      <span className="status-label">{s.label}</span>
    </span>
  )
}

function RouteRow({ route, isSelected, onClick }) {
  return (
    <button className={`route-row ${isSelected ? 'route-row--selected' : ''}`} onClick={onClick}>
      <MethodBadge method={route.method} />
      <span className="route-path">{route.path}</span>
      {route.schema?.inputConfidence === 'confirmed' && (
        <span className="route-tag route-tag--confirmed" title="Schema confirmed via validate()">✓</span>
      )}
      {route.schema?.inputConfidence === 'inferred' && (
        <span className="route-tag route-tag--inferred" title="Schema inferred via dry-run">~</span>
      )}
      <span className="route-arrow">›</span>
    </button>
  )
}

function EmptyState({ status }) {
  if (status === 'connecting' || status === 'reconnecting') {
    return (
      <div className="empty-state">
        <div className="empty-state__spinner" />
        <p>{status === 'reconnecting' ? 'Server restarted — reconnecting…' : 'Connecting…'}</p>
      </div>
    )
  }
  if (status === 'disconnected') {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">⚡</div>
        <p>Server is offline</p>
        <p className="empty-state__sub">Start your Express server to see routes</p>
      </div>
    )
  }
  return (
    <div className="empty-state">
      <div className="empty-state__icon">◆</div>
      <p>No routes found</p>
      <p className="empty-state__sub">Make sure nodox is registered before your routes</p>
      <pre className="empty-state__code">{`app.use(express.json())\napp.use(nodox(app))\n\napp.get('/api/users', handler)`}</pre>
    </div>
  )
}

// ── Environment switcher ──────────────────────────────────────────────────────

function EnvSwitcher({ baseUrl, onChange }) {
  return (
    <div className="env-switcher">
      <span className="env-switcher__label">ENV</span>
      <input
        className="env-switcher__input"
        value={baseUrl}
        onChange={e => onChange(e.target.value)}
        placeholder="local"
        title="Base URL for Playground requests (leave empty to use current origin)"
        spellCheck={false}
      />
    </div>
  )
}

// ── Route detail panel ────────────────────────────────────────────────────────

const DETAIL_TABS = ['Schema', 'Playground']

function RouteDetail({ route, baseUrl }) {
  const [tab, setTab] = useState('Schema')

  if (!route) {
    return (
      <div className="detail-placeholder">
        <div className="detail-placeholder__inner">
          <span className="detail-placeholder__glyph">◆</span>
          <p>Select a route to explore</p>
        </div>
      </div>
    )
  }

  const inputSchema  = route.schema?.input  ?? null
  const outputSchema = route.schema?.output ?? null
  const inputConf    = route.schema?.inputConfidence  ?? 'none'
  const outputConf   = route.schema?.outputConfidence ?? 'none'

  return (
    <div className="detail-panel">
      {/* Header */}
      <div className="detail-panel__header">
        <MethodBadge method={route.method} />
        <span className="detail-panel__path">{route.path}</span>
      </div>

      {/* Middleware chain */}
      {route.middlewareNames?.length > 0 && (
        <div className="detail-panel__section">
          <div className="detail-panel__section-title">Middleware chain</div>
          <div className="middleware-chain">
            {route.middlewareNames.map((name, i) => (
              <div key={i} className="middleware-item">
                <span className="middleware-item__idx">{i + 1}</span>
                <span className="middleware-item__name">{name || 'anonymous'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="detail-tabs">
        {DETAIL_TABS.map(t => (
          <button
            key={t}
            className={`detail-tab ${tab === t ? 'detail-tab--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Schema tab */}
      {tab === 'Schema' && (
        <div className="detail-panel__section">
          <SchemaTree
            schema={inputSchema}
            label="Request body"
            confidence={inputConf !== 'none' ? inputConf : undefined}
          />
          {outputSchema && (
            <div style={{ marginTop: 20 }}>
              <SchemaTree
                schema={outputSchema}
                label="Response body"
                confidence={outputConf !== 'none' ? outputConf : undefined}
              />
            </div>
          )}
          {!inputSchema && !outputSchema && (
            <div className="schema-no-data">
              <p>No schema detected yet.</p>
              <p className="muted">
                Use <code>validate(schema)</code> for instant schema detection, or make a
                request to observe the response shape.
              </p>
              <pre className="empty-state__code">{`import { validate } from 'nodox-cli'\nimport { z } from 'zod'\n\napp.post('${route.path}',\n  validate(z.object({ id: z.number() })),\n  handler\n)`}</pre>
            </div>
          )}
        </div>
      )}

      {/* Playground tab */}
      {tab === 'Playground' && (
        <div className="detail-panel__section detail-panel__section--flush">
          <Playground route={route} baseUrl={baseUrl} />
        </div>
      )}
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const { routes, status, lastSync } = useNodoxSocket()
  const [selectedRoute, setSelectedRoute] = useState(null)
  const [filter, setFilter] = useState('')
  const [methodFilter, setMethodFilter] = useState('ALL')
  const [view, setView] = useState('routes') // 'routes' | 'chain'
  const [baseUrl, setBaseUrl] = useState(() => {
    try { return localStorage.getItem('nodox-base-url') || '' } catch { return '' }
  })
  const [tourStep, setTourStep] = useState(() => {
    try { return localStorage.getItem('nodox-tour-done') ? -1 : 0 } catch { return 0 }
  })
  const [chainAddRequest, setChainAddRequest] = useState(null)
  // Persist ChainBuilder state (nodes/edges/simOpen) across Routes↔Chain tab switches.
  // ChainBuilder writes here on unmount; reads it as initialState on remount.
  const chainSavedState = useRef(null)
  const handleChainStateChange = useCallback((state) => { chainSavedState.current = state }, [])

  function handleBaseUrlChange(url) {
    setBaseUrl(url)
    try { localStorage.setItem('nodox-base-url', url) } catch {}
  }

  function dismissTour() {
    setTourStep(-1)
    try { localStorage.setItem('nodox-tour-done', '1') } catch {}
  }

  const methods = useMemo(() => {
    const set = new Set(routes.map(r => r.method))
    return ['ALL', ...Array.from(set).sort()]
  }, [routes])

  const filtered = useMemo(() => routes.filter(r => {
    const matchMethod = methodFilter === 'ALL' || r.method === methodFilter
    const matchPath = !filter || r.path.toLowerCase().includes(filter.toLowerCase())
    return matchMethod && matchPath
  }), [routes, filter, methodFilter])

  const activeRoute = selectedRoute
    ? routes.find(r => r.method === selectedRoute.method && r.path === selectedRoute.path) ?? null
    : null

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar__header">
          <div className="sidebar__logo">
            <span className="sidebar__logo-mark">◆</span>
            <span className="sidebar__logo-text">nodox</span>
          </div>
          <div className="sidebar__header-right">
            <div className="view-tabs">
              <button
                className={`view-tab ${view === 'routes' ? 'view-tab--active' : ''}`}
                onClick={() => setView('routes')}
              >Routes</button>
              <button
                className={`view-tab ${view === 'chain' ? 'view-tab--active' : ''}`}
                onClick={() => setView('chain')}
              >Chain</button>
            </div>
            <button
              className="tour-trigger-btn"
              title="Start tour"
              onClick={() => setTourStep(0)}
            >?</button>
            <StatusDot status={status} />
          </div>
        </div>

        {view === 'routes' && (<>
          <div className="sidebar__controls">
            <input
              className="search-input"
              type="text"
              placeholder="Filter routes…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            <div className="method-filters">
              {methods.map(m => (
                <button
                  key={m}
                  className={`method-filter-btn ${methodFilter === m ? 'method-filter-btn--active' : ''}`}
                  onClick={() => setMethodFilter(m)}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar__count">
            {filtered.length} {filtered.length === 1 ? 'route' : 'routes'}
            {(filter || methodFilter !== 'ALL') ? ` (${routes.length} total)` : ''}
          </div>

          <div className="route-list">
            {filtered.length === 0
              ? <EmptyState status={status} />
              : filtered.map(route => (
                  <RouteRow
                    key={`${route.method}:${route.path}`}
                    route={route}
                    isSelected={activeRoute?.method === route.method && activeRoute?.path === route.path}
                    onClick={() => setSelectedRoute(route)}
                  />
                ))
            }
          </div>
        </>)}

        {view === 'chain' && (<>
          <div className="sidebar__section-title">Routes — click to add to canvas</div>
          <div className="route-list">
            {routes.length === 0
              ? <EmptyState status={status} />
              : routes.map(route => {
                  const c = METHOD_COLORS[route.method] || METHOD_COLORS.GET
                  return (
                    <button
                      key={`${route.method}:${route.path}`}
                      className="chain-sidebar-row"
                      title="Add to canvas"
                      onClick={() => setChainAddRequest({ route, t: Date.now() })}
                    >
                      <span className="method-badge" style={{
                        background: c.bg,
                        border: `1px solid ${c.border}`,
                        color: c.text,
                      }}>
                        {route.method}
                      </span>
                      <span className="chain-sidebar-path">{route.path}</span>
                      <span className="chain-sidebar-add">+</span>
                    </button>
                  )
                })
            }
          </div>
        </>)}

        <div className="sidebar__footer">
          <span className="muted">nodox v0.1.1</span>
          <EnvSwitcher baseUrl={baseUrl} onChange={handleBaseUrlChange} />
        </div>
      </aside>

      {/* Main */}
      <main className={`main ${view === 'chain' ? 'main--chain' : ''}`}>
        {view === 'chain' ? (
          <Suspense fallback={<div className="chain-loading"><div className="empty-state__spinner" /><p>Loading chain builder…</p></div>}>
            <ChainBuilder
              routes={routes}
              baseUrl={baseUrl}
              addRequest={chainAddRequest}
              savedState={chainSavedState.current}
              onStateChange={handleChainStateChange}
            />
          </Suspense>
        ) : (
          <RouteDetail route={activeRoute} baseUrl={baseUrl} />
        )}
      </main>

      {/* Tour overlay */}
      {tourStep >= 0 && (
        <Tour
          step={tourStep}
          routes={routes}
          selectedRoute={activeRoute}
          onSelectRoute={setSelectedRoute}
          onNext={() => setTourStep(s => Math.min(s + 1, TOUR_STEPS.length - 1))}
          onPrev={() => setTourStep(s => Math.max(s - 1, 0))}
          onFinish={dismissTour}
        />
      )}
    </div>
  )
}
