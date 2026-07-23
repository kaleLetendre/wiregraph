// Contract INFERENCE: turn cross-compartment communication signals observed in
// code — HTTP routes and message topics today — into a draft AsyncAPI 3.0 spec,
// so wiregraph builds the cross-service graph without hand-written contracts. The
// synthesized spec is consumed by the EXISTING pipeline unchanged (loadContracts
// -> matchContracts -> buildWireEdges in src/extract/contracts.js).
//
// Detectors (src/extract/parse.js) emit candidates { kind, token, role, label };
// here we cluster the distinctive tokens shared by >= 2 compartments into seams and
// synthesize one AsyncAPI channel per seam. CRITICAL round-trip: the channel
// `address` is what collectTokens reads back (a path is {param}-trimmed to a
// prefix; a non-path topic is matched literally), so the inferred spec lights up
// REFERENCES edges from every compartment that mentions the token. Drafts are PROPOSED,
// evidence-tagged, never silently written — direction is heuristic, the shared
// token is the real signal.

import YAML from 'yaml';
import { readFileSync } from 'node:fs';
import { walkSources } from '../extract/walk.js';
import { parseSource } from '../extract/parse.js';
import { isDistinctive } from '../extract/contracts.js';

// --- 1. extract contract candidates across the workspace --------------------
// Mirrors extractCode's walk loop, collecting the `candidates` parseSource now
// returns. fileFilter (optional Set of abs paths) restricts the scan. `roots` may
// be a single root (string) or a UNION of member roots (array) — walkSources
// shares one dedup set across the union so overlapping members are counted once.
export function extractCandidatesAcross(roots, fileFilter = null) {
  const out = [];
  for (const f of walkSources(roots)) {
    if (fileFilter && !fileFilter.has(f.abs)) continue;
    let src;
    try { src = readFileSync(f.abs, 'utf8'); } catch { continue; }
    let parsed;
    try { parsed = parseSource(src, f.lang, f.variant); } catch { continue; }
    for (const c of parsed.candidates || []) {
      out.push({ kind: c.kind, token: c.token, role: c.role, label: c.label, compartment: f.compartment, file: f.relPath, line: c.line });
    }
  }
  return out;
}

// Single-root convenience (back-compat): unchanged behavior for existing callers.
export function extractCandidates(root, fileFilter = null) {
  return extractCandidatesAcross(root, fileFilter);
}

// Candidates for a UNION of roots -> cross-compartment seams. This is what link /
// unlink and /wiregraph-contracts use so inference spans every member.
export function inferSeamsAcross(roots, fileFilter = null) {
  return clusterSeams(extractCandidatesAcross(roots, fileFilter));
}

// --- 2. cluster shared tokens into cross-compartment seams ------------------
// HTTP path -> AsyncAPI address form (`:id`/`<id>` -> `{id}`) so variants group
// and collectTokens' {param}-trim applies; message topics are kept verbatim.
export function toAsyncApiPath(p) {
  return '/' + String(p).split('/').filter(Boolean).map((seg) => {
    if (seg.startsWith(':')) return `{${seg.slice(1)}}`;
    if (seg.startsWith('{') && seg.endsWith('}')) return seg;
    if (seg.startsWith('<') && seg.endsWith('>')) return `{${seg.slice(1, -1)}}`;
    return seg;
  }).join('/');
}

function normToken(kind, token) {
  return kind === 'wire' ? toAsyncApiPath(token) : token;
}

