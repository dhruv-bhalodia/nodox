const __importMetaUrl = require('url').pathToFileURL(__filename).href;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.js
var index_exports = {};
__export(index_exports, {
  default: () => nodox,
  validate: () => validate
});
module.exports = __toCommonJS(index_exports);

// src/middleware/app-patcher.js
var ROUTE_METHODS = ["get", "post", "put", "delete", "del", "patch", "options", "head", "all"];
function patchApp(app, { onRouteRegistered: onRouteRegistered2, onUse } = {}) {
  const originalMethods = {};
  originalMethods.use = app.use.bind(app);
  app.use = function patchedUse(...args) {
    const result = originalMethods.use.apply(app, args);
    if (app._router?.stack?.length) {
      const lastLayer = app._router.stack[app._router.stack.length - 1];
      const pathArg = typeof args[0] === "string" ? args[0] : null;
      if (pathArg && lastLayer && !lastLayer._nodoxPath) {
        lastLayer._nodoxPath = pathArg;
      }
      const fnArgs = args.filter((a) => a && typeof a === "function");
      for (const fn of fnArgs) {
        if (typeof fn.handle === "function" && typeof fn.set === "function") {
          if (lastLayer && !lastLayer._nodoxSubApp) {
            lastLayer._nodoxSubApp = fn;
          }
          break;
        }
      }
    }
    if (typeof onUse === "function") onUse();
    return result;
  };
  for (const method of ROUTE_METHODS) {
    if (typeof app[method] !== "function") continue;
    originalMethods[method] = app[method].bind(app);
    app[method] = function patchedMethod(path3, ...handlers) {
      const result = originalMethods[method].call(app, path3, ...handlers);
      if (typeof onRouteRegistered2 === "function") {
        onRouteRegistered2(method.toUpperCase(), path3, handlers);
      }
      return result;
    };
  }
  return function unpatch() {
    app.use = originalMethods.use;
    for (const method of ROUTE_METHODS) {
      if (originalMethods[method]) {
        app[method] = originalMethods[method];
      }
    }
  };
}

