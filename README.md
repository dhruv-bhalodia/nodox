# nodox

**API documentation that works the moment you run your server — no annotations, no YAML, no setup.**

nodox is an Express middleware that automatically discovers every route in your app, infers request/response schemas using a 5-layer detection pipeline, and serves a live interactive docs UI at `/__nodox`. Think FastAPI's `/docs`, but for Node.js — the first time you see it, your entire API is already there.

```bash
npm install nodox-cli
```

---

## Why nodox

Annotation-based tools start empty — you get a blank UI and a checklist of work: annotate this route, write this YAML block, run this code generator. Traffic-based tools show routes but leave them schema-less until you hit every endpoint manually. Either way, the documentation is a separate project you maintain alongside your actual code.

nodox is different. Add one line and your existing routes are immediately documented — with inferred schemas, an interactive playground, and live schema updates as real requests flow through.

| | nodox | express-oas-generator | swagger-jsdoc | tsoa | Postman |
|---|---|---|---|---|---|
| Setup | One middleware line | Two middleware placements (before + after routes) | Config file + point to routes | TypeScript decorators + codegen step | Manual collection or CLI generator |
| Annotate every route? | No | No | Yes (`@swagger` JSDoc) | Yes (class decorators) | No (but no Express integration) |
| Routes visible before any traffic? | Yes | No — empty until hit | No | No | Partial |
| Live request playground | Yes, built-in | Via Swagger UI | Via Swagger UI add-on | Via Swagger UI add-on | Separate app |
| Schema from real traffic | Yes (Layer 5) | Yes (only mechanism) | No | No | No |
| Multiple schema detection layers | Yes (5 layers) | No | No | No | No |
| Chain builder / flow simulation | Yes | No | No | No | Separate Flows tool |

---

## Quick start

```js
import express from 'express'
import nodox from 'nodox-cli'

const app = express()
app.use(express.json())
app.use(nodox(app))       // add this line

app.get('/users', handler)
app.post('/users', handler)

app.listen(3000)
// → docs live at http://localhost:3000/__nodox
```

That's the entire setup. Every route you've already written will appear in the UI. No annotations, no changes to your existing handlers, no configuration files.

You can also call `nodox()` without passing `app` — it detects the Express app automatically from the first incoming request:

```js
app.use(nodox())   // app detected from req.app at runtime
```

Passing `app` explicitly enables Layer 2 source screening immediately at startup rather than waiting for the first request.

---

## How schema detection works

nodox uses a **5-layer pipeline** to infer request/response schemas. Layers run in priority order — a higher-confidence result is never overwritten by a lower one.

| Layer | Source | What it does |
|---|---|---|
| 1 | `validate()` wrapper | Reads the schema you explicitly attached to a route |
| 2 | Source-code heuristic scan | Parses route handler source for Zod / Joi / yup / express-validator references |
| 3 | Dry-run with mock request | Calls the handler with a synthetic request, observes what it reads and validates |
| 4 | Test suite recording (`.apicache.json`) | Loads shapes recorded from your real test suite |
| 5 | Live `res.json()` interception | Intercepts actual responses as they happen in development |

**express-validator** chains are detected automatically in Layer 2 — no wrapper needed. If your routes use `check()`, `body()`, or `param()` validation chains, nodox extracts field names and infers types directly from the validator names (`isEmail`, `isInt`, `isUUID`, etc.).

Routes with no schema data still appear in the UI — you can still send requests and explore them from the playground. Schema confidence improves automatically as real traffic flows through or tests are run.

---

## A note on validate()

nodox is built on the assumption that most users will never touch `validate()` at all.

The entire detection pipeline — source scanning, dry-runs, test recording, live interception — exists specifically so that your existing, unmodified codebase gets useful documentation without any extra work. That is the core promise: no annotations, no changes to your handlers, no manual anything.

`validate()` exists for one specific case: when you want a schema to be *confirmed* rather than *inferred*. It is Layer 1 of 5. If you never use it, the other four layers still run and your routes are still documented.

---

## Explicit schema with validate() (optional)

Wrap a handler with `validate()` to attach a confirmed schema to a route. nodox reads it at Layer 1 and marks those fields as confirmed in the UI.

