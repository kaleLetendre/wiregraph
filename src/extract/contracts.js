// Cross-compartment wire edges via the contracts dir.
//
// Compartments that don't call each other in-process may still agree on wire
// shapes published in an AsyncAPI contracts dir. So the join between a producer in
// one compartment and the consumer in another that answers it is the *contract*,
// not a call edge. We model each contract file as a Contract node, pull out the
// distinctive wire tokens it defines (channel address paths + snake_case payload
// fields), then attach any code symbol whose body mentions one of those tokens
// to the Contract via a REFERENCES edge tagged evidence:'contract-match'.
//
// This is a heuristic, by construction: a REFERENCES edge means "this code
// mentions a string this contract defines", not "verified to implement it".
// The evidence tag keeps that honest for downstream queries.

import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import YAML from 'yaml';
import { contractId } from '../model.js';
import { walkSources } from './walk.js';

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

// A channel `address` -> the matchable token: a path is trimmed at its first
// {param} segment to a prefix; a non-path (topic / routing key) is matched
// literally. Shared by collectTokens and the wire-role reader so both key on the
// exact same token that lands on REFERENCES edges. null = no matchable token.
function normalizeAddress(addr) {
  if (typeof addr !== 'string' || !addr) return null;
  if (addr.startsWith('/')) {
    const prefix = addr.split('/').filter((s) => s && !s.includes('{')).join('/');
    return prefix ? '/' + prefix : null;
  }
  return addr;
}

// Walk a parsed YAML doc collecting every key that sits under a "properties"
// map, plus channel address paths (with {param} segments trimmed to a prefix).
function collectTokens(doc) {
  const tokens = new Set();

  (function walk(node, parentKey) {
    if (Array.isArray(node)) {
      for (const v of node) walk(v, parentKey);
      return;
    }
    if (node && typeof node === 'object') {
      if (parentKey === 'properties') {
        for (const k of Object.keys(node)) tokens.add(k);
      }
      for (const [k, v] of Object.entries(node)) {
        if (k === 'address') {
          const t = normalizeAddress(v);
          if (t) tokens.add(t);
        }
        walk(v, k);
      }
    }
  })(doc, null);

  return [...tokens].filter(isDistinctive);
}

// Read the producer/consumer compartments the inference encoded per channel, keyed
// by the same normalized token REFERENCES edges use. Empty when a (hand-written)
// spec carries no x-wiregraph-* extensions — buildWireEdges then falls back to env.
function readWireRoles(doc) {
  const roles = new Map();
  for (const ch of Object.values(doc.channels || {})) {
    if (!ch || typeof ch !== 'object') continue;
    const tok = normalizeAddress(ch.address);
    if (!tok) continue;
    const producers = new Set(Array.isArray(ch['x-wiregraph-producers']) ? ch['x-wiregraph-producers'] : []);
    const consumers = new Set(Array.isArray(ch['x-wiregraph-consumers']) ? ch['x-wiregraph-consumers'] : []);
    if (producers.size || consumers.size) roles.set(tok, { producers, consumers });
  }
  return roles;
}

