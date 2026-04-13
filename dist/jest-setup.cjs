const __importMetaUrl = require('url').pathToFileURL(__filename).href;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
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
var init_response_interceptor = __esm({
  "src/schema/response-interceptor.js"() {
  }
});

// src/layer4/response-interceptor-compat.js
var response_interceptor_compat_exports = {};
__export(response_interceptor_compat_exports, {
  inferShape: () => inferShape,
  mergeShapes: () => mergeShapes
});
var init_response_interceptor_compat = __esm({
  "src/layer4/response-interceptor-compat.js"() {
    init_response_interceptor();
  }
});

// src/layer4/cache-manager.js
var cache_manager_exports = {};
__export(cache_manager_exports, {
  getCacheStats: () => getCacheStats,
  mergeCacheEntry: () => mergeCacheEntry,
  pruneCache: () => pruneCache,
  readCache: () => readCache,
  writeCache: () => writeCache
});
function readCache(cacheFile) {
  try {
    if (!import_fs.default.existsSync(cacheFile)) {
      return { version: CACHE_VERSION, routes: {} };
    }
    const raw = import_fs.default.readFileSync(cacheFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { version: CACHE_VERSION, routes: {} };
    }
    if (!parsed.routes || typeof parsed.routes !== "object") {
      parsed.routes = {};
    }
    return parsed;
  } catch {
    return { version: CACHE_VERSION, routes: {} };
  }
}
function writeCache(cacheFile, cache) {
  const updated = {
    ...cache,
    version: CACHE_VERSION,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const json = JSON.stringify(updated, null, 2);
  const tmpFile = cacheFile + ".tmp";
  import_fs.default.writeFileSync(tmpFile, json, "utf8");
  import_fs.default.renameSync(tmpFile, cacheFile);
}
function mergeCacheEntry(cache, key, exchange) {
  const routes = { ...cache.routes };
  const existing = routes[key];
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (!existing) {
    routes[key] = {
      method: exchange.method,
      path: exchange.path,
      input: exchange.reqShape ?? null,
      output: exchange.resShape ?? null,
      inputConfidence: exchange.reqShape ? "observed" : "none",
      outputConfidence: exchange.resShape ? "observed" : "none",
      seenCount: 1,
      lastSeen: now
    };
  } else {
    const mergedInput = exchange.reqShape ? mergeShapes(existing.input, exchange.reqShape) : existing.input;
    const mergedOutput = exchange.resShape ? mergeShapes(existing.output, exchange.resShape) : existing.output;
    routes[key] = {
      ...existing,
      input: mergedInput,
      output: mergedOutput,
      inputConfidence: mergedInput ? "observed" : existing.inputConfidence,
      outputConfidence: mergedOutput ? "observed" : existing.outputConfidence,
      seenCount: (existing.seenCount || 0) + 1,
      lastSeen: now
    };
  }
  return { ...cache, routes };
}
function pruneCache(cacheFile) {
  writeCache(cacheFile, { version: CACHE_VERSION, routes: {} });
}
function getCacheStats(cache) {
  const routes = Object.values(cache.routes || {});
  return {
    routeCount: routes.length,
    withInput: routes.filter((r) => r.input).length,
    withOutput: routes.filter((r) => r.output).length
  };
}
var import_fs, CACHE_VERSION;
var init_cache_manager = __esm({
  "src/layer4/cache-manager.js"() {
    import_fs = __toESM(require("fs"), 1);
    init_response_interceptor();
    CACHE_VERSION = 1;
  }
});

// src/layer4/cache-reader.js
var cache_reader_exports = {};
__export(cache_reader_exports, {
  findCacheFile: () => findCacheFile,
  loadCacheEntries: () => loadCacheEntries
});
function findCacheFile(startDir = process.cwd()) {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = import_path.default.join(dir, ".apicache.json");
    if (import_fs2.default.existsSync(candidate)) return candidate;
    const parent = import_path.default.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function loadCacheEntries(cacheFile) {
  const filePath = cacheFile || findCacheFile();
  if (!filePath) return {};
  try {
    const raw = import_fs2.default.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.routes || {};
  } catch {
    return {};
  }
}
var import_fs2, import_path;
var init_cache_reader = __esm({
  "src/layer4/cache-reader.js"() {
    import_fs2 = __toESM(require("fs"), 1);
    import_path = __toESM(require("path"), 1);
  }
});

// src/layer4/jest-setup.js
var import_http = __toESM(require("http"), 1);
var import_https = __toESM(require("https"), 1);
var import_path2 = __toESM(require("path"), 1);
var inferShape2;
var mergeShapes2;
var readCache2;
var writeCache2;
var mergeCacheEntry2;
var findCacheFile2;
async function loadInternals() {
  const interceptor = await Promise.resolve().then(() => (init_response_interceptor_compat(), response_interceptor_compat_exports));
  inferShape2 = interceptor.inferShape;
  mergeShapes2 = interceptor.mergeShapes;
  const manager = await Promise.resolve().then(() => (init_cache_manager(), cache_manager_exports));
  readCache2 = manager.readCache;
  writeCache2 = manager.writeCache;
  mergeCacheEntry2 = manager.mergeCacheEntry;
  const reader = await Promise.resolve().then(() => (init_cache_reader(), cache_reader_exports));
  findCacheFile2 = reader.findCacheFile;
}
var _ready = loadInternals().catch((err) => {
  console.warn("[nodox] jest-setup: failed to load internals:", err.message);
});
var exchanges = /* @__PURE__ */ new Map();
var LOCAL_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
function isLocalHost(hostname) {
  return LOCAL_HOSTS.has(hostname) || hostname?.endsWith(".localhost");
}
var originalHttpRequest = import_http.default.request.bind(import_http.default);
var originalHttpsRequest = import_https.default.request.bind(import_https.default);
function makePatched(originalFn) {
  return function patchedRequest(input, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    let method = "GET", urlPath = "/", hostname = "";
    if (typeof input === "string" || input instanceof URL) {
      try {
        const u = input instanceof URL ? input : new URL(input);
        method = (options && options.method || "GET").toUpperCase();
        urlPath = u.pathname + (u.search || "");
        hostname = u.hostname;
      } catch {
      }
    } else if (input && typeof input === "object") {
      method = (input.method || "GET").toUpperCase();
      urlPath = input.path || "/";
      hostname = input.hostname || (input.host ? input.host.split(":")[0] : "");
    }
    if (!isLocalHost(hostname)) {
      return originalFn(input, options, callback);
    }
    const reqBodyChunks = [];
    const wrappedCallback = callback ? (res) => {
      const resChunks = [];
      res.on("data", (chunk) => {
        if (chunk) resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        if (!inferShape2) return;
        try {
          const contentType = res.headers?.["content-type"] || "";
          const rawBody = Buffer.concat(resChunks).toString();
          let parsed = null;
          if (contentType.includes("application/json") && rawBody.trim()) {
            try {
              parsed = JSON.parse(rawBody);
            } catch {
            }
          }
          if (parsed !== null && res.statusCode < 500) {
            const key = `${method}:${urlPath}`;
            const resShape = inferShape2(parsed);
            const existing = exchanges.get(key);
            if (existing) {
              exchanges.set(key, {
                ...existing,
                resShape: mergeShapes2(existing.resShape, resShape),
                resStatus: res.statusCode
              });
            } else {
              exchanges.set(key, {
                method,
                path: urlPath,
                reqShape: null,
                resShape,
                resStatus: res.statusCode
              });
            }
          }
        } catch {
        }
      });
      callback(res);
    } : null;
    const req = originalFn(input, options, wrappedCallback);
    const origWrite = req.write.bind(req);
    req.write = function interceptedWrite(chunk, encoding, cb) {
      if (chunk) reqBodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return origWrite(chunk, encoding, cb);
    };
    const origEnd = req.end.bind(req);
    req.end = function interceptedEnd(chunk, encoding, cb) {
      if (chunk) reqBodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (reqBodyChunks.length > 0 && inferShape2) {
        try {
          const raw = Buffer.concat(reqBodyChunks).toString();
          const parsed = JSON.parse(raw);
          const key = `${method}:${urlPath}`;
          const reqShape = inferShape2(parsed);
          const existing = exchanges.get(key);
          if (existing) {
            exchanges.set(key, { ...existing, reqShape: mergeShapes2(existing.reqShape, reqShape) });
          } else {
            exchanges.set(key, { method, path: urlPath, reqShape, resShape: null, resStatus: null });
          }
        } catch {
        }
      }
      return origEnd(chunk, encoding, cb);
    };
    return req;
  };
}
import_http.default.request = makePatched(originalHttpRequest);
import_http.default.get = function patchedGet(input, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const req = import_http.default.request(input, { ...options || {}, method: "GET" }, callback);
  req.end();
  return req;
};
import_https.default.request = makePatched(originalHttpsRequest);
import_https.default.get = function patchedHttpsGet(input, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const req = import_https.default.request(input, { ...options || {}, method: "GET" }, callback);
  req.end();
  return req;
};
process.on("exit", () => {
  if (exchanges.size === 0) return;
  if (!writeCache2 || !readCache2 || !mergeCacheEntry2 || !findCacheFile2) return;
  try {
    const cacheFile = findCacheFile2() ?? import_path2.default.resolve(process.cwd(), ".apicache.json");
    const existing = readCache2(cacheFile);
    let merged = { ...existing };
    for (const [key, exchange] of exchanges) {
      merged = mergeCacheEntry2(merged, key, exchange);
    }
    writeCache2(cacheFile, merged);
  } catch (err) {
    console.warn("[nodox] Failed to write .apicache.json:", err.message);
  }
});