function channelKey(kind, token) {
  const base = token.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${kind}-${base || 'x'}`.toLowerCase();
}

// Group candidates by (kind, normalized token); keep tokens that are distinctive
// AND span >= 2 distinct compartments (the cross-compartment seam — a
// single-compartment token is not a contract). Returns
// [{ kind, token, compartments, inCompartments, outCompartments, labels }].
export function clusterSeams(candidates) {
  const groups = new Map(); // key -> { kind, token, compartments: Map(compartment->Set(role)), labels: Set }
  for (const c of candidates) {
    if (c.kind === 'import') continue; // imports become IMPORTS edges, not token-matched contracts
    const tok = normToken(c.kind, c.token);
    if (!isDistinctive(tok)) continue;
    const key = `${c.kind}\0${tok}`;
    if (!groups.has(key)) groups.set(key, { kind: c.kind, token: tok, compartments: new Map(), labels: new Set() });
    const g = groups.get(key);
    if (!g.compartments.has(c.compartment)) g.compartments.set(c.compartment, new Set());
    g.compartments.get(c.compartment).add(c.role);
    if (c.label) g.labels.add(c.label);
  }
  const seams = [];
  for (const g of groups.values()) {
    if (g.compartments.size < 2) continue;
    const inCompartments = [...g.compartments].filter(([, roles]) => roles.has('in')).map(([r]) => r).sort();
    const outCompartments = [...g.compartments].filter(([, roles]) => roles.has('out')).map(([r]) => r).sort();
    seams.push({ kind: g.kind, token: g.token, compartments: [...g.compartments.keys()].sort(), inCompartments, outCompartments, labels: [...g.labels].sort() });
  }
  return seams.sort((a, b) => (a.kind + a.token).localeCompare(b.kind + b.token));
}

// --- 3. synthesize a draft AsyncAPI 3.0 doc ---------------------------------
// One channel per seam, address = the token (path or topic). A server-perspective
// `receive` operation per channel. We also record, as `x-wiregraph-*` extensions,
// which compartments PRODUCE (call/send — the seam's out side) and CONSUME
// (define/receive — the in side): the scan already knows this, so encoding it lets
// buildWireEdges derive directional producer->consumer WIRE edges straight from an
// inferred spec, with no WIREGRAPH_SERVER_REPO env var. (REFERENCES don't need it;
// directional WIRE does — and throwing the direction away made the round-trip lossy.)
export function synthesizeAsyncApi(seams, title = 'wiregraph-inferred') {
  const channels = {};
  const operations = {};
  for (const s of seams) {
    const key = channelKey(s.kind, s.token);
    channels[key] = { address: s.token, messages: { request: { payload: { type: 'object', properties: {} } } } };
    if (s.outCompartments.length) channels[key]['x-wiregraph-producers'] = s.outCompartments;
    if (s.inCompartments.length) channels[key]['x-wiregraph-consumers'] = s.inCompartments;
    operations[`receive-${key}`] = {
      action: 'receive',
      channel: { $ref: `#/channels/${key}` },
      messages: [{ $ref: `#/channels/${key}/messages/request` }],
    };
  }
  return YAML.stringify({ asyncapi: '3.0.0', info: { title, version: '0.1.0' }, channels, operations });
}

// One-shot: candidates for a root -> seams. Convenience for the CLI/tests.
export function inferSeams(root, fileFilter = null) {
  return clusterSeams(extractCandidates(root, fileFilter));
}

// Human-readable summary of what was found (for the command output).
export function formatSeams(seams) {
  if (!seams.length) {
    return [
      'No cross-compartment contract seams to infer. That is often expected — common reasons:',
      '  • you already have hand-written AsyncAPI contracts: those are matched directly,',
      '    so there is nothing left to infer (see the contract count in /wiregraph-status);',
      '  • comms use a mechanism the scan does not pair yet (dynamic URLs, in-process',
      '    calls), rather than a literal route/topic string shared across compartments;',
      '  • the related compartments are not indexed together in one workspace.',
    ].join('\n');
  }
  const lines = [`Found ${seams.length} cross-compartment seam(s):`, ''];
  for (const s of seams) {
    const head = s.kind === 'wire'
      ? `  [wire] ${(s.labels.join('/') || 'http').toUpperCase()} ${s.token}`
      : `  [${s.kind}] ${s.token}`;
    lines.push(head);
    const dir = [];
    if (s.inCompartments.length) dir.push(`in: ${s.inCompartments.join(', ')}`);
    if (s.outCompartments.length) dir.push(`out: ${s.outCompartments.join(', ')}`);
    lines.push(`      compartments: ${s.compartments.join(', ')}${dir.length ? ' — ' + dir.join('; ') : ''}`);
  }
  return lines.join('\n');
}