// --- direction inference ----------------------------------------------------
// Follow a #/-style JSON pointer within the doc.
function resolveRef(doc, ref) {
  if (!ref || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = doc;
  for (const p of parts) { if (cur == null) return null; cur = cur[p]; }
  return cur;
}
// Follow $ref chains (message ref -> channel message -> component message).
function deref(doc, node) {
  let n = node, guard = 0;
  while (n && n.$ref && guard++ < 10) n = resolveRef(doc, n.$ref);
  return n;
}
function messagePayload(doc, msgRef) {
  const m = deref(doc, msgRef);
  return m ? deref(doc, m.payload) : null;
}
function collectSchemaTokens(doc, schema, out, depth = 0) {
  const s = deref(doc, schema);
  if (!s || depth > 8) return;
  if (s.properties && typeof s.properties === 'object') {
    for (const [k, v] of Object.entries(s.properties)) { out.add(k); collectSchemaTokens(doc, v, out, depth + 1); }
  }
  if (s.items) collectSchemaTokens(doc, s.items, out, depth + 1);
  for (const comb of ['allOf', 'oneOf', 'anyOf']) {
    if (Array.isArray(s[comb])) s[comb].forEach((x) => collectSchemaTokens(doc, x, out, depth + 1));
  }
}
// Returns { token: 'c2s' | 's2c' }. c2s = terminal/client -> server (request),
// s2c = server -> terminal (reply). Contracts are server-perspective: an
// operation with action:receive means the server receives the request.
function classifyDirections(doc) {
  const dir = {};
  const tag = (msgRefs, direction) => {
    if (!Array.isArray(msgRefs)) return;
    for (const ref of msgRefs) {
      const toks = new Set();
      collectSchemaTokens(doc, messagePayload(doc, ref), toks);
      for (const t of toks) if (isDistinctive(t) && !(t in dir)) dir[t] = direction;
    }
  };
  for (const op of Object.values(doc.operations || {})) {
    const reqDir = op.action === 'send' ? 's2c' : 'c2s';
    tag(op.messages, reqDir);
    if (op.reply) tag(op.reply.messages, reqDir === 'c2s' ? 's2c' : 'c2s');
  }
  return dir;
}

export function loadContracts(graph, contractsDir, log = () => {}) {
  let entries;
  try {
    entries = readdirSync(contractsDir);
  } catch {
    log(`  no contracts dir at ${contractsDir}`);
    return [];
  }

  const contracts = [];
  for (const f of entries) {
    if (!f.endsWith('.asyncapi.yaml') && !f.endsWith('.asyncapi.yml')) continue;
    let doc;
    try {
      doc = YAML.parse(readFileSync(join(contractsDir, f), 'utf8'));
    } catch (e) {
      log(`  failed to parse ${f}: ${e.message}`);
      continue;
    }
    const name = doc?.info?.title || basename(f).replace(/\.asyncapi\.ya?ml$/, '');
    const id = contractId(name);
    const tokens = collectTokens(doc);
    const direction = classifyDirections(doc);
    // Channel address paths are endpoints the client calls -> client to server.
    for (const t of tokens) if (t.startsWith('/') && !(t in direction)) direction[t] = 'c2s';
    graph.addContract({ id, name, kind: 'asyncapi', file: f });
    contracts.push({ id, name, file: f, tokens, direction, wireRoles: readWireRoles(doc) });
  }
  log(`  loaded ${contracts.length} contracts; ${contracts.reduce((n, c) => n + c.tokens.length, 0)} wire tokens`);
  return contracts;
}

// Build a per-file list of {startLine, endLine, id} intervals from real symbols
// so we can map a token's line back to the function that contains it.
function symbolIntervals(graph) {
  const byFile = new Map(); // `${compartment}\0${file}` -> [{startLine,endLine,id}]
  for (const s of graph.symbols.values()) {
    if (s.kind === 'module') continue;
    const k = `${s.compartment}\0${s.file}`;
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(s);
  }
  return byFile;
}

function enclosingSymbol(intervals, line, moduleIdOf) {
  let best = null;
  if (intervals) {
    for (const s of intervals) {
      if (s.startLine <= line && s.endLine >= line) {
        if (!best || (s.endLine - s.startLine) < (best.endLine - best.startLine)) best = s;
      }
    }
  }
  return best ? best.id : moduleIdOf;
}

// fileFilter (optional): a Set of absolute paths to restrict matching to (the
// incremental path). When present, only those files are scanned for wire tokens.
export function matchContracts(graph, rootDir, contracts, log = () => {}, fileFilter = null) {
  if (!contracts.length) return { refs: 0 };

  // token -> Set(contractId)
  const tokenIndex = new Map();
  for (const c of contracts) {
    for (const t of c.tokens) {
      if (!tokenIndex.has(t)) tokenIndex.set(t, new Set());
      tokenIndex.get(t).add(c.id);
    }
  }
  const allTokens = [...tokenIndex.keys()];
  const intervals = symbolIntervals(graph);

  const edgeSet = new Set();
  let refs = 0;

  for (const f of walkSources(rootDir)) {
    if (fileFilter && !fileFilter.has(f.abs)) continue;
    let text;
    try {
      text = readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    const fileIntervals = intervals.get(`${f.compartment}\0${f.relPath}`);
    const moduleIdOf = `sym:${f.compartment}:${f.relPath}:<module>:0`;

    for (const tok of allTokens) {
      const at = text.indexOf(tok);
      if (at < 0) continue;
      // For identifier tokens, require a word boundary to avoid substring hits.
      if (!tok.includes('/')) {
        const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (!re.test(text)) continue;
      }
      const line = text.slice(0, at).split('\n').length;
      const fromId = enclosingSymbol(fileIntervals, line, moduleIdOf);
      for (const cid of tokenIndex.get(tok)) {
        const key = `${fromId}->${cid}->${tok}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        graph.addEdge('REFERENCES', fromId, cid, {
          evidence: 'contract-match',
          token: tok,
          side: f.compartment,
        });
        refs++;
      }
    }
  }
  log(`  matched ${refs} contract REFERENCES edges`);
  return { refs };
}

// Derive direct symbol -> symbol WIRE edges from the REFERENCES already in the
// graph. The contract is the *reason* for the edge, not a node on the path: a
// token referenced on both the terminal side and the server side becomes a
// directed edge publisher -> consumer, with direction taken from the contract
// (request = terminal->server, reply = server->terminal). A token only one side
// touches yields no edge — that asymmetry is the gap, made visible by absence.
// WIRE edges encode a producer->consumer direction, which needs to know which
// compartment is the "server" side. That's project-specific, so it's configured
// via env (WIREGRAPH_SERVER_REPO, and optionally WIREGRAPH_SELF_REPO to exclude a
// root/aggregate compartment). With no server compartment set, directional WIRE
// derivation is skipped — the REFERENCES edges and Contract nodes (which
// trace_contract and path_between use) are unaffected; only the export
// visualizations use WIRE.
const SERVER_COMPARTMENT = process.env.WIREGRAPH_SERVER_REPO || null;
const SELF_COMPARTMENT = process.env.WIREGRAPH_SELF_REPO || null;
const MAX_PAIRS_PER_TOKEN = 25;

export function buildWireEdges(graph, contracts, log = () => {}) {
  const cById = new Map(contracts.map((c) => [c.id, c]));
  // Two ways to orient a WIRE edge: the producer/consumer compartments the
  // inference encoded per channel (x-wiregraph-*, read into c.wireRoles), or — for
  // a hand-written spec without them — the WIREGRAPH_SERVER_REPO env var. With
  // neither, skip: REFERENCES + Contract nodes are unaffected, only WIRE.
  const anyRoles = contracts.some((c) => c.wireRoles && c.wireRoles.size);
  if (!anyRoles && !SERVER_COMPARTMENT) {
    log('  WIRE edges skipped (no producer/consumer compartments in specs; set WIREGRAPH_SERVER_REPO for hand-written specs without direction)');
    return { wire: 0, gaps: 0 };
  }

  // contractId|token -> [symbol, ...]
  const groups = new Map();
  for (const e of graph.edges) {
    if (e.type !== 'REFERENCES') continue;
    const sym = graph.symbols.get(e.from);
    if (!sym || sym.compartment === SELF_COMPARTMENT) continue;
    const key = e.to + '|' + e.props.token;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sym);
  }

  let wire = 0, gaps = 0;
  const seen = new Set();
  for (const [key, syms] of groups) {
    const sep = key.indexOf('|');
    const cid = key.slice(0, sep);
    const token = key.slice(sep + 1);
    const c = cById.get(cid);
    if (!c) continue;

    let pubs, cons, dirLabel;
    const roles = c.wireRoles && c.wireRoles.get(token);
    if (roles && (roles.producers.size || roles.consumers.size)) {
      // Direction encoded by inference: producers (callers/senders) -> consumers
      // (definers/receivers). No env var needed — the scan already knew the sides.
      pubs = syms.filter((s) => roles.producers.has(s.compartment));
      cons = syms.filter((s) => roles.consumers.has(s.compartment));
      dirLabel = 'c2s';
    } else if (SERVER_COMPARTMENT) {
      // Hand-written spec without the extension: orient via the configured server.
      const server = syms.filter((s) => s.compartment === SERVER_COMPARTMENT);
      const terminal = syms.filter((s) => s.compartment !== SERVER_COMPARTMENT);
      const dir = c.direction[token] || 'unknown';
      if (dir === 's2c') { pubs = server; cons = terminal; dirLabel = 's2c'; }
      else { pubs = terminal; cons = server; dirLabel = dir === 'unknown' ? 'c2s?' : 'c2s'; }
    } else { continue; } // this contract has no roles and no env server — can't orient
    if (!pubs.length || !cons.length) { gaps++; continue; }

    let pairs = 0;
    outer:
    for (const p of pubs) {
      for (const q of cons) {
        if (p.id === q.id) continue;
        const k = `${p.id}->${q.id}|${token}`;
        if (seen.has(k)) continue;
        seen.add(k);
        graph.addEdge('WIRE', p.id, q.id, {
          token, contract: c.name, direction: dirLabel, evidence: 'wire-derived',
        });
        wire++;
        if (++pairs >= MAX_PAIRS_PER_TOKEN) break outer;
      }
    }
  }
  log(`  derived ${wire} WIRE edges (symbol->symbol); ${gaps} one-sided tokens (no wire = gap)`);
  return { wire, gaps };
}
