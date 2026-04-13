# nodox

**Instant interactive API docs for Express — zero config, zero annotations.**

nodox is a drop-in middleware that automatically discovers all your Express routes, infers their request/response schemas, and serves a live documentation UI at `/__nodox`. Think FastAPI's `/docs`, but for Node.js.

```
npm install nodox
```

---

## Quick start

```js
import express from 'express'
import nodox from 'nodox'

const app = express()
app.use(express.json())
app.use(nodox(app))          // one line — that's it

app.get('/users', handler)
app.post('/users', handler)

app.listen(3000)
// → docs at http://localhost:3000/__nodox
```

---

## How it works

nodox uses a **5-layer schema detection pipeline** — each layer fills gaps left by the one above, so you get useful docs even on a completely unannotated codebase.

| Layer | Source | Confidence |
|---|---|---|
| 1 | `validate(schema)` explicit wrapper | confirmed ✓ |
| 2 | Source-code heuristic scan | — |
| 3 | Dry-run with mock request | inferred ~ |
| 4 | Test suite recording (`.apicache.json`) | observed |
| 5 | Live `res.json()` interception | observed |

Higher-confidence layers are never downgraded by lower ones.

---

## Explicit schema (recommended)

Wrap any route handler with `validate()` to get confirmed schema detection instantly:

```js
import { validate } from 'nodox'
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

`validate()` also works with **Joi**, **yup**, and plain **JSON Schema** objects.

```js
import Joi from 'joi'
app.post('/login', validate(Joi.object({ username: Joi.string(), password: Joi.string() })), handler)
```

---

## Test suite integration

Record real request/response shapes from your existing tests — no code changes required:

```bash
npx nodox init    # injects nodox/jest-setup into your Jest/Vitest config
```

Shapes are stored in `.apicache.json` and loaded on the next server start. Run `npx nodox prune` to reset the cache.

---

## UI features

- **Schema tab** — field names, types, required badges, confidence level
- **Playground** — send real requests directly from the browser; path params render as inline inputs; body fields are pre-filled from the inferred schema
- **Chain builder** — wire routes together on a canvas, connect output → input, and run simulations with `{{step0.fieldName}}` variable interpolation between steps
- **Environment switcher** — change the base URL to target staging or production
- **Response diff** — save a baseline response and compare against subsequent calls

---

## Options

```js
app.use(nodox(app, {
  uiPath:    '/__nodox',  // URL prefix for the docs UI
  log:       true,        // print startup banner with route count + URL
  schema:    true,        // enable schema detection layers
  intercept: true,        // enable live res.json() wrapping
  force:     false,       // allow running in NODE_ENV=production
}))
```

By default nodox is a **no-op in production** (`NODE_ENV=production`). Pass `force: true` to override.

---

## CLI

```bash
npx nodox init    # set up test suite integration
npx nodox prune   # clear .apicache.json
npx nodox status  # show route count + schema coverage
```

---

## TypeScript

Type declarations are included. The package is ESM-first with a CJS fallback.

```ts
import nodox, { validate } from 'nodox'
import type { NodoxOptions, ValidateOptions } from 'nodox'
```

---

## Requirements

- Node.js ≥ 18
- Express ≥ 4

---

## License

MIT
