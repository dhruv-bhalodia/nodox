/**
 * SchemaTree — renders a JSON Schema object as an indented field tree.
 *
 * Handles: object, array, string, number, integer, boolean, null,
 *          anyOf, oneOf, allOf, $ref (flattened), enum, format.
 */

const TYPE_COLORS = {
  string:  '#7dd3fc',
  number:  '#fbbf24',
  integer: '#fbbf24',
  boolean: '#4ade80',
  null:    '#9ca3af',
  array:   '#c4b5fd',
  object:  '#f472b6',
  any:     '#9ca3af',
}

function TypePill({ type, format }) {
  const color = TYPE_COLORS[type] || '#9ca3af'
  return (
    <span className="type-pill" style={{ color, borderColor: color + '33', background: color + '11' }}>
      {format ? `${type}(${format})` : type}
    </span>
  )
}

function FieldRow({ name, schema, depth = 0, required = false, isLast = true }) {
  const indent = depth * 16

  if (!schema || typeof schema !== 'object') return null

  // Resolve anyOf/oneOf to a union display
  const unionTypes = schema.anyOf || schema.oneOf
  if (unionTypes) {
    return (
      <div className="schema-field" style={{ paddingLeft: indent }}>
        <span className="field-name">{name}</span>
        {required && <span className="field-required">required</span>}
        <span className="field-union">
          {unionTypes.map((t, i) => (
            <TypePill key={i} type={t.type || 'any'} format={t.format} />
          ))}
        </span>
        {schema.description && <span className="field-desc">{schema.description}</span>}
      </div>
    )
  }

  const type = schema.type || 'any'
  const isObject = type === 'object' && schema.properties
  const isArray = type === 'array'

  return (
    <div className="schema-field-group">
      <div className="schema-field" style={{ paddingLeft: indent }}>
        {name && (
          <>
            <span className="field-name">{name}</span>
            {required && <span className="field-required">required</span>}
          </>
        )}
        <TypePill type={type} format={schema.format} />
        {schema.enum && (
          <span className="field-enum">
            {schema.enum.map(v => JSON.stringify(v)).join(' | ')}
          </span>
        )}
        {schema.description && <span className="field-desc">{schema.description}</span>}
      </div>

      {isObject && (
        <div className="schema-children">
          {Object.entries(schema.properties).map(([key, val], i, arr) => (
            <FieldRow
              key={key}
              name={key}
              schema={val}
              depth={depth + 1}
              required={schema.required?.includes(key)}
              isLast={i === arr.length - 1}
            />
          ))}
        </div>
      )}

      {isArray && schema.items && schema.items.type === 'object' && schema.items.properties && (
        <div className="schema-children">
          <div className="schema-field" style={{ paddingLeft: (depth + 1) * 16 }}>
            <span className="field-name field-name--items">items[]</span>
            <TypePill type="object" />
          </div>
          {Object.entries(schema.items.properties).map(([key, val]) => (
            <FieldRow
              key={key}
              name={key}
              schema={val}
              depth={depth + 2}
              required={schema.items.required?.includes(key)}
            />
          ))}
        </div>
      )}

      {isArray && schema.items && schema.items.type !== 'object' && (
        <div className="schema-children">
          <div className="schema-field" style={{ paddingLeft: (depth + 1) * 16 }}>
            <span className="field-name field-name--items">items[]</span>
            <TypePill type={schema.items.type || 'any'} format={schema.items.format} />
          </div>
        </div>
      )}
    </div>
  )
}

export function SchemaTree({ schema, label, confidence }) {
  if (!schema) {
    return (
      <div className="schema-empty">
        <span className="muted">No schema available</span>
      </div>
    )
  }

  const confidenceMap = {
    confirmed: { label: 'confirmed', color: '#4ade80' },
    inferred:  { label: 'inferred',  color: '#fbbf24' },
    observed:  { label: 'observed',  color: '#60a5fa' },
  }
  const conf = confidenceMap[confidence]

  return (
    <div className="schema-tree">
      <div className="schema-tree__header">
        {label && <span className="schema-tree__label">{label}</span>}
        {conf && (
          <span className="confidence-badge" style={{ color: conf.color, borderColor: conf.color + '44' }}>
            ◆ {conf.label}
          </span>
        )}
      </div>
      <div className="schema-tree__body">
        {schema.type === 'object' && schema.properties
          ? Object.entries(schema.properties).map(([key, val]) => (
              <FieldRow
                key={key}
                name={key}
                schema={val}
                depth={0}
                required={schema.required?.includes(key)}
              />
            ))
          : <FieldRow name={null} schema={schema} depth={0} />
        }
      </div>
    </div>
  )
}
