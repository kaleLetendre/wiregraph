// Token distinctiveness — the one gate that decides whether a string is specific
// enough to be a cross-compartment join key.
//
// It lives in its OWN module (rather than in extract/contracts.js, where it grew up)
// because BOTH spec formats need it and the two format modules already point at each
// other: contracts.js dispatches to resource-spec.js's parser, and resource-spec.js
// must validate its resource ids with exactly this predicate. Importing it back out of
// contracts.js would close that cycle, and the cycle is not benign — whichever module
// an entry point happens to load first decides whether the other's module-scope
// `const`s are initialised yet. A leaf module both can import has no such ordering.
//
// contracts.js re-exports isDistinctive, so existing importers are unaffected.

// Common, low-signal names we never want to match on.
const STOP = new Set([
  'id', 'type', 'name', 'version', 'host', 'url', 'uri', 'state', 'status',
  'data', 'value', 'time', 'date', 'code', 'error', 'message', 'sn', 'key',
  'description', 'title', 'summary', 'action', 'channel', 'address', 'reply',
  'examples', 'properties', 'required', 'enum', 'format', 'items', 'schema',
]);

// Generic HTTP endpoints every service exposes — sharing one is NOT a contract
// between two specific services, so they must not mint a cross-compartment seam.
const ROUTE_STOP = new Set([
  '/', '/health', '/healthz', '/health/live', '/health/ready', '/metrics',
  '/status', '/ping', '/ready', '/readyz', '/live', '/livez', '/version',
  '/favicon.ico', '/robots.txt', '/api', '/api/v1', '/api/v2', '/v1', '/v2', '/index',
]);

// Ubiquitous infrastructure environment variables — two services reading
// DATABASE_URL share infra config, not a service-to-service contract.
// (Project-named vars like STRIPE_WEBHOOK_URL still pass — only these exact
// generic names are dropped.)
const ENV_STOP = new Set([
  'DATABASE_URL', 'REDIS_URL', 'REDIS_HOST', 'NODE_ENV', 'PORT', 'HOST', 'HOSTNAME',
  'LOG_LEVEL', 'DEBUG', 'PATH', 'HOME', 'PWD', 'USER', 'SHELL', 'TERM', 'LANG',
  'TZ', 'CI', 'TMPDIR', 'AWS_REGION', 'AWS_PROFILE', 'HTTP_PROXY', 'HTTPS_PROXY',
]);

export function isDistinctive(tok) {
  if (!tok) return false;
  if (tok.includes('/')) { // path / channel address
    if (ROUTE_STOP.has(tok.toLowerCase().replace(/\/+$/, ''))) return false;
    return tok.length >= 5;
  }
  if (STOP.has(tok.toLowerCase())) return false;
  if (ENV_STOP.has(tok.toUpperCase())) return false;
  // dotted/colon topic or routing key (order.created, device:heartbeat)
  if ((tok.includes('.') || tok.includes(':')) && tok.length >= 5 && !/\s/.test(tok)) return true;
  if (tok.includes('_') && tok.length >= 6) return true; // snake_case field / ENV_VAR
  if (/^[a-zA-Z][a-zA-Z]{9,}$/.test(tok)) return true; // long camelCase identifier
  return false;
}

// Why a token was rejected, for a user-facing validation message. Only called on the
// rejection path, so it costs nothing in the matcher.
export function whyNotDistinctive(tok) {
  if (!tok) return 'it is empty';
  if (tok.includes('/')) {
    if (ROUTE_STOP.has(tok.toLowerCase().replace(/\/+$/, ''))) return 'it is a generic endpoint every service exposes';
    return 'it is shorter than 5 characters';
  }
  if (STOP.has(tok.toLowerCase())) return 'it is a generic, low-signal word that matches almost every file';
  if (ENV_STOP.has(tok.toUpperCase())) return 'it is a ubiquitous infrastructure environment variable, not a project-specific name';
  return 'it is too short/generic to be a reliable join key — use a snake_case or SCREAMING_SNAKE name of 6+ characters (e.g. GAME_STATE_PATH), a dotted/colon key, or a 10+ character camelCase identifier';
}
