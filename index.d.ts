import type { RequestHandler, Application } from 'express'

// ── Options ───────────────────────────────────────────────────────────────────

export interface NodoxOptions {
  /**
   * URL prefix for the documentation UI and WebSocket.
   * @default '/__nodox'
   */
  uiPath?: string

  /**
   * Log startup info (route count, UI URL) to the console.
   * @default true
   */
  log?: boolean

  /**
   * Enable automatic schema detection (Zod / Joi / yup / express-validator).
   * @default true
   */
  schema?: boolean

  /**
   * Enable live request/response interception to observe shapes from real traffic.
   * @default true
   */
  intercept?: boolean

  /**
   * Allow nodox to run when NODE_ENV=production.
   * By default nodox is a no-op in production to prevent accidental exposure.
   * Only set this to true if the UI is protected behind authentication.
   * @default false
   */
  force?: boolean
}

// ── validate() ────────────────────────────────────────────────────────────────

export interface ValidateOptions {
  /**
   * Reject fields not declared in the schema (Zod: strict mode, Joi: allowUnknown=false).
   * @default false
   */
  strict?: boolean

  /**
   * Schema describing the response body. Used for documentation only — nodox
   * displays it in the UI but does not validate outgoing responses.
   * Accepts a Zod schema, Joi schema, or plain JSON Schema object.
   */
  response?: object
}

/**
 * Create a validation middleware that also registers the schema with nodox.
 *
 * This is the recommended way to get complete, reliable schema documentation.
 * The middleware validates `req.body` and returns 400 with structured error
 * details on failure, or calls `next()` with `req.body` replaced by the
 * parsed/coerced value on success.
 *
 * @param schema  A Zod schema, Joi schema, yup schema, or plain JSON Schema object.
 * @param options Optional settings.
 *
 * @example
 * import { validate } from 'nodox-cli'
 * import { z } from 'zod'
 *
 * const CreateUser = z.object({ name: z.string(), email: z.string().email() })
 *
 * app.post('/users', validate(CreateUser), (req, res) => {
 *   // req.body is validated and typed
 *   res.status(201).json(req.body)
 * })
 */
export function validate(schema: object, options?: ValidateOptions): RequestHandler

// ── nodox() ───────────────────────────────────────────────────────────────────

/**
 * nodox Express middleware.
 *
 * Mounts an interactive API documentation UI at `/__nodox` (configurable).
 * Automatically discovers routes, detects Zod/Joi/yup/express-validator schemas,
 * and provides a live playground — zero annotations, zero config.
 *
 * @example
 * import express from 'express'
 * import nodox from 'nodox-cli'
 *
 * const app = express()
 * app.use(express.json())
 * app.use(nodox(app))       // pass app for best results
 *
 * app.get('/users', handler)
 * app.listen(3000)
 * // → http://localhost:3000/__nodox
 */
declare function nodox(options?: NodoxOptions): RequestHandler
declare function nodox(app: Application, options?: NodoxOptions): RequestHandler

export default nodox