```js
import { validate } from 'nodox-cli'
import { z } from 'zod'

app.post('/users',
  validate(z.object({
    name:  z.string(),
    email: z.string().email(),
    age:   z.number().int().optional(),
  })),
  async (req, res) => {
    const user = await db.createUser(req.body)
    res.json(user)
  }
)
```

`validate()` also accepts **Joi**, **yup**, and plain **JSON Schema** objects:

```js
import Joi from 'joi'
app.post('/login',
  validate(Joi.object({ username: Joi.string(), password: Joi.string() })),
  handler
)
```

Beyond documenting the request schema, `validate()` also:

- **Validates `req.body`** and returns a `400` with structured error details on failure, or calls `next()` with `req.body` replaced by the parsed/coerced value on success
- Accepts a `response` option to document the response schema (display only — outgoing responses are not validated):

```js
const UserSchema  = z.object({ name: z.string(), email: z.string().email() })
const UserResponse = z.object({ id: z.number(), name: z.string(), email: z.string() })

app.post('/users',
  validate(UserSchema, { response: UserResponse }),
  handler
)
```

- Accepts a `strict` option to reject fields not declared in the schema:

```js
app.post('/users',
  validate(UserSchema, { strict: true }),   // unknown fields → 400
  handler
)
```

---

## Test suite integration

Record real request/response shapes from your existing tests automatically — no changes to test code required:

```bash
npx nodox init    # injects nodox-cli/jest-setup into your Jest/Vitest config
```

`init` also adds `.apicache.json` to your `.gitignore` automatically if one exists.

Recorded shapes are stored in `.apicache.json` and loaded on the next server start. This is Layer 4 — shapes observed from real test data, not synthesized. The cache stores the number of times each route was seen and when it was last recorded, and merges new observations into existing entries rather than overwriting them.

nodox searches for `.apicache.json` upward from your working directory (up to 5 levels), so monorepo setups with a cache at the workspace root are supported without any path configuration.

Run `npx nodox prune` to reset the cache.

---

## UI features

- **Schema tab** — field names, types, required badges, and a confidence indicator per field
- **Playground** — send live requests directly from the browser; path params render as inline inputs; body fields are pre-filled from inferred schema; query parameters are documented for GET, DELETE, HEAD, and OPTIONS routes
- **Chain builder** — connect routes on a canvas, wire output fields to input fields, and simulate multi-step flows with `{{step0.fieldName}}` interpolation
- **Environment switcher** — swap the base URL between local, staging, and production without leaving the UI
- **Response diff** — save a baseline response and compare it against subsequent calls to catch regressions

---

## Options

```js
app.use(nodox(app, {
  uiPath:    '/__nodox',  // URL prefix for the docs UI
  log:       true,        // print startup banner with route count and URL
  schema:    true,        // enable schema detection pipeline
  intercept: true,        // enable live res.json() interception (Layer 5)
  force:     false,       // allow running in NODE_ENV=production
}))
```

nodox is a **no-op in production** by default (`NODE_ENV=production`). Pass `force: true` to override — but do not expose `/__nodox` publicly, as it reveals all routes, inferred schemas, and a full request playground.

---

## CLI

```bash
npx nodox init    # set up test suite integration (Jest or Vitest); updates .gitignore
npx nodox prune   # clear .apicache.json
npx nodox status  # print route count and schema coverage
```

---

## TypeScript

Type declarations are included. The package is ESM-first with a CJS fallback.

```ts
import nodox, { validate } from 'nodox-cli'
import type { NodoxOptions, ValidateOptions } from 'nodox-cli'
```

`NodoxOptions` covers all middleware options. `ValidateOptions` covers the `strict` and `response` options accepted by `validate()`.

Both Zod v3 and Zod v4 are supported. nodox uses different patching strategies for each (prototype-level for v3, per-instance for v4) and detects the installed version automatically.

---

## Compatibility

- Node.js ≥ 18
- Express ≥ 4 (Express 5 is supported)
- Schema libraries: Zod v3 and v4, Joi, yup, express-validator v6 and v7, plain JSON Schema

---

## License

MIT