// src/extractor/route-extractor.js
var import_module = require("module");
var _require = (0, import_module.createRequire)(__importMetaUrl);
function getExpressVersion() {
  try {
    return _require("express/package.json").version || null;
  } catch {
    return null;
  }
}
function extractRoutes(app) {
  const routes = [];
  const router = _getRouter(app);
  if (!router) return routes;
  walkStack(router.stack, "", routes);
  const seen = /* @__PURE__ */ new Set();
  return routes.filter((r) => {
    const key = `${r.method}:${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function _getRouter(app) {
  if (typeof app.lazyrouter === "function") {
    try {
      app.lazyrouter();
    } catch {
    }
  }
  if (app._router?.stack) return app._router;
  if (app.router?.stack) return app.router;
  return null;
}
function walkStack(stack, prefix, routes) {
  if (!Array.isArray(stack)) return;
  for (const layer of stack) {
    if (!layer) continue;
    if (layer.route) {
      extractFromRoute(layer.route, prefix, routes);
    } else {
      let childStack = layer.handle?.stack ?? null;
      if (!childStack && layer.handle) {
        if (typeof layer.handle.lazyrouter === "function") {
          try {
            layer.handle.lazyrouter();
          } catch {
          }
        }
        childStack = layer.handle._router?.stack ?? null;
      }
      if (!childStack && layer._nodoxSubApp) {
        const subApp = layer._nodoxSubApp;
        if (typeof subApp.lazyrouter === "function") {
          try {
            subApp.lazyrouter();
          } catch {
          }
        }
        childStack = subApp._router?.stack ?? null;
      }
      if (childStack) {
        const mountPath = extractMountPath(layer);
        walkStack(childStack, prefix + mountPath, routes);
      }
    }
  }
}
function extractMountPath(layer) {
  if (layer._nodoxPath) return layer._nodoxPath;
  if (!layer.regexp) return "";
  if (layer.regexp.fast_slash) return "";
  if (layer.regexp.fast_star) return "*";
  const src = layer.regexp.source;
  const match = src.match(/^\^\\\/(.+?)\\\/\?/);
  if (match) {
    return "/" + match[1].replace(/\\\//g, "/");
  }
  const match5 = src.match(/^\^\\\/(.+?)(?:\\\/\?|\/\?)?\$?\//);
  if (match5) {
    return "/" + match5[1].replace(/\\\//g, "/");
  }
  return "";
}
function isWildcardPath(routePath) {
  if (!routePath) return true;
  if (routePath.startsWith("/__nodox")) return true;
  const catchAlls = ["*", "/*", "(.*)", "/(.*)"];
  return catchAlls.includes(routePath);
}
function extractFromRoute(route, prefix, routes) {
  const path3 = normalizePath(prefix + route.path);
  if (isWildcardPath(path3)) return;
  const middlewareNames = route.stack.map((l) => l.handle?.name || "anonymous").filter(Boolean);
  const handlers = route.stack.map((l) => l.handle).filter((h) => typeof h === "function");
  for (const layer of route.stack) {
    const method = layer.method?.toUpperCase();
    if (!method) continue;
    routes.push({
      method,
      path: path3,
      middlewareNames,
      handlers,
      hasValidator: false
      // Updated by schema detector in Phase 2
    });
  }
}
function normalizePath(path3) {
  return ("/" + path3).replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}
function checkExpressCompatibility(app) {
  const version = getExpressVersion();
  const major = version ? parseInt(version.split(".")[0], 10) : null;
  if (major !== null && (major < 4 || major > 5)) {
    return {
      compatible: false,
      warning: `[nodox] Express ${version} is not supported. nodox requires Express 4.x or 5.x.`
    };
  }
  const isExpressApp = app != null && typeof app.use === "function" && typeof app.get === "function" && typeof app.listen === "function";
  if (!isExpressApp) {
    return {
      compatible: false,
      warning: "[nodox] The first argument to nodox() must be an Express app instance."
    };
  }
  if (typeof app.lazyrouter === "function") {
    try {
      app.lazyrouter();
    } catch {
    }
  }
  return { compatible: true, version: version || "unknown" };
}

// src/websocket/ws-server.js
var import_ws = require("ws");
var NodoxWebSocketServer = class {
  /** @type {WebSocketServer|null} */
  #wss = null;
  /** @type {Set<WebSocket>} */
  #clients = /* @__PURE__ */ new Set();
  /** @type {() => object} */
  #getState;
  /**
   * @param {object} options
   * @param {Function} options.getState - returns current full state object
   */
  constructor({ getState }) {
    this.#getState = getState;
  }
  /**
   * Attach the WebSocket server to an existing HTTP server.
   * @param {import('http').Server} httpServer
   */
  attach(httpServer) {
    this.#wss = new import_ws.WebSocketServer({
      server: httpServer,
      path: "/__nodox_ws",
      // Only accept connections from the same host (localhost/127.0.0.1).
      // This blocks cross-origin reads from malicious third-party web pages
      // while still allowing the nodox UI served on the same server to connect.
      verifyClient({ origin, req }) {
        if (!origin) return true;
        try {
          const url = new URL(origin);
          const host = req.headers.host || "";
          if (url.host === host) return true;
          const hostname = url.hostname;
          if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
          if (hostname.endsWith(".localhost")) return true;
          console.warn(`[nodox] WebSocket connection rejected from origin: ${origin} (server host: ${host})`);
          return false;
        } catch {
          return false;
        }
      }
    });
    this.#wss.on("connection", (ws) => {
      this.#clients.add(ws);
      this.#sendFullSync(ws);
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "pong") return;
        } catch {
        }
      });
      ws.on("close", () => {
        this.#clients.delete(ws);
      });
      ws.on("error", (err) => {
        console.warn("[nodox] WebSocket client error:", err.message);
        this.#clients.delete(ws);
      });
    });
    this.#wss.on("error", (err) => {
      console.warn("[nodox] WebSocket server error:", err.message);
    });
    this.#startKeepalive();
    return this;
  }
  /**
   * Send full state to one specific client.
   * @param {WebSocket} ws
   */
  #sendFullSync(ws) {
    this.#send(ws, {
      type: "FULL_STATE_SYNC",
      ...this.#getState(),
      timestamp: Date.now()
    });
  }
  /**
   * Broadcast full state to ALL connected clients.
   * Called when routes change significantly (e.g. after deferred extraction).
   */
  broadcastFullSync() {
    const state = {
      type: "FULL_STATE_SYNC",
      ...this.#getState(),
      timestamp: Date.now()
    };
    for (const ws of this.#clients) {
      this.#send(ws, state);
    }
  }
  /**
   * Broadcast an incremental update to all clients.
   * @param {object} message
   */
  broadcast(message) {
    for (const ws of this.#clients) {
      this.#send(ws, message);
    }
  }
  /**
   * Safe JSON send — swallows errors on closed connections.
   * @param {WebSocket} ws
   * @param {object} data
   */
  #send(ws, data) {
    if (ws.readyState !== import_ws.WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch {
      this.#clients.delete(ws);
    }
  }
  #startKeepalive() {
    const interval = setInterval(() => {
      for (const ws of this.#clients) {
        if (ws.readyState === import_ws.WebSocket.OPEN) {
          this.#send(ws, { type: "ping" });
        } else {
          this.#clients.delete(ws);
        }
      }
    }, 3e4);
    interval.unref?.();
  }
  /**
   * Gracefully close the WebSocket server.
   */
  close() {
    for (const ws of this.#clients) {
      try {
        ws.close();
      } catch {
      }
    }
    this.#clients.clear();
    this.#wss?.close();
  }
  get clientCount() {
    return this.#clients.size;
  }
};

// src/ui-server/ui-server.js
var import_path = __toESM(require("path"), 1);
var import_fs = __toESM(require("fs"), 1);
var import_url = require("url");
var __dirname = import_path.default.dirname((0, import_url.fileURLToPath)(__importMetaUrl));
function findUiDir() {
  const candidates = [
    // Installed from npm, CJS bundle: __dirname = nodox-cli/dist/
    import_path.default.resolve(__dirname, "../ui/dist"),
    // Installed from npm, ESM source: __dirname = nodox-cli/src/ui-server/
    import_path.default.resolve(__dirname, "../../ui/dist"),
    // Running from source
    import_path.default.resolve(__dirname, "./ui"),
    import_path.default.resolve(__dirname, "../ui"),
    import_path.default.resolve(__dirname, "../../dist/ui")
  ];
  for (const candidate of candidates) {
    if (import_fs.default.existsSync(import_path.default.join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return null;
}
function createUiHandler({ uiPath = "/__nodox" } = {}) {
  const uiDir = findUiDir();
  const assetsPrefix = `${uiPath}/assets`;
  return function uiHandler(req, res, next) {
    if (!req.path.startsWith(uiPath)) {
      return next();
    }
    _applySecurityHeaders(res);
    if (!uiDir) {
      res.setHeader("Content-Type", "text/html");
      res.send(_notBuiltHtml(uiPath));
      return;
    }
    if (req.path.startsWith(assetsPrefix)) {
      const filename = req.path.slice(assetsPrefix.length).replace(/^\//, "");
      const assetsDir = import_path.default.join(uiDir, "assets");
      const filePath = import_path.default.resolve(assetsDir, filename);
      if (!filePath.startsWith(assetsDir + import_path.default.sep) && filePath !== assetsDir) {
        res.status(403).end();
        return;
      }
      if (!import_fs.default.existsSync(filePath)) {
        return next();
      }
      _sendAsset(res, filePath);
    } else {
      _serveIndexHtml(res, uiDir, uiPath);
    }
  };
}
function attachUiRoutes(app, { uiPath = "/__nodox" } = {}) {
  const uiDir = findUiDir();
  if (!uiDir) {
    app.get(new RegExp(`^${uiPath}(/|$)`), (req, res) => {
      _applySecurityHeaders(res);
      res.send(_notBuiltHtml(uiPath));
    });
    return;
  }
  app.use(`${uiPath}/assets`, (req, res, next) => {
    _applySecurityHeaders(res);
    createStaticHandler(import_path.default.join(uiDir, "assets"))(req, res, next);
  });
  app.get(new RegExp(`^${uiPath}(/|$)`), (req, res) => {
    _applySecurityHeaders(res);
    _serveIndexHtml(res, uiDir, uiPath);
  });
}
var _indexHtmlCache = /* @__PURE__ */ new Map();
function _serveIndexHtml(res, uiDir, uiPath) {
  let html = _indexHtmlCache.get(uiPath);
  if (!html) {
    html = import_fs.default.readFileSync(import_path.default.join(uiDir, "index.html"), "utf8");
    if (uiPath !== "/__nodox") {
      html = html.replaceAll("/__nodox/", `${uiPath}/`);
    }
    _indexHtmlCache.set(uiPath, html);
  }
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "no-cache");
  res.send(html);
}
function _applySecurityHeaders(res) {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; connect-src 'self' ws: wss: http: https:; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; frame-ancestors 'none'"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
}
function _escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function _notBuiltHtml(uiPath) {
  const safeUiPath = _escapeHtml(uiPath);
  return `<!DOCTYPE html><html><head><title>nodox \u2014 UI not built</title>
  <style>body{font-family:monospace;padding:40px;background:#0a0a0a;color:#888}h1{color:#fff}
  code{background:#1a1a1a;padding:4px 8px;border-radius:4px;color:#7dd3fc}</style></head>
  <body><h1>nodox</h1>
  <p>UI bundle not found. Run <code>npm run build:ui</code> to build the interface.</p>
  <p>Then open <code>${safeUiPath}</code></p></body></html>`;
}
var MIME_TYPES = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff"
};
function _sendAsset(res, filePath) {
  const ext = import_path.default.extname(filePath);
  const filename = import_path.default.basename(filePath);
  res.setHeader("Content-Type", MIME_TYPES[ext] || "application/octet-stream");
  if (filename.match(/\.[a-f0-9]{8,}\./)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "no-cache");
  }
  res.sendFile(filePath);
}
function createStaticHandler(dir) {
  return (req, res, next) => {
    const filename = req.path.replace(/^\/+/, "");
    const filePath = import_path.default.resolve(dir, filename);
    if (!filePath.startsWith(dir + import_path.default.sep) && filePath !== dir) {
      return res.status(403).end();
    }
    if (!import_fs.default.existsSync(filePath)) {
      return next();
    }
    _sendAsset(res, filePath);
  };
}

// src/schema/response-interceptor.js
function inferShape(value, depth = 0) {
  if (depth > 8) return { type: "object", description: "(depth limit)" };
  if (value === null) return { type: "null" };
  if (value === void 0) return { type: "null" };
  if (value instanceof Date) return { type: "string", format: "date-time" };
  const type = typeof value;
  if (type === "boolean") return { type: "boolean" };
  if (type === "number") {
    return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
  }
  if (type === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return { type: "string", format: "date-time" };
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { type: "string", format: "date" };
    if (/^[a-f0-9-]{36}$/i.test(value)) return { type: "string", format: "uuid" };
    if (/^https?:\/\//.test(value)) return { type: "string", format: "uri" };
    return { type: "string" };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array", items: {} };
    const itemShape = inferShape(value[0], depth + 1);
    if (value.length > 1) {
      const secondShape = inferShape(value[1], depth + 1);
      return { type: "array", items: mergeShapes(itemShape, secondShape) };
    }
    return { type: "array", items: itemShape };
  }
  if (type === "object") {
    const properties = {};
    const keys = Object.keys(value);
    const limitedKeys = keys.slice(0, 50);
    for (const key of limitedKeys) {
      properties[key] = inferShape(value[key], depth + 1);
    }
    const result = { type: "object", properties };
    if (keys.length > 50) {
      result.description = `(showing 50 of ${keys.length} fields)`;
    }
    return result;
  }
  return { type: "any" };
}
function mergeShapes(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.type !== b.type && a.type && b.type) {
    if (a.type === "integer" && b.type === "number" || a.type === "number" && b.type === "integer") {
      return { type: "number" };
    }
    return { anyOf: [a, b] };
  }
  if (a.type === "object" && b.type === "object") {
    const allKeys = /* @__PURE__ */ new Set([
      ...Object.keys(a.properties || {}),
      ...Object.keys(b.properties || {})
    ]);
    const properties = {};
    for (const key of allKeys) {
      if (a.properties?.[key] && b.properties?.[key]) {
        properties[key] = mergeShapes(a.properties[key], b.properties[key]);
      } else {
        properties[key] = a.properties?.[key] || b.properties?.[key];
      }
    }
    return { type: "object", properties };
  }
  if (a.type === "array" && b.type === "array") {
    return {
      type: "array",
      items: mergeShapes(a.items, b.items)
    };
  }
  if (a.type === b.type) {
    if (a.format !== b.format) {
      const merged = { ...a };
      delete merged.format;
      return merged;
    }
    return a;
  }
  return a;
}
function isWildcardRoute(path3) {
  if (!path3) return true;
  return path3 === "*" || path3 === "/*" || path3.startsWith("/__nodox") || path3 === "/favicon.ico" || /\*/.test(path3);
}
var BODY_METHODS = /* @__PURE__ */ new Set(["POST", "PUT", "PATCH"]);
var QUERY_METHODS = /* @__PURE__ */ new Set(["GET", "DELETE", "HEAD", "OPTIONS"]);
function createResponseInterceptor({ onResponseShape, parsedValueToSchema: parsedValueToSchema2, onRequestBodyShape, onRequestQueryShape }) {
  return function responseInterceptorMiddleware(req, res, next) {
    const originalJson = res.json.bind(res);
    res.json = function interceptedJson(body) {
      const routePath = req.route ? ((req.baseUrl || "") + req.route.path).replace(/\/+/g, "/") : null;
      if (routePath && !isWildcardRoute(routePath)) {
        const method = req.method?.toUpperCase() ?? "";
        if (typeof onRequestBodyShape === "function" && BODY_METHODS.has(method) && req.body !== null && req.body !== void 0 && typeof req.body === "object" && Object.keys(req.body).length > 0) {
          try {
            onRequestBodyShape(method, routePath, inferShape(req.body));
          } catch {
          }
        }
        if (typeof onRequestQueryShape === "function" && QUERY_METHODS.has(method) && req.query !== null && req.query !== void 0 && typeof req.query === "object" && Object.keys(req.query).length > 0) {
          try {
            onRequestQueryShape(method, routePath, inferShape(req.query));
          } catch {
          }
        }
        if (body !== void 0) {
          try {
            let shape, confidence;
            if (parsedValueToSchema2 && body !== null && typeof body === "object") {
              const knownSchema = parsedValueToSchema2.get(body);
              if (knownSchema) {
                shape = knownSchema;
                confidence = "inferred";
              }
            }
            if (!shape) {
              shape = inferShape(body);
              confidence = "observed";
            }
            onResponseShape(method, routePath, shape, confidence);
          } catch {
          }
        }
      }
      return originalJson(body);
    };
    next();
  };
}

// src/schema/source-screener.js
var ZOD_PATTERNS = [
  /\.safeParse\(/,
  /\.parseAsync\(/,
  /\.safeParseAsync\(/,
  /\bz\.(object|string|number|boolean|array|union|enum)\b/,
  /_zod\.z\./,
  // transpiled: import * as _zod from 'zod'
  /zod_1\.z\./,
  // commonjs transpiled by tsc
  /[a-zA-Z]{2,}\.parse\(/,
  // Catch anyVariable.parse() — excludes single-char (valibot's v.parse)
  /[a-zA-Z]{2,}\.safeParse\(/,
  // Catch anyVariable.safeParse() — excludes single-char
  // Catch any variableName.parse(req.*) — the most common validation pattern.
  /\.parse\(req[.,\s)]/,
  /\w+[Ss]chema\.parse\(/,
  /\w+[Vv]alidator\.parse\(/
];
var JOI_PATTERNS = [
  /\.validate\(req\b/,
  /\.validate\(\w+\.body\b/,
  // Catch schema.validate(req.body)
  /joi\.(object|string|number|boolean|array)\(/,
  /_joi\.(default|joi)\b/i,
  /Joi\.(object|string|number|boolean|array)\(/
];
var YUP_PATTERNS = [
  /yup\.(object|string|number|boolean|array|mixed)\(/,
  /\.validateSync\(req\b/,
  /\.validateSync\(req\.body\b/,
  /yup_1\.(object|string|number|boolean)/,
  // tsc-transpiled yup
  /schema\.validateSync\b/
];
var VALIBOT_PATTERNS = [];
var KNOWN_NON_VALIDATORS = /* @__PURE__ */ new Set([
  // Express built-ins and internal names
  "router",
  "bound dispatch",
  "bound ",
  "jsonParser",
  "urlencodedParser",
  "rawParser",
  "textParser",
  "json",
  "urlencoded",
  "raw",
  "text",
  "query",
  "init",
  "expressInit",
  // nodox's own middleware
  "nodoxMiddleware",
  "nodoxValidateMiddleware",
  "responseInterceptorMiddleware",
  "uiHandler",
  // Security & utility middleware
  "corsMiddleware",
  "cors",
  "corsPreflight",
  "helmet",
  "morgan",
  "logger",
  "accessLogger",
  "requestLogger",
  "compression",
  "responseTime",
  "timeout",
  "connectTimeout",
  "methodOverride",
  // Rate limiting
  "rateLimit",
  "slowDown",
  "expressRateLimit",
  // Auth & sessions
  "session",
  "expressSession",
  "cookieParser",
  "cookieSession",
  "passport",
  "initialize",
  "passportInitialize",
  "passportSession",
  "authenticate",
  "jwtMiddleware",
  "bearerStrategy",
  // File upload
  "multer",
  "upload",
  "single",
  "array",
  "fields",
  "none",
  "any",
  "busboy",
  "multipart",
  // Caching
  "cache",
  "apicache",
  "expressCache",
  // Body parsing
  "bodyParser",
  // Static file serving
  "serveStatic",
  "staticMiddleware",
  "sendFile",
  // Error handling
  "errorHandler",
  "notFound",
  "notFoundHandler",
  "finalhandler",
  // Validation frameworks (not the user's validators — these are factory wrappers)
  "checkSchema",
  "check",
  "param",
  "query",
  "header",
  "cookie",
  "validationResult",
  // Logging
  "pinoHttp",
  "winstonMiddleware",
  // Misc popular middleware
  "device",
  "userAgent",
  "responseCompression",
  "requestId",
  "correlationId",
  "i18n",
  "locale"
]);
var NODE_MODULES_SOURCE_PATTERNS = [
  /Object\.defineProperty\(exports,\s*["']__esModule["']/,
  // TypeScript/Babel CJS
  /exports\.__esModule\s*=\s*true/,
  // TS simple CJS interop
  /__webpack_require__\(/,
  // Webpack bundle
  /\/\*\*\s*@license\b/,
  // License JSDoc comment
  /\/\*\s*!\s*Copyright\s/i,
  // Minified copyright comment
  /function\s*\(\s*module\s*,\s*exports\s*,\s*__webpack/
  // Webpack factory
];
function isLikelyNodeModuleCode(src) {
  return NODE_MODULES_SOURCE_PATTERNS.some((p) => p.test(src));
}
function looksLikeValidator(fn) {
  if (typeof fn !== "function") return false;
  const name = fn.name || "";
  if (KNOWN_NON_VALIDATORS.has(name)) return false;
  if (fn.__isNodoxValidate) return false;
  let src;
  try {
    src = fn.toString();
  } catch {
    return false;
  }
  if (src.length < 20) return false;
  if (src.length > 500 && !src.includes("\n") && !src.includes("  ")) {
    return false;
  }
  if (isLikelyNodeModuleCode(src)) return false;
  const compressed = src.replace(/\s+/g, "");
  return ZOD_PATTERNS.some((p) => p.test(compressed)) || JOI_PATTERNS.some((p) => p.test(compressed)) || YUP_PATTERNS.some((p) => p.test(compressed)) || VALIBOT_PATTERNS.some((p) => p.test(compressed));
}

// src/schema/dry-runner.js
var import_async_hooks = require("async_hooks");
var import_http = __toESM(require("http"), 1);
var import_https = __toESM(require("https"), 1);
var import_net = __toESM(require("net"), 1);
var import_fs2 = __toESM(require("fs"), 1);
var import_child_process = __toESM(require("child_process"), 1);

// src/schema/schema-patcher.js
var import_module2 = require("module");
var require2 = (0, import_module2.createRequire)(__importMetaUrl);
var capturedSchemas = /* @__PURE__ */ new WeakMap();

// src/schema/dry-runner.js
var dryRunContext = new import_async_hooks.AsyncLocalStorage();
var ABORT_ERROR_MESSAGE = "__NODOC_DRY_RUN_ABORT__";
function isDryRun() {
  const store = dryRunContext.getStore();
  return store === true;
}
var _sideEffectPatchesApplied = false;
function applySideEffectPatches() {
  if (_sideEffectPatchesApplied) return;
  _sideEffectPatchesApplied = true;
  const patchNetwork = (mod) => {
    const orig = mod.request;
    mod.request = function(...args) {
      if (isDryRun()) {
        const err = new Error("Network call blocked during nodox dry-run");
        err.code = "ENETBLOCK";
        throw err;
      }
      return orig.apply(this, args);
    };
  };
  patchNetwork(import_http.default);
  patchNetwork(import_https.default);
  const origConnect = import_net.default.Socket.prototype.connect;
  import_net.default.Socket.prototype.connect = function(...args) {
    if (isDryRun()) {
      throw new Error("Network connection blocked during nodox dry-run");
    }
    return origConnect.apply(this, args);
  };
  const blockFs = (method) => {
    const orig = import_fs2.default[method];
    if (typeof orig !== "function") return;
    const patched = function(...args) {
      if (isDryRun()) {
        throw new Error(`fs.${method} blocked during nodox dry-run`);
      }
      return orig.apply(this, args);
    };
    import_fs2.default[method] = patched;
    if (import_fs2.default.default && import_fs2.default.default[method]) {
      import_fs2.default.default[method] = patched;
    }
  };
  ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "mkdir", "mkdirSync"].forEach(blockFs);
  const blockCp = (method) => {
    const orig = import_child_process.default[method];
    if (typeof orig !== "function") return;
    import_child_process.default[method] = function(...args) {
      if (isDryRun()) {
        throw new Error(`child_process.${method} blocked during nodox dry-run`);
      }
      return orig.apply(this, args);
    };
  };
  ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].forEach(blockCp);
}
function createInfiniteProxy(overrides = {}) {
  function handler(target2) {
    return {
      get(obj, prop) {
        if (prop in overrides) return overrides[prop];
        if (typeof prop === "symbol") return void 0;
        if (prop === "then" || prop === "catch" || prop === "finally") return void 0;
        if (prop === "toJSON") return void 0;
        if (prop === "valueOf") return () => null;
        if (prop === "toString") return () => "[nodox mock]";
        if (prop === "constructor") return Object;
        if (prop in obj) return obj[prop];
        return createInfiniteProxy();
      },
      apply() {
        return createInfiniteProxy();
      },
      set() {
        return true;
      }
    };
  }
  const target = typeof overrides === "function" ? overrides : function() {
  };
  return new Proxy(target, handler(target));
}
async function dryRunValidator(fn, method = "POST") {
  applySideEffectPatches();
  const mockReq = createInfiniteProxy({
    body: {},
    params: {},
    query: {},
    headers: {
      "content-type": "application/json",
      "accept": "application/json"
    },
    method: method.toUpperCase(),
    path: "/",
    url: "/",
    get(header) {
      return { "content-type": "application/json" }[header.toLowerCase()] || null;
    }
  });
  const _capturedJsonBodies = [];
  const _captureBody = (body) => {
    try {
      _capturedJsonBodies.push(body);
    } catch {
    }
  };
  const _statusResult = createInfiniteProxy({ json: _captureBody, send: _captureBody });
  const mockRes = createInfiniteProxy({
    json: _captureBody,
    send: _captureBody,
    status: () => _statusResult
  });
  const mockNext = () => {
  };
  let detectedSchema = null;
  let detectedLibrary = null;
  let caughtZodError = null;
  const patchedSchemas = /* @__PURE__ */ new Map();
  const schemasToWatch = getWatchableSchemas();
  for (const { schema, meta } of schemasToWatch) {
    const patches = patchSchemaForDryRun(schema, meta, (s, lib) => {
      if (!detectedSchema) {
        detectedSchema = s;
        detectedLibrary = lib;
      }
    });
    if (patches) patchedSchemas.set(schema, patches);
  }
  try {
    await dryRunContext.run(true, async () => {
      const maybePromise = fn(mockReq, mockRes, mockNext);
      if (maybePromise && typeof maybePromise.then === "function") {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 0);
          maybePromise.then(
            () => {
              clearTimeout(t);
              resolve();
            },
            (err) => {
              clearTimeout(t);
              if (!caughtZodError && Array.isArray(err?.issues) && err.issues.length > 0) {
                caughtZodError = err;
              }
              resolve();
            }
          );
        });
      }
    });
  } catch (err) {
    if (err.message === ABORT_ERROR_MESSAGE) {
    } else if (!detectedSchema && Array.isArray(err?.issues) && err.issues.length > 0) {
      caughtZodError = err;
    }
  }
  for (const [schema, patches] of patchedSchemas) {
    for (const [method2, original] of Object.entries(patches)) {
      try {
        schema[method2] = original;
      } catch {
      }
    }
  }
  if (!detectedSchema && !caughtZodError) {
    for (const body of _capturedJsonBodies) {
      const issues = _extractZodIssues(body);
      if (issues) {
        caughtZodError = { issues };
        break;
      }
    }
  }
  return {
    schema: detectedSchema,
    library: detectedLibrary,
    zodError: caughtZodError,
    jsonSchema: null
    // Converted by schema-detector after dry run
  };
}
function _extractZodIssues(body) {
  if (!body || typeof body !== "object") return null;
  const candidates = [
    body.issues,
    body.details,
    body.errors,
    body.validationErrors,
    body.error?.issues
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0 && Array.isArray(c[0]?.path) && typeof c[0]?.code === "string") {
      return c;
    }
  }
  return null;
}
function patchSchemaForDryRun(schema, meta, onDetected) {
  const originals = {};
  const methodsToWatch = meta.type === "zod" ? ["parse", "safeParse", "parseAsync", "safeParseAsync"] : meta.type === "yup" ? ["validateSync"] : ["validate", "validateAsync"];
  let patched = false;
  for (const method of methodsToWatch) {
    if (typeof schema[method] !== "function") continue;
    originals[method] = schema[method];
    schema[method] = function interceptedParse(...args) {
      onDetected(schema, meta.type);
      schema[method] = originals[method];
      if (isDryRun()) {
        throw new Error(ABORT_ERROR_MESSAGE);
      }
      return originals[method].apply(this, args);
    };
    patched = true;
  }
  return patched ? originals : null;
}
function getWatchableSchemas() {
  return _schemaRegistryArray;
}
var _schemaRegistryArray = [];
var registryCleanup = new FinalizationRegistry((schema) => {
  const index = _schemaRegistryArray.findIndex((entry) => entry.schema === schema);
  if (index !== -1) _schemaRegistryArray.splice(index, 1);
});
function registerForDryRun(schema, meta) {
  _schemaRegistryArray.push({ schema, meta });
  try {
    registryCleanup.register(schema, schema);
  } catch {
  }
}

// src/schema/validate.js
var import_zod_to_json_schema = require("zod-to-json-schema");
var schemaRegistry = /* @__PURE__ */ new Map();
function validate(schema, options = {}) {
  const { strict = false, response: responseSchema } = options;
  const library = detectSchemaLibrary(schema);
  if (!library) {
    throw new Error(
      "[nodox] validate() received an unrecognized schema type. Pass a Zod schema, Joi schema, or a plain JSON Schema object."
    );
  }
  const jsonSchema = toJsonSchema(schema, library);
  let outputJsonSchema = null;
  if (responseSchema) {
    const responseLibrary = detectSchemaLibrary(responseSchema);
    if (responseLibrary) {
      outputJsonSchema = toJsonSchema(responseSchema, responseLibrary);
    } else {
      throw new Error(
        "[nodox] validate() options.response received an unrecognized schema type. Pass a Zod schema, Joi schema, or a plain JSON Schema object."
      );
    }
  }
  const source = captureValidateCallsite();
  const registeredSchema = {
    library,
    rawSchema: schema,
    jsonSchema,
    outputJsonSchema,
    source,
    confidence: "confirmed"
  };
  function nodoxValidateMiddleware(req, res, next) {
    let result;
    try {
      if (library === "zod") {
        result = strict ? schema.strict().safeParse(req.body) : schema.safeParse(req.body);
        if (!result.success) {
          const issues = result.error.issues ?? result.error.errors ?? [];
          return res.status(400).json({
            error: "Validation failed",
            details: issues.map((e) => ({
              path: Array.isArray(e.path) ? e.path.join(".") : String(e.path ?? ""),
              message: e.message,
              code: e.code
            }))
          });
        }
        req.body = result.data;
      } else if (library === "joi") {
        const { error, value } = schema.validate(req.body, {
          abortEarly: false,
          allowUnknown: !strict
        });
        if (error) {
          return res.status(400).json({
            error: "Validation failed",
            details: error.details.map((d) => ({
              path: d.path.join("."),
              message: d.message,
              type: d.type
            }))
          });
        }
        req.body = value;
      } else if (library === "yup") {
        req.body = schema.validateSync(req.body, {
          abortEarly: false,
          stripUnknown: !strict
        });
      } else if (library === "jsonschema") {
        req.body = req.body;
      }
    } catch (err) {
      if (err?.name === "ValidationError" && err?.inner) {
        return res.status(400).json({
          error: "Validation failed",
          details: (err.inner.length ? err.inner : [err]).map((e) => ({
            path: e.path || "",
            message: e.message,
            type: e.type
          }))
        });
      }
      console.error("[nodox] validate() middleware threw unexpectedly:", err);
      return res.status(500).json({ error: "Internal validation error" });
    }
    next();
  }
  nodoxValidateMiddleware.__nodoxSchema = registeredSchema;
  nodoxValidateMiddleware.__isNodoxValidate = true;
  return nodoxValidateMiddleware;
}
function detectSchemaLibrary(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (schema._def?.typeName) return "zod";
  if (typeof schema.safeParse === "function" && typeof schema.toJSONSchema === "function") return "zod";
  if (schema.def?.type && typeof schema.safeParse === "function") return "zod";
  if (schema.isJoi || schema.$_root) return "joi";
  if (schema.type && typeof schema.type === "string" && schema.$_terms) return "joi";
  if (schema._type && typeof schema.validateSync === "function") return "yup";
  if (schema.__isYupSchema__ && typeof schema.validate === "function") return "yup";
  if ((schema.type || schema.properties || schema.$schema || schema.anyOf) && typeof schema.safeParse !== "function") return "jsonschema";
  return null;
}
function toJsonSchema(schema, library) {
  try {
    if (library === "zod") {
      if (typeof schema.toJSONSchema === "function") {
        const result = schema.toJSONSchema();
        const { $schema, ...rest } = result;
        return rest;
      }
      return (0, import_zod_to_json_schema.zodToJsonSchema)(schema, {
        name: void 0,
        $refStrategy: "none"
      });
    }
    if (library === "joi") {
      return joiToJsonSchema(schema);
    }
    if (library === "yup") {
      return yupToJsonSchema(schema);
    }
    if (library === "jsonschema") {
      return schema;
    }
  } catch (err) {
    console.warn("[nodox] Failed to convert schema to JSON Schema:", err.message);
  }
  return { type: "object" };
}
function yupToJsonSchema(yupSchema) {
  try {
    const desc = yupSchema.describe();
    return yupDescToJsonSchema(desc);
  } catch {
    return { type: "object", description: "yup schema (conversion failed)" };
  }
}
function yupDescToJsonSchema(desc) {
  if (!desc) return {};
  const out = {};
  switch (desc.type) {
    case "object": {
      out.type = "object";
      if (desc.fields) {
        out.properties = {};
        const required = [];
        for (const [key, val] of Object.entries(desc.fields)) {
          out.properties[key] = yupDescToJsonSchema(val);
          const isOptional = val.optional === true || val.nullable === true;
          if (!isOptional) required.push(key);
        }
        if (required.length) out.required = required;
      }
      break;
    }
    case "string":
      out.type = "string";
      break;
    case "number":
      out.type = "number";
      break;
    case "boolean":
      out.type = "boolean";
      break;
    case "array":
      out.type = "array";
      if (desc.innerType) out.items = yupDescToJsonSchema(desc.innerType);
      break;
    case "date":
      out.type = "string";
      out.format = "date-time";
      break;
    default:
      out.type = desc.type || "any";
  }
  if (desc.label) out.description = desc.label;
  return out;
}
function joiToJsonSchema(joiSchema) {
  try {
    const desc = joiSchema.describe();
    return joiDescToJsonSchema(desc);
  } catch {
    return { type: "object", description: "Joi schema (conversion failed)" };
  }
}
function joiDescToJsonSchema(desc) {
  if (!desc) return {};
  const out = {};
  switch (desc.type) {
    case "object": {
      out.type = "object";
      if (desc.keys) {
        out.properties = {};
        const required = [];
        for (const [key, val] of Object.entries(desc.keys)) {
          out.properties[key] = joiDescToJsonSchema(val);
          if (!val.flags?.presence || val.flags.presence === "required") {
            required.push(key);
          }
        }
        if (required.length) out.required = required;
      }
      break;
    }
    case "string":
      out.type = "string";
      if (desc.flags?.only && desc.allow?.length) {
        out.enum = desc.allow;
      }
      break;
    case "number":
    case "integer":
      out.type = desc.type;
      break;
    case "boolean":
      out.type = "boolean";
      break;
    case "array":
      out.type = "array";
      if (desc.items?.length) {
        out.items = joiDescToJsonSchema(desc.items[0]);
      }
      break;
    case "date":
      out.type = "string";
      out.format = "date-time";
      break;
    default:
      out.type = desc.type || "any";
  }
  if (desc.flags?.description) {
    out.description = desc.flags.description;
  }
  return out;
}
function registerSchemaForRoute(method, path3, schema) {
  const key = `${method.toUpperCase()}:${path3}`;
  schemaRegistry.set(key, schema);
}
function captureValidateCallsite() {
  try {
    const err = new Error();
    const lines = err.stack?.split("\n") || [];
    for (const line of lines.slice(2)) {
      const match = line.match(/\((.+?):(\d+):\d+\)/) || line.match(/at (.+?):(\d+):\d+/);
      if (!match) continue;
      const file = match[1];
      if (file.includes("nodox-cli/src") || file.includes("node_modules/nodox-cli")) continue;
      if (file.includes("node:internal")) continue;
      const cwd = process.cwd();
      const relative = file.startsWith(cwd) ? file.slice(cwd.length).replace(/^[\\/]/, "") : file.split(/[\\/]node_modules[\\/]/).pop() ?? file;
      return `${relative}:${match[2]}`;
    }
    return null;
  } catch {
    return null;
  }
}

// src/schema/schema-detector.js
var import_module3 = require("module");

// src/layer4/cache-reader.js
var import_fs3 = __toESM(require("fs"), 1);
var import_path2 = __toESM(require("path"), 1);
function findCacheFile(startDir = process.cwd()) {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = import_path2.default.join(dir, ".apicache.json");
    if (import_fs3.default.existsSync(candidate)) return candidate;
    const parent = import_path2.default.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function loadCacheEntries(cacheFile) {
  const filePath = cacheFile || findCacheFile();
  if (!filePath) return {};
  try {
    const raw = import_fs3.default.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.routes || {};
  } catch {
    return {};
  }
}

// src/schema/schema-detector.js
var require3 = (0, import_module3.createRequire)(__importMetaUrl);
var routeSchemas = /* @__PURE__ */ new Map();
var parsedValueToSchema = /* @__PURE__ */ new WeakMap();
var schemaJsonSchemaCache = /* @__PURE__ */ new WeakMap();
var CONFIDENCE_ORDER = { confirmed: 3, inferred: 2, observed: 1, none: 0 };
var _rawCacheEntries = null;
function urlMatchesTemplate(urlPath, templatePath) {
  if (!urlPath || !templatePath) return false;
  if (templatePath === "*" || templatePath === "/*") return false;
  const url = urlPath.split("?")[0];
  const urlSegs = url.split("/").filter(Boolean);
  const tplSegs = templatePath.split("/").filter(Boolean);
  if (urlSegs.length !== tplSegs.length) return false;
  for (let i = 0; i < tplSegs.length; i++) {
    const seg = tplSegs[i];
    if (seg.startsWith(":")) continue;
    if (seg.startsWith("(") && seg.endsWith(")")) continue;
    if (seg !== urlSegs[i]) return false;
  }
  return true;
}
function _findMatchingCacheEntry(method, templatePath) {
  if (!_rawCacheEntries) return null;
  const upper = method.toUpperCase();
  for (const [key, entry] of Object.entries(_rawCacheEntries)) {
    const colon = key.indexOf(":");
    if (colon === -1) continue;
    if (key.slice(0, colon).toUpperCase() !== upper) continue;
    if (urlMatchesTemplate(key.slice(colon + 1), templatePath)) return entry;
  }
  return null;
}
function _isExpressValidatorChain(fn) {
  if (!fn || typeof fn !== "function") return false;
  if (fn.builder?.fields && Array.isArray(fn.builder.fields)) return true;
  if (fn._context?.fields && Array.isArray(fn._context.fields)) return true;
  return false;
}
function _inferEVFieldType(validators) {
  for (const v of validators) {
    const name = typeof v?.validator === "function" ? v.validator.name : typeof v === "function" ? v.name : "";
    switch (name) {
      case "isEmail":
        return { type: "string", format: "email" };
      case "isURL":
        return { type: "string", format: "uri" };
      case "isISO8601":
      case "isDate":
        return { type: "string", format: "date-time" };
      case "isUUID":
        return { type: "string", format: "uuid" };
      case "isInt":
      case "isNumeric":
        return { type: "integer" };
      case "isFloat":
      case "isDecimal":
        return { type: "number" };
      case "isBoolean":
        return { type: "boolean" };
      case "isArray":
        return { type: "array" };
      case "isObject":
      case "isJSON":
        return { type: "object" };
    }
  }
  return { type: "string" };
}
function _extractExpressValidatorSchema(handlers) {
  const properties = {};
  for (const fn of handlers) {
    if (!_isExpressValidatorChain(fn)) continue;
    const ctx = fn.builder ?? fn._context;
    const fields = ctx?.fields ?? [];
    const validators = ctx?.stack ?? // v7
    ctx?.validators ?? // v6 alternate
    [];
    for (const field of fields) {
      if (typeof field !== "string" || !field) continue;
      properties[field] = _inferEVFieldType(validators);
    }
  }
  return Object.keys(properties).length > 0 ? { type: "object", properties } : null;
}
function routeKey(method, path3) {
  return `${method.toUpperCase()}:${path3}`;
}
function getOrCreateSchema(method, path3) {
  const key = routeKey(method, path3);
  if (!routeSchemas.has(key)) {
    routeSchemas.set(key, {
      input: null,
      output: null,
      querySchema: null,
      inputConfidence: "none",
      outputConfidence: "none",
      querySchemaConfidence: "none",
      source: null
    });
  }
  return routeSchemas.get(key);
}
function loadCacheIntoRegistry(cacheFile) {
  const entries = loadCacheEntries(cacheFile);
  const keys = Object.keys(entries);
  if (keys.length === 0) return 0;
  _rawCacheEntries = entries;
  for (const [key, entry] of Object.entries(entries)) {
    const colonIdx = key.indexOf(":");
    if (colonIdx === -1) continue;
    const method = key.slice(0, colonIdx);
    const path3 = key.slice(colonIdx + 1);
    const existing = routeSchemas.get(key);
    const canSetInput = !existing || existing.inputConfidence === "none" && entry.input;
    const canSetOutput = !existing || !existing.output && entry.output;
    if (!canSetInput && !canSetOutput) continue;
    const schema = getOrCreateSchema(method, path3);
    if (canSetInput && entry.input) {
      schema.input = entry.input;
      schema.inputConfidence = "observed";
    }
    if (canSetOutput && entry.output) {
      schema.output = entry.output;
      schema.outputConfidence = "observed";
    }
    if (entry.seenCount) schema.seenCount = entry.seenCount;
    if (entry.lastSeen) schema.lastSeen = entry.lastSeen;
  }
  return keys.length;
}
var _detectorInitialized = false;
function initSchemaDetector() {
  if (_detectorInitialized) return;
  _detectorInitialized = true;
  try {
    const zod = require3("zod");
    const z = zod?.z || zod?.default?.z || (zod?.object ? zod : zod?.default);
    if (z) {
      patchZodWithRegistry(z);
    }
  } catch {
  }
  try {
    const joi = require3("joi");
    const j = joi?.object ? joi : joi?.default;
    if (j) {
      patchJoiWithRegistry(j);
    }
  } catch {
  }
  try {
    const yup = require3("yup");
    const y = yup?.object ? yup : yup?.default;
    if (y) {
      patchYupWithRegistry(y);
    }
  } catch {
  }
}
initSchemaDetector();
function tagParsedValue(value, schema, library) {
  if (value === null || value === void 0 || typeof value !== "object") return;
  try {
    let jsonSchema = schemaJsonSchemaCache.get(schema);
    if (!jsonSchema) {
      jsonSchema = toJsonSchema(schema, library);
      if (jsonSchema) schemaJsonSchemaCache.set(schema, jsonSchema);
    }
    if (jsonSchema) parsedValueToSchema.set(value, jsonSchema);
  } catch {
  }
}
function patchZodInstanceForOutputTracking(schema) {
  const handlers = {
    parse(orig) {
      return function nodoxTrackedParse(...args) {
        const result = orig.apply(this, args);
        tagParsedValue(result, this, "zod");
        return result;
      };
    },
    safeParse(orig) {
      return function nodoxTrackedSafeParse(...args) {
        const result = orig.apply(this, args);
        if (result?.success) tagParsedValue(result.data, this, "zod");
        return result;
      };
    },
    parseAsync(orig) {
      return async function nodoxTrackedParseAsync(...args) {
        const result = await orig.apply(this, args);
        tagParsedValue(result, this, "zod");
        return result;
      };
    },
    safeParseAsync(orig) {
      return async function nodoxTrackedSafeParseAsync(...args) {
        const result = await orig.apply(this, args);
        if (result?.success) tagParsedValue(result.data, this, "zod");
        return result;
      };
    }
  };
  for (const [method, wrap] of Object.entries(handlers)) {
    if (typeof schema[method] !== "function") continue;
    if (schema[method].__nodoxTracked) continue;
    const orig = schema[method];
    const patched = wrap(orig);
    patched.__nodoxTracked = true;
    try {
      schema[method] = patched;
    } catch {
      try {
        Object.defineProperty(schema, method, { value: patched, writable: true, configurable: false });
      } catch {
      }
    }
  }
}
function patchZodProtoForOutputTracking(z) {
  let baseProto;
  try {
    let proto = Object.getPrototypeOf(z.string());
    while (proto && proto !== Object.prototype) {
      const parent = Object.getPrototypeOf(proto);
      if (!parent || parent === Object.prototype || typeof parent.parse !== "function") {
        baseProto = proto;
        break;
      }
      proto = parent;
    }
  } catch {
    return;
  }
  if (!baseProto || typeof baseProto.parse !== "function" || baseProto.__nodoxZodProtoPatched) return;
  baseProto.__nodoxZodProtoPatched = true;
  const handlers = {
    parse: (orig) => function nodoxTrackedParse(...args) {
      const result = orig.apply(this, args);
      tagParsedValue(result, this, "zod");
      return result;
    },
    safeParse: (orig) => function nodoxTrackedSafeParse(...args) {
      const result = orig.apply(this, args);
      if (result?.success) tagParsedValue(result.data, this, "zod");
      return result;
    },
    parseAsync: (orig) => async function nodoxTrackedParseAsync(...args) {
      const result = await orig.apply(this, args);
      tagParsedValue(result, this, "zod");
      return result;
    },
    safeParseAsync: (orig) => async function nodoxTrackedSafeParseAsync(...args) {
      const result = await orig.apply(this, args);
      if (result?.success) tagParsedValue(result.data, this, "zod");
      return result;
    }
  };
  for (const [method, wrap] of Object.entries(handlers)) {
    if (typeof baseProto[method] !== "function") continue;
    baseProto[method] = wrap(baseProto[method]);
  }
}
function patchJoiProtoForOutputTracking(joi) {
  let baseProto;
  try {
    let proto = Object.getPrototypeOf(joi.any());
    while (proto && proto !== Object.prototype) {
      const parent = Object.getPrototypeOf(proto);
      if (!parent || parent === Object.prototype || typeof parent.validate !== "function") {
        baseProto = proto;
        break;
      }
      proto = parent;
    }
  } catch {
    return;
  }
  if (!baseProto || baseProto.__nodoxJoiProtoPatched) return;
  baseProto.__nodoxJoiProtoPatched = true;
  if (typeof baseProto.validate === "function") {
    const orig = baseProto.validate;
    baseProto.validate = function nodoxTrackedJoiValidate(...args) {
      const result = orig.apply(this, args);
      if (!result?.error) tagParsedValue(result?.value, this, "joi");
      return result;
    };
  }
}
function patchYupProtoForOutputTracking(yup) {
  let baseProto;
  try {
    let proto = Object.getPrototypeOf(yup.mixed ? yup.mixed() : yup.string());
    while (proto && proto !== Object.prototype) {
      const parent = Object.getPrototypeOf(proto);
      if (!parent || parent === Object.prototype || typeof parent.validateSync !== "function" && typeof parent.validate !== "function") {
        baseProto = proto;
        break;
      }
      proto = parent;
    }
  } catch {
    return;
  }
  if (!baseProto || baseProto.__nodoxYupProtoPatched) return;
  baseProto.__nodoxYupProtoPatched = true;
  if (typeof baseProto.validateSync === "function") {
    const orig = baseProto.validateSync;
    baseProto.validateSync = function nodoxTrackedYupValidateSync(...args) {
      const result = orig.apply(this, args);
      tagParsedValue(result, this, "yup");
      return result;
    };
  }
  if (typeof baseProto.validate === "function") {
    const orig = baseProto.validate;
    baseProto.validate = async function nodoxTrackedYupValidate(...args) {
      const result = await orig.apply(this, args);
      tagParsedValue(result, this, "yup");
      return result;
    };
  }
}
var _patchedZInstances = /* @__PURE__ */ new WeakSet();
function patchZodWithRegistry(z) {
  if (!z || _patchedZInstances.has(z)) return;
  _patchedZInstances.add(z);
  const methodsToWrap = [
    "object",
    "string",
    "number",
    "boolean",
    "array",
    "union",
    "intersection",
    "tuple",
    "record",
    "literal",
    "enum",
    "nativeEnum",
    "any",
    "unknown",
    "date",
    "bigint",
    "discriminatedUnion"
  ];
  for (const method of methodsToWrap) {
    if (typeof z[method] !== "function") continue;
    const original = z[method].bind(z);
    const wrapped = function nodoxPatchedZodFactory(...args) {
      const schema = original(...args);
      if (schema && typeof schema === "object") {
        const meta = { type: "zod", zodType: method };
        capturedSchemas.set(schema, meta);
        registerForDryRun(schema, meta);
        patchZodInstanceForOutputTracking(schema);
      }
      return schema;
    };
    try {
      z[method] = wrapped;
    } catch {
      try {
        Object.defineProperty(z, method, { value: wrapped, writable: true });
      } catch {
      }
    }
  }
  patchZodProtoForOutputTracking(z);
}
function patchJoiWithRegistry(joi) {
  const methodsToWrap = [
    "object",
    "string",
    "number",
    "boolean",
    "array",
    "any",
    "date",
    "alternatives",
    "binary"
  ];
  for (const method of methodsToWrap) {
    if (typeof joi[method] !== "function") continue;
    const original = joi[method].bind(joi);
    joi[method] = function(...args) {
      const schema = original(...args);
      if (schema && typeof schema === "object") {
        const meta = { type: "joi", joiType: method };
        capturedSchemas.set(schema, meta);
        registerForDryRun(schema, meta);
      }
      return schema;
    };
  }
  patchJoiProtoForOutputTracking(joi);
}
function patchYupWithRegistry(yup) {
  const methodsToWrap = ["object", "string", "number", "boolean", "array", "mixed", "date"];
  for (const method of methodsToWrap) {
    if (typeof yup[method] !== "function") continue;
    const original = yup[method].bind(yup);
    yup[method] = function(...args) {
      const schema = original(...args);
      if (schema && typeof schema === "object") {
        const meta = { type: "yup", yupType: method };
        capturedSchemas.set(schema, meta);
        registerForDryRun(schema, meta);
      }
      return schema;
    };
  }
  patchYupProtoForOutputTracking(yup);
}
var _registeredRoutePaths = /* @__PURE__ */ new Set();
function wasRouteRegistered(method, path3) {
  return _registeredRoutePaths.has(routeKey(method, path3));
}
function onQueryObserved(method, path3, shape, onUpdate) {
  const entry = getOrCreateSchema(method, path3);
  if (entry.querySchemaConfidence !== "none") return;
  entry.querySchema = shape;
  entry.querySchemaConfidence = "observed";
  if (typeof onUpdate === "function") onUpdate();
}
function onRouteRegistered(method, path3, handlers) {
  _registeredRoutePaths.add(routeKey(method, path3));
  for (const handler of handlers) {
    if (handler?.__isNodoxValidate && handler?.__nodoxSchema) {
      const entry = getOrCreateSchema(method, path3);
      entry.input = handler.__nodoxSchema.jsonSchema;
      entry.inputConfidence = "confirmed";
      entry.source = handler.__nodoxSchema.source;
      if (handler.__nodoxSchema.outputJsonSchema) {
        entry.output = handler.__nodoxSchema.outputJsonSchema;
        entry.outputConfidence = "confirmed";
      }
      registerSchemaForRoute(method, path3, handler.__nodoxSchema);
      return;
    }
  }
  const evSchema = _extractExpressValidatorSchema(handlers);
  if (evSchema) {
    const entry = getOrCreateSchema(method, path3);
    if (CONFIDENCE_ORDER[entry.inputConfidence] < CONFIDENCE_ORDER.inferred) {
      entry.input = evSchema;
      entry.inputConfidence = "inferred";
    }
  }
  const flagged = handlers.filter((fn) => typeof fn === "function" && looksLikeValidator(fn));
  if (flagged.length > 0) {
    if (_dryRunStartupComplete) {
      _dryRunRoute(method, path3, flagged).catch(() => {
      });
    } else {
      pendingDryRuns.push({ method, path: path3, handlers: flagged });
    }
  }
}
var pendingDryRuns = [];
var _dryRunStartupComplete = false;
function _reconstructSchemaFromZodError(error) {
  if (!Array.isArray(error?.issues) || error.issues.length === 0) return null;
  const properties = {};
  const required = [];
  for (const issue of error.issues) {
    if (!issue.path || issue.path.length !== 1) continue;
    const field = String(issue.path[0]);
    if (!field) continue;
    if (issue.code === "invalid_type") {
      const typeMap = {
        string: "string",
        number: "number",
        integer: "integer",
        boolean: "boolean",
        object: "object",
        array: "array",
        date: "string",
        bigint: "integer",
        null: "null",
        undefined: "null"
      };
      const jsType = typeMap[issue.expected] ?? "string";
      properties[field] = issue.expected === "date" ? { type: "string", format: "date-time" } : { type: jsType };
      if (issue.received === "undefined") required.push(field);
    }
  }
  if (Object.keys(properties).length === 0) return null;
  const schema = { type: "object", properties };
  if (required.length > 0) schema.required = [...new Set(required)];
  schema.description = "(inferred from validation errors \u2014 optional fields may be absent)";
  return schema;
}
async function _dryRunRoute(method, path3, handlers) {
  const existing = routeSchemas.get(routeKey(method, path3));
  if (existing?.inputConfidence === "confirmed") return false;
  for (const handler of handlers) {
    const result = await dryRunValidator(handler, method);
    if (result.schema) {
      const meta = capturedSchemas.get(result.schema);
      const library = result.library || meta?.type;
      if (!library) continue;
      const jsonSchema = toJsonSchema(result.schema, library);
      if (!jsonSchema) continue;
      const entry = getOrCreateSchema(method, path3);
      entry.input = jsonSchema;
      entry.inputConfidence = "inferred";
      return true;
    }
    if (result.zodError && !existing?.input) {
      const jsonSchema = _reconstructSchemaFromZodError(result.zodError);
      if (jsonSchema) {
        const entry = getOrCreateSchema(method, path3);
        entry.input = jsonSchema;
        entry.inputConfidence = "inferred";
        return true;
      }
    }
  }
  return false;
}
async function runDeferredDryRuns() {
  for (const { method, path: path3, handlers } of pendingDryRuns) {
    const success = await _dryRunRoute(method, path3, handlers);
    if (success) {
      console.log(`\x1B[32m  \u2713 nodox\x1B[0m \x1B[2mInferred schema for ${method} ${path3}\x1B[0m`);
    } else {
    }
  }
  pendingDryRuns.length = 0;
  _dryRunStartupComplete = true;
}
function onInputObserved(method, path3, shape, confidence = "observed", onUpdate) {
  const entry = getOrCreateSchema(method, path3);
  const existing = CONFIDENCE_ORDER[entry.inputConfidence] ?? 0;
  const incoming = CONFIDENCE_ORDER[confidence] ?? 0;
  if (incoming <= existing) return;
  entry.input = shape;
  entry.inputConfidence = confidence;
  if (typeof onUpdate === "function") {
    onUpdate(method, path3, { input: shape, inputConfidence: confidence });
  }
}
function onResponseObserved(method, path3, shape, confidence = "observed", onUpdate) {
  const entry = getOrCreateSchema(method, path3);
  const existing = CONFIDENCE_ORDER[entry.outputConfidence] ?? 0;
  const incoming = CONFIDENCE_ORDER[confidence] ?? 0;
  if (incoming <= existing) return;
  entry.output = shape;
  entry.outputConfidence = confidence;
  if (typeof onUpdate === "function") {
    onUpdate(method, path3, { output: shape, outputConfidence: confidence });
  }
}
function getRouteSchema(method, path3) {
  return routeSchemas.get(routeKey(method, path3)) ?? null;
}
function enrichRoutesWithSchemas(routes) {
  return routes.map((route) => {
    let schema = getRouteSchema(route.method, route.path);
    if (!schema && _rawCacheEntries) {
      const cacheEntry = _findMatchingCacheEntry(route.method, route.path);
      if (cacheEntry) {
        const s = getOrCreateSchema(route.method, route.path);
        if (cacheEntry.input && s.inputConfidence === "none") {
          s.input = cacheEntry.input;
          s.inputConfidence = "observed";
        }
        if (cacheEntry.output && !s.output) {
          s.output = cacheEntry.output;
          s.outputConfidence = "observed";
        }
        if (cacheEntry.seenCount) s.seenCount = cacheEntry.seenCount;
        schema = s;
      }
    }
    return {
      ...route,
      hasValidator: schema?.inputConfidence === "confirmed" || schema?.inputConfidence === "inferred",
      schema: schema ?? null,
      // Exclude raw handler functions from the serialized route — they're only
      // needed for retroactive schema detection and must not be sent over WebSocket.
      handlers: void 0
    };
  });
}

// src/index.js
function nodox(appOrOptions, options = {}) {
  let app = null;
  if (appOrOptions && typeof appOrOptions.use === "function") {
    app = appOrOptions;
  } else if (appOrOptions && typeof appOrOptions === "object") {
    options = appOrOptions;
  }
  const {
    uiPath = "/__nodox",
    log = true,
    schema = true,
    intercept = true,
    force = false
  } = options;
  if (process.env.NODE_ENV === "production" && !force) {
    console.warn(
      "[nodox] Disabled in production (NODE_ENV=production).\n        Pass { force: true } to override \u2014 but do not expose /__nodox publicly."
    );
    return function nodoxDisabledMiddleware(_req, _res, next) {
      next();
    };
  }
  let routes = [];
  let wsServer = null;
  let serverAttached = false;
  let extractionTimer = null;
  let appInitDone = false;
  let portLogged = false;
  if (schema) initSchemaDetector();
  const cacheCount = schema ? loadCacheIntoRegistry() : 0;
  function scheduleExtraction() {
    if (extractionTimer) clearTimeout(extractionTimer);
    extractionTimer = setTimeout(doExtraction, 50);
  }
  function doExtraction() {
    if (!app) return;
    extractionTimer = null;
    const raw = extractRoutes(app);
    if (schema) {
      for (const route of raw) {
        if (!wasRouteRegistered(route.method, route.path) && route.handlers?.length) {
          onRouteRegistered(route.method, route.path, route.handlers);
        }
      }
    }
    routes = schema ? enrichRoutesWithSchemas(raw) : raw;
    wsServer?.broadcastFullSync();
  }
  const logStartup = (port = "PORT") => {
    if (portLogged) return;
    portLogged = true;
    if (routes.length === 0) {
      const raw = extractRoutes(app);
      routes = schema ? enrichRoutesWithSchemas(raw) : raw;
    }
    console.log(
      `
  \x1B[36m\u25C6 nodox\x1B[0m  \x1B[2mUI \u2192\x1B[0m \x1B[4;36mhttp://localhost:${port}${uiPath}\x1B[0m`
    );
    const count = routes.length;
    const schemaCount = routes.filter((r) => r.hasValidator).length;
    console.log(
      `  \x1B[2m         ${count} route${count !== 1 ? "s" : ""} discovered` + (schemaCount > 0 ? `, ${schemaCount} with schema` : "") + `\x1B[0m
`
    );
  };
  function getState() {
    return { routes };
  }
  function _initWithApp(theApp) {
    if (appInitDone) return;
    appInitDone = true;
    app = theApp;
    const compat = checkExpressCompatibility(theApp);
    if (!compat.compatible) console.warn(compat.warning);
    if (typeof theApp.listen === "function") {
      const originalListen = theApp.listen;
      theApp.listen = function nodoxPatchedListen(...args) {
        const server = originalListen.apply(this, args);
        server.once("listening", () => {
          const addr = server.address();
          const port = typeof addr === "string" ? addr : addr?.port;
          if (schema) runDeferredDryRuns();
          if (log && port && !portLogged) logStartup(port);
          if (!serverAttached) {
            serverAttached = true;
            wsServer = new NodoxWebSocketServer({ getState });
            wsServer.attach(server);
          }
        });
        return server;
      };
    }
    patchApp(theApp, {
      onRouteRegistered(method, path3, handlers) {
        if (schema) onRouteRegistered(method, path3, handlers);
        scheduleExtraction();
      },
      onUse() {
        scheduleExtraction();
      }
    });
    attachUiRoutes(theApp, { uiPath });
  }
  const wasEarlyInit = !!app;
  if (wasEarlyInit) _initWithApp(app);
  setTimeout(async () => {
    if (schema) {
      try {
        const zodMod = await import("zod").catch(() => null);
        if (zodMod) {
          const z = zodMod?.z || zodMod?.default?.z || zodMod;
          if (z) patchZodWithRegistry(z);
        }
      } catch {
      }
      runDeferredDryRuns();
    }
    doExtraction();
    if (log) {
      if (app) _warnIfNoBodyParser(app);
      if (schema && cacheCount === 0 && !findCacheFile()) {
        console.log("[nodox] Run `npx nodox init` once to enable test suite schema seeding.");
      }
      const server = app?._router?.server || app?.server;
      if (server?.listening) {
        logStartup(server.address().port);
      } else if (!portLogged) {
        logStartup();
      }
    }
    wsServer?.broadcastFullSync();
  }, 0);
  const responseInterceptor = intercept ? createResponseInterceptor({
    parsedValueToSchema,
    onRequestBodyShape(method, routePath, shape) {
      if (!schema) return;
      onInputObserved(method, routePath, shape, "observed", () => {
        doExtraction();
        wsServer?.broadcast({ type: "schema-update", method, path: routePath });
      });
    },
    onRequestQueryShape(method, routePath, shape) {
      if (!schema) return;
      onQueryObserved(method, routePath, shape, () => {
        doExtraction();
        wsServer?.broadcast({ type: "schema-update", method, path: routePath });
      });
    },
    onResponseShape(method, routePath, shape, confidence) {
      if (!schema) return;
      onResponseObserved(method, routePath, shape, confidence, () => {
        doExtraction();
        wsServer?.broadcast({ type: "schema-update", method, path: routePath });
      });
    }
  }) : null;
  const inlineUiHandler = !wasEarlyInit ? createUiHandler({ uiPath }) : null;
  return function nodoxMiddleware(req, res, next) {
    if (!appInitDone && req.app) {
      _initWithApp(req.app);
      scheduleExtraction();
    }
    if (inlineUiHandler && req.path.startsWith(uiPath)) {
      return inlineUiHandler(req, res, next);
    }
    if (!serverAttached) {
      serverAttached = true;
      const httpServer = req.socket?.server;
      if (httpServer) {
        wsServer = new NodoxWebSocketServer({ getState });
        wsServer.attach(httpServer);
        if (log && !portLogged) {
          const address = httpServer.address();
          const port = typeof address === "string" ? address : address?.port;
          if (port) logStartup(port);
        }
      } else {
        console.warn("[nodox] Could not obtain HTTP server reference \u2014 WebSocket disabled.");
      }
    }
    if (responseInterceptor) responseInterceptor(req, res, () => {
    });
    next();
  };
}
function _warnIfNoBodyParser(app) {
  if (!app._router?.stack) return;
  const hasBodyParser = app._router.stack.some((layer) => {
    const name = layer.handle?.name || "";
    return ["jsonParser", "urlencodedParser", "json", "bodyParser"].includes(name);
  });
  if (!hasBodyParser) {
    console.warn(
      "[nodox] Warning: no body parser detected.\n        Add express.json() before nodox() for the playground to work.\n"
    );
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  validate
});
