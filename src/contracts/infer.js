// Contract INFERENCE: turn HTTP routes observed in code into a draft AsyncAPI 3.0
// spec, so wiregraph can build the cross-service graph without the team having
// hand-written any contracts. This is the "creation" front-end; the synthesized
// spec is consumed by the EXISTING pipeline unchanged (loadContracts ->
// matchContracts -> buildWireEdges in src/extract/contracts.js).
//
// CRITICAL round-trip: the generator must emit exactly the keys the extractor
// reads back — channel `address` (collectTokens turns it into a path token,
// trimming {param} segments to a prefix) and payload `properties` keys. That's
// what makes the inferred spec light up REFERENCES edges from BOTH the repo that
// defines a route and the repo that calls it, joining them across the boundary.
//
// Drafts are PROPOSED, not authoritative — the route side ('server'/'client'/
// 'unknown') is a heuristic; the shared path is the real signal. Only cross-repo
// paths (referenced by >= 2 repos) become contract channels.

import YAML from 'yaml';
import { readFileSync } from 'node:fs';
import { walkSources } from '../extract/walk.js';
import { parseSource } from '../extract/parse.js';

// --- 1. extract routes across the workspace ---------------------------------
// Mirrors extractCode's walk loop, but collects the `routes` parseSource now
// returns. fileFilter (optional Set of abs paths) restricts the scan.
export function extractRoutes(root, fileFilter = null) {
  const out = [];
  for (const f of walkSources(root)) {
    if (fileFilter && !fileFilter.has(f.abs)) continue;
    let src;
    try { src = readFileSync(f.abs, 'utf8'); } catch { continue; }
    let parsed;
    try { parsed = parseSource(src, f.lang, f.variant); } catch { continue; }
    for (const r of parsed.routes || []) {
      out.push({ method: r.method, path: r.path, side: r.side, repo: f.repo, file: f.relPath, line: r.line });
    }
  }
  return out;
}

// --- 2. cluster shared paths into cross-repo seams --------------------------
// Convert a raw route path to AsyncAPI address form (`:id`/`<id>` -> `{id}`) so
// the same endpoint written different ways groups together AND so collectTokens'
// {param}-trimming prefix logic applies on read-back.
export function toAsyncApiPath(p) {
  return '/' + String(p).split('/').filter(Boolean).map((seg) => {
    if (seg.startsWith(':')) return `{${seg.slice(1)}}`;
    if (seg.startsWith('{') && seg.endsWith('}')) return seg;
    if (seg.startsWith('<') && seg.endsWith('>')) return `{${seg.slice(1, -1)}}`;
    return seg;
  }).join('/');
}

function channelKey(apiPath) {
  const k = apiPath.split('/').filter(Boolean).map((s) => s.replace(/[{}]/g, '')).join('-').replace(/[^A-Za-z0-9-]/g, '-');
  return k || 'root';
}

// Group routes by AsyncAPI path; keep only paths spanning >= 2 distinct repos
// (the cross-repo seam — a single-repo path is not a contract). Returns
// [{ path, repos, serverRepos, methods }] sorted by path.
export function clusterSeams(routes) {
  const groups = new Map(); // apiPath -> { repos: Map(repo -> Set(side)), methods: Set }
  for (const r of routes) {
    const ap = toAsyncApiPath(r.path);
    if (!groups.has(ap)) groups.set(ap, { repos: new Map(), methods: new Set() });
    const g = groups.get(ap);
    if (!g.repos.has(r.repo)) g.repos.set(r.repo, new Set());
    g.repos.get(r.repo).add(r.side);
    g.methods.add(r.method);
  }
  const seams = [];
  for (const [path, g] of groups) {
    if (g.repos.size < 2) continue;
    const serverRepos = [...g.repos].filter(([, sides]) => sides.has('server')).map(([repo]) => repo);
    seams.push({ path, repos: [...g.repos.keys()].sort(), serverRepos, methods: [...g.methods].sort() });
  }
  return seams.sort((a, b) => a.path.localeCompare(b.path));
}

// --- 3. synthesize a draft AsyncAPI 3.0 doc ---------------------------------
// One channel per seam (address = the path), one server-perspective `receive`
// operation (the repo that DEFINES the route is the server, so it receives the
// request). classifyDirections reads action:receive as client->server, which is
// the right direction for an HTTP request seam.
export function synthesizeAsyncApi(seams, title = 'wiregraph-inferred') {
  const channels = {};
  const operations = {};
  for (const s of seams) {
    const key = channelKey(s.path);
    channels[key] = {
      address: s.path,
      messages: { request: { payload: { type: 'object', properties: {} } } },
    };
    operations[`receive-${key}`] = {
      action: 'receive',
      channel: { $ref: `#/channels/${key}` },
      messages: [{ $ref: `#/channels/${key}/messages/request` }],
    };
  }
  const doc = { asyncapi: '3.0.0', info: { title, version: '0.1.0' }, channels, operations };
  return YAML.stringify(doc);
}

// One-shot: routes for a root -> seams. Convenience for the CLI/tests.
export function inferSeams(root, fileFilter = null) {
  return clusterSeams(extractRoutes(root, fileFilter));
}

// Human-readable summary of what was found (for the command output).
export function formatSeams(seams) {
  if (!seams.length) {
    return 'No cross-repo wire seams found (no HTTP path is referenced by 2+ repos). '
      + 'wiregraph infers contracts from shared HTTP routes across repos — make sure related '
      + 'repos are indexed together in one workspace.';
  }
  const lines = [`Found ${seams.length} cross-repo wire seam(s):`, ''];
  for (const s of seams) {
    const server = s.serverRepos.length ? ` — server: ${s.serverRepos.join(', ')}` : ' — server: (unresolved)';
    lines.push(`  ${s.methods.join('/').toUpperCase()} ${s.path}`);
    lines.push(`      repos: ${s.repos.join(', ')}${server}`);
  }
  return lines.join('\n');
}
