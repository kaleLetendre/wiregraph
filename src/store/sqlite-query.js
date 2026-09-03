// Query layer for the SQLite backend — implements the same tools as the Neo4j
// MCP server (graph_stats, find_symbol, get_source, trace_callers/callees,
// path_between, trace_contract), scoped to a project, returning the same text
// shapes. Graph traversals run as in-JS BFS over the edge rows (the graph is
// small), which is simpler and faster here than recursive SQL.

import { readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { readState, members, memberRoots, modeSummary } from '../../scripts/lib/state.mjs';
import { decodeResourceDirection } from '../extract/resource-spec.js';
import { decodeInprocDirection } from '../extract/inproc-spec.js';
import { INFERRED_PATH_SEP, INFERRED_UNIQ_SEP } from '../extract/compartment-decl.js';

// Which CONTRACT TYPE a stored token came from, recovered from the free-text
// contract_tokens.direction column: `res:` = a *.resource.yaml, `inproc:` = a
// *.inproc.yaml, anything else ('c2s' / 's2c' / null) = an AsyncAPI wire token. Kind is
// DERIVED, not stored — there is no column for it and SCHEMA_VERSION stays 5.
//
// One reader, so the half-dozen places that need to speak the right vocabulary (writer vs
// provider, readers vs consumers) cannot drift into disagreeing about what a token is.
const tokenKind = (meta) => (decodeResourceDirection(meta?.direction) ? 'resource'
  : decodeInprocDirection(meta?.direction) ? 'inproc' : 'wire');

const isTest = (f) => f.includes('tests/') || f.includes('/test/') || f.includes('.test.') || f.includes('_test.') || f.includes('/test_');
const loc = (n) => `${n.compartment}:${n.file}:${n.startLine} ${n.name}${n.kind && n.kind !== 'function' ? ` (${n.kind})` : ''}`;
// contract_tokens.producers/consumers is a comma-joined CSV on disk and an array once
// definedContractTokens has split it. Accept both shapes so a caller handing over a
// raw row is never read one character at a time — and ANY iterable besides, because
// classifyContractToken is exported and its predecessor did `new Set(meta.producers)`,
// which accepted a Set, a generator, anything. Narrowing that to "Array or string" would
// have silently answered `hasRoles === false` for an outside caller passing a Set.
// (The string test comes first: a string is itself iterable, one character at a time.)
const roleNames = (v) => {
  if (typeof v === 'string') return v ? v.split(',') : [];
  if (Array.isArray(v)) return v;
  if (v && typeof v[Symbol.iterator] === 'function') return [...v];
  return [];
};

// includeModules: allow the synthetic per-file `<module>` symbol (name '<module>',
// kind 'module') to be returned. OFF by default — find_symbol / get_source /
// trace_callers / trace_callees all want real definitions, and a bare `<module>`
// lookup there would answer with one row per FILE. path_between turns it ON: a
// top-level (module-scope) read or write of a contract token is attributed by
// matchContracts to `<module>` (extract/contracts.js), so with the filter in place
// that reference could be TRAVERSED as an intermediate hop but never named as a BFS
// seed or goal — i.e. a resource written or read at file scope had no symbol to ask
// about. Narrow the noise with fromCompartment/toCompartment.
function symbolMatches(db, project, name, compartment, file, { includeModules = false } = {}) {
  let q = `SELECT id,compartment,file,name,kind,startLine,endLine FROM symbols
           WHERE project=@project AND name=@name`;
  if (!includeModules) q += " AND kind <> 'module'";
  if (compartment) q += ' AND compartment=@compartment';
  if (file) q += ' AND instr(file,@file)>0';
  return db.prepare(q + ' ORDER BY compartment,file,startLine').all({ project, name, compartment, file });
}

// Absolute path -> {mtime, size} for every indexed file in the project. The abs
// path is reconstructed from the file's compartment root, matching what
// changedSince and build.js produce, so the keys line up for staleness comparison.
export function indexedFiles(db, project) {
  const rows = db.prepare(
    `SELECT f.path AS path, f.mtime AS mtime, f.size AS size, c.root AS root
       FROM files f JOIN compartments c ON c.project = f.project AND c.name = f.compartment
      WHERE f.project = ?`,
  ).all(project);
  const m = new Map();
  for (const r of rows) m.set(join(r.root, r.path), { mtime: r.mtime, size: r.size });
  return m;
}

// Of the given candidate absolute paths, which actually differ from what's indexed
// — changed on disk (mtime/size mismatch), newly added (not indexed), or deleted
// (gone from disk)? This is independent of git commit state, so a file that was
// edited, re-indexed, but not yet committed is correctly reported as FRESH (its
// recorded mtime matches disk) instead of stale forever. mtime is compared with a
// 1ms tolerance to absorb float/filesystem rounding.
export function staleAmong(db, project, candidates) {
  if (!candidates || !candidates.length) return [];
  const indexed = indexedFiles(db, project);
  const stale = [];
  for (const abs of candidates) {
    let st;
    try { st = statSync(abs); } catch { stale.push(abs); continue; } // deleted/unreadable → re-index prunes it
    const rec = indexed.get(abs);
    if (!rec) { stale.push(abs); continue; } // present on disk but never indexed → new file
    if (rec.size !== st.size || Math.abs((rec.mtime ?? 0) - st.mtimeMs) > 1) stale.push(abs);
  }
  return stale;
}

export function graphStats(db, project) {
  const c = (t) => db.prepare(`SELECT count(*) n FROM ${t} WHERE project=?`).get(project).n;
  const nodes = { Compartment: c('compartments'), File: c('files'), Symbol: c('symbols'), Contract: c('contracts') };
  const edges = db.prepare('SELECT type, count(*) n FROM edges WHERE project=? GROUP BY type ORDER BY n DESC').all(project);
  // Compartment symbol counts joined to their root dir, so each compartment can be
  // attributed to the member root that owns it (own root vs a linked member).
  const compartments = db.prepare(
    `SELECT s.compartment compartment, count(*) n, ct.root root
       FROM symbols s LEFT JOIN compartments ct ON ct.project=s.project AND ct.name=s.compartment
      WHERE s.project=? AND s.kind<>'module' GROUP BY s.compartment ORDER BY n DESC`).all(project);
  if (!nodes.Symbol) return `No wiregraph for this project (${project}).`;

  const state = readState(project) || {};
  const head = [
    `Project: ${project}`,
    'Nodes: ' + Object.entries(nodes).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(', '),
    'Edges: ' + edges.map((r) => `${r.type}=${r.n}`).join(', '),
    // Which organization method this project is on. Deliberately AFTER the three count
    // lines: graph_status builds its own block from `graphStats(...).split('\n').slice(0,3)`
    // (Project/Nodes/Edges) and appends the FULL modeLine itself, so this compact label must
    // stay out of those first three lines or it would knock Edges out of that slice.
    `Mode: ${modeSummary(state)}`,
  ];

  // Linked members: read this graph's own config. When there are none the output
  // stays the flat single-graph shape (the pre-link output, plus the Mode line above).
  const mem = members(state);
  if (!mem.length) {
    return [...head, 'Symbols per compartment:', ...compartments.map((r) => `  ${r.compartment}: ${r.n}`)].join('\n');
  }

  // Group each compartment under the member root (longest-prefix on its root dir)
  // that owns it, so the local/foreign boundary is UNMISSABLE: get_source on a
  // "Linked" compartment reads an external repo's file, not this project's tree.
  const roots = memberRoots(project); // [own, ...members]
  const ownerRootFor = (compRoot) => {
    let best = null; // longest member root that is a prefix of compRoot (own root falls out here too)
    for (const m of roots) if (compRoot === m || (compRoot && compRoot.startsWith(m + sep))) { if (!best || m.length > best.length) best = m; }
    return best || project;
  };
  const byRoot = new Map();
  for (const r of compartments) {
    const g = ownerRootFor(r.root);
    if (!byRoot.has(g)) byRoot.set(g, []);
    byRoot.get(g).push(r);
  }
  const section = (root) => (byRoot.get(root) || []).map((r) => `  ${r.compartment}: ${r.n}`);

  const out = [...head, '', `Members: ${mem.length} linked (${mem.map((l) => l.root).join(', ')})`, '', `Own root: ${project}`, ...section(project)];
  for (const l of mem) {
    out.push('', `Linked: ${l.root}`, ...section(l.root));
  }
  return out.join('\n');
}

// --- DISAMBIGUATED COMPARTMENT NAMES ARE NOT A BUILD-LOG DETAIL ----------------
// When the INFERRED partition puts two boundary dirs under the same basename, the walk
// (src/extract/walk.js#disambiguateInferredNames) renames the colliding ones to their
// project-relative path — `network` becomes `client/network` + `server/network` — and says
// so on the build's stderr. On the hook path that stream goes to a log nobody reads, and
// nothing downstream ever mentioned it: `graph_status` said `Mode: global — compartments
// inferred…` with no hint that the name a user would type does not exist, and
// `find_symbol {"compartment":"network"}` dead-ended with `No symbol named "x" in network.`
//
// The graph itself is the authoritative record of what happened: `/` and `#` are RESERVED
// for machine-minted names. disambiguateInferredNames is the only thing that mints them,
// validateDeclaration refuses them in a declared name for that reason (NOT because ids join
// on them — ids join on `:`, and partitionValue JSON-encodes every component before hashing,
// so `/` forges nothing), and the walk's basename never contains one. So a compartment name
// carrying one of those IS a disambiguated name, in either mode, with no extra state to keep
// in sync and nothing to go stale.
//
// The two characters are imported from the module that mints them rather than spelled again
// here, so the minted set and the set this heuristic recognizes cannot drift apart.
// Group them by the bare name they collided on.
export function disambiguatedCompartments(db, project) {
  let rows;
  try { rows = db.prepare('SELECT DISTINCT name FROM compartments WHERE project=? ORDER BY name').all(project); }
  catch { return []; }
  const byBare = new Map();
  for (const r of rows) {
    const n = r?.name;
    if (typeof n !== 'string' || !(n.includes(INFERRED_PATH_SEP) || n.includes(INFERRED_UNIQ_SEP))) continue;
    // `client/network` -> `network`; `network#2` -> `network`.
    const bare = n.split(INFERRED_PATH_SEP).pop().split(INFERRED_UNIQ_SEP)[0];
    if (!bare) continue;
    if (!byBare.has(bare)) byBare.set(bare, []);
    byBare.get(bare).push(n);
  }
  return [...byBare].map(([bare, names]) => ({ bare, names: names.sort() }))
    .sort((a, b) => (a.bare < b.bare ? -1 : a.bare > b.bare ? 1 : 0));
}

// The graph_status lines for the above. Silent when nothing was renamed, so an ordinary
// project's report is byte-identical.
export function disambiguatedCompartmentLines(db, project) {
  const groups = disambiguatedCompartments(db, project);
  if (!groups.length) return [];
  const lines = [
    `⚠ RENAMED COMPARTMENTS: ${groups.length} compartment name(s) collided in the inferred partition and were `
    + 'disambiguated — the BARE name is NOT in the graph, so query the exact names below (and any contract spec '
    + 'naming the bare one in x-wiregraph-producers/-consumers or writers:/readers: no longer matches):',
  ];
  for (const g of groups.slice(0, 10)) lines.push(`  - "${g.bare}" → ${g.names.join(', ')}`);
  if (groups.length > 10) lines.push(`  - …and ${groups.length - 10} more`);
  return lines;
}

// Appended to a "no symbol / no match" answer when the compartment the caller ASKED for is
// one of the bare names that no longer exists. Without it the dead end is indistinguishable
// from "that symbol really isn't there".
function compartmentNameHint(db, project, compartment) {
  if (!compartment) return '';
  try {
    const exists = db.prepare('SELECT 1 x FROM compartments WHERE project=? AND name=?').get(project, compartment);
    if (exists) return '';
    const hit = disambiguatedCompartments(db, project).find((g) => g.bare === compartment);
    if (!hit) return '';
    return ` (NOTE: there is no compartment "${compartment}" in this graph — that name collided in the inferred`
      + ` partition and was renamed to ${hit.names.join(' and ')}. Retry with one of those.)`;
  } catch { return ''; }
}

export function findSymbol(db, project, name, repo) {
  const all = symbolMatches(db, project, name, repo);
  if (!all.length) return `No symbol named "${name}"${repo ? ` in ${repo}` : ''}.${compartmentNameHint(db, project, repo)}`;
  const CAP = 100;
  const rows = all.slice(0, CAP);
  const header = all.length > CAP
    ? `${all.length} match(es) for "${name}" (showing first ${CAP}; narrow with compartment/file):`
    : `${rows.length} match(es) for "${name}":`;
  return header + '\n' + rows.map((r) => '  ' + loc(r)).join('\n');
}

export function getSource(db, project, name, repo, file, context = 0) {
  const rows = symbolMatches(db, project, name, repo, file).filter((r) => r.endLine >= r.startLine && r.startLine > 0);
  if (!rows.length) return `No symbol named "${name}"${repo ? ` in ${repo}` : ''} with a known line span.${compartmentNameHint(db, project, repo)}`;
  if (rows.length > 1 && !file && !repo) {
    return `"${name}" is ambiguous (${rows.length}). Narrow with compartment/file:\n` +
      rows.map((r) => `  ${r.compartment}:${r.file}:${r.startLine} ${r.name}`).join('\n');
  }
  const r = rows[0];
  const root = db.prepare('SELECT root FROM compartments WHERE project=? AND name=?').get(project, r.compartment)?.root;
  let lines;
  try { lines = readFileSync(join(root, r.file), 'utf8').split('\n'); }
  catch (e) { return `Could not read ${r.file}: ${e.message}`; }
  const ctx = Math.max(0, Math.min(20, Math.floor(Number(context) || 0)));
  const from = Math.max(1, r.startLine - ctx);
  const MAX = 400;
  let to = Math.min(lines.length, r.endLine + ctx), truncated = false;
  if (to - from + 1 > MAX) { to = from + MAX - 1; truncated = true; }
  const body = lines.slice(from - 1, to).map((ln, i) => `${from + i}\t${ln}`).join('\n');
  const header = `${r.compartment}:${r.file}:${r.startLine}-${r.endLine} ${r.name}${r.kind && r.kind !== 'function' ? ` (${r.kind})` : ''}`;
  return header + '\n' + body + (truncated ? `\n… (truncated at ${MAX} lines)` : '');
}

// Shared CALLS adjacency + symbol metadata for a project.
// NOTE (deferred perf): this rebuilds the full CALLS adjacency on every trace_*
// call (O(edges) — a few ms at a few-thousand-node scale). Negligible here; if wiregraph ever
// targets much larger graphs, memoize this per (db, project) for the process.
function callGraph(db, project) {
  const meta = new Map();
  for (const s of db.prepare('SELECT id,compartment,file,name,kind,startLine FROM symbols WHERE project=?').all(project)) meta.set(s.id, s);
  const fwd = new Map(); // src -> [{dst,count,resolution}]
  const rev = new Map(); // dst -> [{src,...}]
  for (const e of db.prepare("SELECT src,dst,cnt,resolution FROM edges WHERE project=? AND type='CALLS'").all(project)) {
    (fwd.get(e.src) || fwd.set(e.src, []).get(e.src)).push({ dst: e.dst, count: e.cnt, resolution: e.resolution });
    (rev.get(e.dst) || rev.set(e.dst, []).get(e.dst)).push({ dst: e.src, count: e.cnt, resolution: e.resolution });
  }
  return { meta, fwd, rev };
}

function trace(db, project, name, repo, file, depth, direction, includeTests) {
  const d = Math.max(1, Math.min(8, Math.floor(Number(depth) || 3)));
  const seeds = symbolMatches(db, project, name, repo, file);
  if (!seeds.length) return { seeds: [], text: null };
  if (seeds.length > 1 && !repo && !file) {
    return { seeds, text: `"${name}" is ambiguous (${seeds.length} defs). Narrow with compartment/file:\n` + seeds.map((s) => '  ' + loc(s)).join('\n') };
  }
  const { meta, fwd, rev } = callGraph(db, project);
  const adj = direction === 'callers' ? rev : fwd;

  // reachable set within d hops, and the parent->children adjacency among them
  const seed = seeds[0];
  const childrenOf = new Map();
  const seen = new Set([seed.id]);
  let frontier = [seed.id];
  // Match Neo4j semantics `(seed)-[:CALLS*0..d]->(a)-[e:CALLS]->(b)`: the seed's
  // subgraph includes nodes up to d hops away (the `a`s) PLUS their direct
  // children (`b`, at depth d+1). So expand depth 0..d inclusive.
  for (let hop = 0; hop <= d; hop++) {
    const next = [];
    for (const id of frontier) {
      for (const k of (adj.get(id) || [])) {
        const m = meta.get(k.dst);
        if (!m) continue;
        if (!includeTests && isTest(m.file)) continue;
        if (!childrenOf.has(id)) childrenOf.set(id, []);
        childrenOf.get(id).push({ id: k.dst, count: k.count, resolution: k.resolution });
        if (!seen.has(k.dst)) { seen.add(k.dst); next.push(k.dst); }
      }
    }
    frontier = next;
  }

  const out = [];
  const shown = new Set([seed.id]);
  const arrow = direction === 'callers' ? '◄ ' : '→ ';
  // Count EVERY ambiguous edge encountered (even ones whose subtree is collapsed as
  // "already shown"), so the trace-level caveat below reflects the true uncertainty
  // — the per-line "~ambiguous" marker is dropped on a second visit, and the model
  // is told to trust results, so uncertainty must also travel as a header.
  let ambCount = 0;
  function walk(id, prefix, depthN) {
    const kids = (childrenOf.get(id) || []).slice().sort((x, y) => (y.count || 0) - (x.count || 0));
    for (const k of kids) {
      const m = meta.get(k.id) || {};
      const isAmb = k.resolution === 'ambiguous';
      if (isAmb) ambCount++;
      out.push(`${prefix}${arrow}${m.file}:${m.startLine} ${m.name}${isAmb ? ' ~ambiguous' : ''}`);
      if (!shown.has(k.id) && depthN < 12) { shown.add(k.id); walk(k.id, prefix + '   ', depthN + 1); }
      else if (childrenOf.has(k.id)) out.push(`${prefix}   … (already shown)`);
    }
  }
  const head = `${seed.compartment}:${seed.file}:${seed.startLine} ${seed.name}`;
  walk(seed.id, '', 0);
  const note = includeTests ? '' : '\n(test files excluded; includeTests=true to show)';
  // Data-triggered caveat: only when the tree actually holds ambiguous edges, so a
  // clean trace pays nothing. Calls resolve by NAME, so a collision fans one call to
  // several same-named symbols — those branches are possibilities, not facts.
  const ambNote = ambCount
    ? `\n⚠ ${ambCount} branch(es) marked ~ambiguous: the call resolves by name and collided with several same-named symbols — treat those as one-of-several, not certainty. (Also blind to callback/function-pointer and string-literal dispatch.)`
    : '';
  if (!out.length) return { seeds, text: `${loc(seed)}\n  (${direction === 'callers' ? 'no resolvable callers' : 'calls nothing resolvable'} within its compartment)` };
  return { seeds, text: head + '\n' + out.join('\n') + note + ambNote };
}

export function traceCallers(db, project, name, repo, file, depth, includeTests) {
  return trace(db, project, name, repo, file, depth, 'callers', includeTests).text || `No symbol named "${name}".`;
}
export function traceCallees(db, project, name, repo, file, depth, includeTests) {
  return trace(db, project, name, repo, file, depth, 'callees', includeTests).text || `No symbol named "${name}".`;
}

// Load the FULL token set each matching contract defines (schema v4). Returns a
// Map(contractName -> Map(token -> {direction, producers[], consumers[]})). On a
// pre-v4 db (no contract_tokens table) returns null so the caller falls back to a
// references-only report rather than crashing.
function definedContractTokens(db, project, contract, token) {
  let rows;
  try {
    let q = `SELECT c.name name, ct.token token, ct.direction direction, ct.producers producers, ct.consumers consumers
             FROM contract_tokens ct JOIN contracts c ON c.id=ct.contract
             WHERE ct.project=@project AND lower(c.name) LIKE '%'||lower(@contract)||'%'`;
    if (token) q += ' AND ct.token=@token';
    rows = db.prepare(q).all({ project, contract, token });
  } catch {
    return null; // contract_tokens table absent (old schema)
  }
  const byContract = new Map();
  for (const r of rows) {
    if (!byContract.has(r.name)) byContract.set(r.name, new Map());
    byContract.get(r.name).set(r.token, {
      direction: r.direction || null,
      producers: r.producers ? r.producers.split(',') : [],
      consumers: r.consumers ? r.consumers.split(',') : [],
    });
  }
  return byContract;
}

// Classify a contract token's drift the way buildWireEdges (src/extract/contracts.js)
// orients a WIRE. A cross-compartment wire needs BOTH a producer AND a consumer, in
// DIFFERENT compartments — so a token referenced only by same-role compartments (e.g.
// two clients, the server unindexed) is a GAP, not a satisfied seam, even though 2+
// compartments touch it. The old count heuristic (n>=2 => satisfied) called that
// healthy while buildWireEdges produced zero wire. This mirrors buildWireEdges' role
// filter (pubs/cons) and its intra-compartment skip.
// RESOURCE contracts ride the same classifier unchanged, and it is already
// semantically right for them: producers = writers, consumers = readers, so
// "satisfied" reads as "a writer and a reader, in different compartments" — exactly
// the resource seam.
//
// The single-writer check is deliberately NOT a fourth value here. It answers a
// different question — "is the DECLARATION self-consistent?" — from the one this
// function answers, "does the CODE match the declaration?", and a token can fail both
// at once. Folding it in as a fourth mutually-exclusive verdict (and checking it first)
// meant a resource whose constant NO code references anywhere reported
// `unreferenced: 0` and never showed the DRIFT flag: the tool's strongest signal
// replaced by a declaration-hygiene complaint. Checking it LAST would be just as wrong
// in the other direction — the violation would vanish on any drifted resource. So it is
// an orthogonal flag, `singleWriterViolation`, and callers report both — along with
// `undeclaredParticipants`, a third orthogonal fact about the same token.
//
//   refComps: Set/array of compartment names that reference the token
//   meta: { direction?, producers:[], consumers:[] } (compartment names; may be empty/absent)
// Returns 'unreferenced' | 'one-sided' | 'satisfied'.
export function classifyContractToken(refComps, meta) {
  const refSet = refComps instanceof Set ? refComps : new Set(refComps || []);
  // producers/consumers are arrays here but live in the db as a comma-joined CSV;
  // accept either (and any other iterable) so a caller that hands over a raw
  // contract_tokens row can't be silently misread one character at a time.
  const roleList = roleNames(meta?.producers);
  const consumerList = roleNames(meta?.consumers);
  if (refSet.size === 0) return 'unreferenced';
  const hasRoles = (roleList.length || consumerList.length);
  if (hasRoles) {
    const producers = new Set(roleList);
    const consumers = new Set(consumerList);
    const refP = [...refSet].filter((c) => producers.has(c));
    const refC = [...refSet].filter((c) => consumers.has(c));
    // Both role sides referenced AND at least two DISTINCT compartments — so a
    // cross-compartment producer->consumer pair exists. buildWireEdges skips
    // intra-compartment pairs, so a lone dual-role compartment is NOT a wire.
    if (refP.length && refC.length && new Set([...refP, ...refC]).size >= 2) return 'satisfied';
    return 'one-sided';
  }
  // Role-less token: a hand-written spec oriented at build via WIREGRAPH_SERVER_REPO,
  // whose server compartment is NOT stored in the db — orientation can't be
  // reconstructed here, so fall back to the count heuristic (preserves prior
  // best-effort behavior for this case).
  return refSet.size === 1 ? 'one-sided' : 'satisfied';
}

// ORTHOGONAL to classifyContractToken (see there): does this token's DECLARATION break
// its own single-writer discipline? True only for a resource token that declares
// `single_writer: true` and then names two or more writers. Independent of what any code
// references, so it is reported ALONGSIDE the drift verdict, never instead of it.
export function singleWriterViolation(meta) {
  const res = decodeResourceDirection(meta?.direction);
  return !!(res?.singleWriter && roleNames(meta?.producers).length >= 2);
}

// UNDECLARED PARTICIPANTS — a compartment whose code REFERENCES the resource constant
// while the spec names it as neither a writer nor a reader.
//
// This replaces an "observed single-writer breach" check that could not see the case that
// mattered. That check intersected the referencing compartments with the DECLARED writer
// list, so observed was a SUBSET of declared BY CONSTRUCTION: it could only ever restate
// a self-contradictory declaration, and the one thing a user actually needs — a second
// compartment touching the resource WITHOUT being declared a writer — was invisible to
// it, because that compartment is not in the list being intersected.
//
// THE LIMITATION, STATED PLAINLY RATHER THAN IMPLIED AWAY: wiregraph does not detect
// WRITES. A REFERENCES edge means "this symbol mentions the constant", not "this symbol
// writes through it" — there is no per-language table of fs/DB write APIs, by design
// (the shared token is the signal; direction is the reviewer's call). So `single_writer`
// is checkable only against the DECLARATION (singleWriterViolation above), and no amount
// of graph data promotes it to an observation. What IS observable, exactly and without
// guessing, is that a compartment touches the resource and the spec does not mention it
// — the concrete thing to go and look at, and a strict superset of "an undeclared
// writer".
// IT GENERALISES TO INPROC UNCHANGED, and the gate is the only thing that had to move.
// The BODY is type-agnostic — "the spec names these compartments; code in this one touches
// the token; it is in neither list" — and the reason the gate existed at all was to keep
// WIRE tokens out, where `x-wiregraph-producers/consumers` are optional and partial by
// design and a third compartment calling a route is ordinary. An inproc contract is exactly
// like a resource one in the respect that matters: the roles are a COMPLETE statement of
// who is allowed to be on the seam. For inproc it is more than a completeness check —
// buildInprocEdges uses those same role sets as the false-positive bound on a short symbol
// name, so an undeclared participant is precisely the report that says "something outside
// the declared seam spells this name; the id may be too common, or the spec too narrow".
export function undeclaredParticipants(refComps, meta) {
  if (tokenKind(meta) === 'wire') return [];   // resource + inproc tokens only
  const declared = new Set([...roleNames(meta?.producers), ...roleNames(meta?.consumers)]);
  if (!declared.size) return [];
  const refSet = refComps instanceof Set ? refComps : new Set(refComps || []);
  return [...refSet].filter((c) => !declared.has(c)).sort();
}

// A token whose persisted `direction` did not decode cleanly — corrupt db, or a value
// written by a version that encoded a field this one does not know. Returned as a list of
// human-readable reasons (empty when fine) so trace_contract can SAY so: a mis-decoded
// single_writer used to turn a declared TRUE into an effective FALSE and take the violation
// report down with it, with no signal anywhere.
//
// IT READS WHICHEVER PREFIX THE VALUE CARRIES. It used to consult only the `res:` decoder,
// which left `decodeInprocDirection` — which goes to the trouble of RECORDING every unknown
// field and malformed percent-escape it meets, on the stated rationale that "only wiregraph
// writes this column, so a value that does not decode means the row is corrupt, and
// silently substituting a default would turn a corrupt row into a confident wrong answer
// with nothing anywhere to say why" (extract/inproc-spec.js) — with NO READER AT ALL. The
// errors were collected and dropped on the floor, so a corrupt inproc row produced exactly
// the confident wrong answer that comment refuses: kind and boundary silently null, no
// 🛑 UNREADABLE, nothing anywhere to say why. The decoder's own unit test asserted that the
// decoder returns the errors, and passed, because the decoder does.
//
// `||` and not a kind lookup: the two prefixes cannot both match one value (each decoder is
// anchored on its own prefix and returns null otherwise), so this is a first-hit dispatch,
// and a value that is neither yields no errors — which is right, because a WIRE direction
// ('c2s' / 's2c' / NULL) has no encoding to be corrupt.
export function contractMetaErrors(meta) {
  const d = meta?.direction;
  return (decodeResourceDirection(d) || decodeInprocDirection(d))?.errors || [];
}

// Human-readable detail for a one-sided token in trace_contract. When role metadata
// exists, name which side is present and which half is missing (so a 2-same-role case
// reads as "producer side present, consumer half missing" rather than the old,
// misleading "only [comp]"); for a role-less token just name the compartment(s).
// A resource token speaks writer/reader, not producer/consumer — the wording follows
// the contract type so a report never tells a user their shared file has a "consumer
// half missing".
function oneSidedDetail(refComps, meta) {
  const comps = [...(refComps instanceof Set ? refComps : new Set(refComps || []))];
  const hasRoles = (roleNames(meta?.producers).length || roleNames(meta?.consumers).length);
  if (!hasRoles) return `only [${comps.join(', ')}]`;
  const kind = tokenKind(meta);
  const res = kind === 'resource';
  // An inproc token's roles are provider/consumer. It shares the WIRE spelling of the
  // consumer side and has its own for the producer side, which is why this is a lookup and
  // not a boolean: telling a user their crate seam has a "writer half missing" would be
  // exactly as wrong as telling them their shared file has a "consumer half missing".
  const P = res ? 'writer' : kind === 'inproc' ? 'provider' : 'producer';
  const C = res ? 'reader' : 'consumer';
  const producers = new Set(roleNames(meta.producers));
  const consumers = new Set(roleNames(meta.consumers));
  const refP = comps.filter((c) => producers.has(c));
  const refC = comps.filter((c) => consumers.has(c));
  if (refP.length && refC.length) return `only [${comps.join(', ')}] (same compartment ${res ? 'writes & reads' : kind === 'inproc' ? 'provides & consumes' : 'produces & consumes'} — no cross-compartment seam)`;
  if (refP.length) return `only ${P} side [${refP.join(', ')}] — ${C} half missing`;
  if (refC.length) return `only ${C} side [${refC.join(', ')}] — ${P} half missing`;
  return `only [${comps.join(', ')}] (no compartment matches the contract's ${P}/${C} roles)`;
}

// --- SHADOWED, NOT MISSING ----------------------------------------------------
// The single most misleading thing trace_contract could say. In recursive mode an inner
// `server/contracts/` and an outer `contracts/` may both declare the same route; the
// longest-prefix rule (src/extract/contracts.js) gives code under `server/` to the INNER
// contract, so the OUTER one legitimately sees only the halves outside that subtree and
// reports the route as one-sided. Observed on the nested fixture's deliberately shared
// route: `/api/state — only producer side [netcli] — consumer half missing`, while netsrv
// implements it, is fully indexed, and is listed three lines BELOW in the same report under
// `Server Inner Wire`. A user or an agent reading that goes looking for a handler that was
// never missing.
//
// So: when a token is one-sided on contract C and the SAME token is declared by ANOTHER
// contract that is referenced by compartments C does not see, say so BY NAME.
//
// TWO TESTS, BOTH REQUIRED — and the second is why this note is not a lie half the time.
// The OBSERVATIONAL test (which other contract actually holds the half C is missing) is
// true of a NARROWER contract and EQUALLY true of a DISJOINT SIBLING one. Observed:
// `Client Inner Wire` (scope `client/`) and `Server Inner Wire` (scope `server/`) both
// declare `/shared/thing`, the declared consumer genuinely does not exist anywhere in the
// tree, and the report asserted IN CAPITALS that a real missing implementation was not one.
// An agent reading that stops looking — strictly worse than the plain one-sided verdict.
//
// So it is ALSO gated STRUCTURALLY: the other contract's governing subtree must be a STRICT
// DESCENDANT of mine. That is recoverable with no scope column — `contracts.file` holds the
// spec's project-relative path (src/extract/contracts.js#contractFileLabel) and a contracts
// dir governs its PARENT, so `dirname(dirname(file))` is the scope root:
// `server/contracts/inner.asyncapi.yaml` -> `server`, `contracts/outer.asyncapi.yaml` ->
// `.`. Siblings (`client` vs `server`) are neither's descendant, so no note. Scope itself
// stays unpersisted and SCHEMA_VERSION stays 5: this reads a column that already exists.
//
// Global mode still cannot trip it, now for TWO independent reasons: every contract is
// unscoped, so no other contract ever holds a half this one lacks (observational), and every
// spec sits in the same depth-1 dir, so no scope root is a strict descendant of another
// (structural). A db written before `file` became a path holds basenames, whose recovered
// root is `.` for every contract — no strict descendants, so the note degrades to silence.
//
// KNOWN, DELIBERATE MISS: when the narrower contract's copy of the token has NO references
// yet, `theirs` is empty and no note is printed. Left alone on purpose — with nothing
// referencing it, naming that contract would say "the other half is implemented over there"
// while nothing implements it anywhere, which is the same false reassurance in the other
// direction. The plain one-sided verdict is the correct output in that case.
//
// Returns { declaredBy, refs, scopeOf }, built with two project-wide queries and ONLY when
// the report actually has a one-sided token.
function shadowIndex(db, project, includeTests) {
  const declaredBy = new Map(); // token -> Set(contract name)
  const refs = new Map();       // `${contract}\0${token}` -> Set(compartment)
  const scopeOf = new Map();    // contract name -> governing subtree, as path segments
  try {
    for (const r of db.prepare(
      'SELECT c.name cname, c.file cfile, ct.token tok FROM contract_tokens ct JOIN contracts c ON c.id=ct.contract WHERE ct.project=?',
    ).all(project)) {
      if (!scopeOf.has(r.cname)) scopeOf.set(r.cname, scopeSegments(r.cfile));
      if (!r.tok) continue;
      if (!declaredBy.has(r.tok)) declaredBy.set(r.tok, new Set());
      declaredBy.get(r.tok).add(r.cname);
    }
    for (const r of db.prepare(
      'SELECT c.name cname, e.token tok, s.compartment comp, s.file file FROM edges e '
      + 'JOIN symbols s ON s.id=e.src JOIN contracts c ON c.id=e.dst '
      + "WHERE e.project=? AND e.type='REFERENCES'",
    ).all(project)) {
      if (!r.tok) continue;
      if (!includeTests && isTest(r.file)) continue;
      const k = `${r.cname}\0${r.tok}`;
      if (!refs.has(k)) refs.set(k, new Set());
      refs.get(k).add(r.comp);
    }
  } catch { return null; } // old schema / missing table — degrade to the plain report
  return { declaredBy, refs, scopeOf };
}

// The subtree a contract governs, as path segments, recovered from its spec's
// project-relative path: the spec sits IN a contracts dir, and a contracts dir governs its
// PARENT. `server/contracts/inner.asyncapi.yaml` -> ['server']; `contracts/outer.yaml` ->
// [] (the project root). A bare basename (a pre-path db) and an absolute path (a spec
// outside the project — a `--contracts` override, a linked member) both collapse to [], the
// root, which participates in no strict-descendant relationship in the direction that
// matters and therefore prints no note.
function scopeSegments(file) {
  if (!file || file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file)) return [];
  const segs = file.split('/').filter((s) => s && s !== '.');
  // `.wiregraph/inferred/` is ALWAYS unscoped (src/build.js#resolveContractsDirs) — it sits
  // outside every source subtree and its seams are union-wide by construction. Recovering
  // `.wiregraph` as its subtree would make it look narrower than a root-scoped contract and
  // let it print a note claiming it governs a half it merely also matched.
  if (segs[0] === '.wiregraph') return [];
  return segs.length > 2 ? segs.slice(0, -2) : [];
}

// Is `b` STRICTLY inside `a`? Equal subtrees are not (two specs in the same contracts dir
// govern the same code and neither takes anything from the other).
function strictlyInside(a, b) {
  return b.length > a.length && a.every((s, i) => s === b[i]);
}

// The other contracts that hold a half `cname` is missing for `tok`, named — but only the
// ones whose subtree is strictly inside `cname`'s, i.e. the ones that could actually have
// taken that half away from it.
function shadowedBy(idx, cname, tok, comps) {
  if (!idx) return [];
  const others = idx.declaredBy.get(tok);
  if (!others) return [];
  const mine = comps instanceof Set ? comps : new Set(comps || []);
  const myScope = idx.scopeOf.get(cname) || [];
  const out = [];
  for (const other of others) {
    if (other === cname) continue;
    if (!strictlyInside(myScope, idx.scopeOf.get(other) || [])) continue;
    const theirs = idx.refs.get(`${other}\0${tok}`);
    if (!theirs) continue;
    const extra = [...theirs].filter((c) => !mine.has(c)).sort();
    if (extra.length) out.push({ contract: other, compartments: extra });
  }
  return out.sort((a, b) => (a.contract < b.contract ? -1 : a.contract > b.contract ? 1 : 0));
}

function shadowNote(shadows) {
  if (!shadows.length) return '';
  const parts = shadows.map((s) => `"${s.contract}" (referenced there by [${s.compartments.join(', ')}])`);
  return ` — NOT A MISSING IMPLEMENTATION: the same token is also declared by ${parts.join(' and ')}, which is where that half is governed. A narrower contract takes the code inside its subtree, so this contract legitimately sees only the halves outside it.`;
}

// …and the same fact for a token with NO references left at all — the FULLY shadowed case,
// which is where the note was needed most and was not applied.
//
// THE ONE-SIDED BRANCH WAS ONLY HALF THE PROBLEM. When a narrower contract takes ONE half of
// a token the outer contract is `one-sided` and got the note above. When it takes BOTH halves
// the outer contract's token lands in `unreferenced` — and unreferenced is rendered as
// `🔴 unreferenced … NO code references it (code has drifted off the contract…)` and raises
// `🔴 DRIFT`, the tool's strongest signal. Observed on the canonical recursive layout, the
// exact layout the mode exists to serve: `grep` finds the token in six places, the db holds
// six REFERENCES rows for it, and every one is attributed to the INNER contract, so the outer
// one sees zero and reports drift that does not exist.
//
// SO THE VERDICT CHANGES, not just the wording. A fully shadowed token is not drift by any
// reading of the word: the contract is satisfied, by the narrower contract that governs that
// subtree, and there is nothing for anyone to go and fix. Counting it as `unreferenced` would
// keep firing DRIFT on a healthy nested graph, which is how a strong signal becomes one
// people learn to ignore. It is NOT folded into `satisfied` either — nothing under THIS
// contract's remaining reach exercises it, and a reader deciding whether the outer spec still
// earns the declaration needs to see that. So it is its own bucket, its own line, and no flag.
//
// The gate is exactly the one the one-sided note already uses — `shadowedBy`, whose
// strict-descendant scope-root test (recovered from `contracts.file`) is what keeps a
// DISJOINT SIBLING scope from earning the same reassurance (traceShadowedSiblingTest). With
// an empty `comps` every compartment referencing the token under the narrower contract is
// "extra", so the observational half is satisfied by construction and the structural half is
// doing all the work — which is the right division of labour for this case.
function shadowedVerdictNote(shadows) {
  const parts = shadows.map((s) => `"${s.contract}" (referenced there by [${s.compartments.join(', ')}])`);
  return `NOT DRIFT: no code references this token under THIS contract because a NARROWER contract inside its subtree governs every reference — ${parts.join(' and ')}. The seam is intact there; this contract legitimately sees nothing.`;
}

// Detail line for a declared single_writer resource that lists several writers.
function violationDetail(meta) {
  const res = decodeResourceDirection(meta?.direction);
  const writers = roleNames(meta?.producers);
  return `declared single_writer (${res?.semantics || 'resource'}, kind ${res?.kind || '?'}) but ${writers.length} writers are declared: [${writers.join(', ')}] — two writers on a single-writer resource is a discipline violation, not a merge`;
}

// …and for an UNDECLARED PARTICIPANT: name the compartments whose code touches the
// resource while the spec does not mention them at all.
// The RESOURCE wording is unchanged, byte for byte. The inproc case is a genuinely
// different finding and gets its own sentence: for a resource the likely cause is an
// incomplete spec, while for an inproc id — a short symbol name by nature — the likely
// cause is the id matching an unrelated symbol that merely spells the same word, and
// telling a user to "add them to consumers:" would be advice to enshrine a false positive.
function undeclaredDetail(comps, kind = 'resource') {
  if (kind === 'inproc') {
    return `referenced by [${comps.join(', ')}], which the spec names as neither provider nor consumer — either the seam is wider than declared (add them to consumers:), or, more likely for a short id, an unrelated symbol in that compartment simply spells the same name. wiregraph matches the identifier, not the definition it resolves to, so check before widening the spec.`;
  }
  return `referenced by [${comps.join(', ')}], which the spec declares as neither writer nor reader — add them to writers:/readers:, or find out why they touch this resource. (wiregraph cannot tell a write from a read, so it cannot say which list they belong in.)`;
}

// --- LISTING THE CONTRACTS IS A FIRST-CLASS QUESTION ---------------------------
// "which contracts does this project even have?" had no answer. trace_contract needed a
// name substring (the schema marked it REQUIRED), and `{"contract":""}` only worked by
// accident — the empty string makes the `LIKE '%'||''||'%'` match everything, dumping the
// full drift report for every contract at once, undocumented and unusable as a directory.
//
// So an OMITTED or EMPTY `contract` is now the official listing: one line per contract with
// its kind and defined-token count, and nothing else. Kind is derived, not stored: a token
// whose `direction` decodes as a resource descriptor (src/extract/resource-spec.js) came
// from a `*.resource.yaml`, so a contract with any such token is a RESOURCE contract and one
// with none is a WIRE contract. A contract with no distinctive tokens at all is listed too,
// with `0 token(s)` — that is a real and easily-missed condition (it mints no REFERENCES and
// derives no seam), and omitting it would make the directory lie by silence.
function contractListing(db, project) {
  let rows;
  try {
    rows = db.prepare(
      'SELECT c.name name, c.file file, ct.token token, ct.direction direction '
      + 'FROM contracts c LEFT JOIN contract_tokens ct ON ct.contract=c.id AND ct.project=c.project '
      + 'WHERE c.project=? ORDER BY c.name').all(project);
  } catch { return null; } // pre-v4 db (no contract_tokens) — caller falls back
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, { file: r.file || null, tokens: new Set(), kind: 'wire' });
    const e = byName.get(r.name);
    if (r.token) e.tokens.add(r.token);
    // A contract whose tokens carry a res:/inproc: direction came from that format's spec.
    // First non-wire token decides; a contract's tokens all come from one spec, and a
    // wire contract has no such token at all, so the wire listing is unchanged.
    if (r.direction && e.kind === 'wire') {
      const k = tokenKind({ direction: r.direction });
      if (k !== 'wire') e.kind = k;
    }
  }
  if (!byName.size) return `No contracts in this project (${project}). Run /wiregraph-contracts to infer some, or add an AsyncAPI / *.resource.yaml / *.inproc.yaml spec under a contracts/ dir.`;
  const out = [`${byName.size} contract(s) in this project — call trace_contract again with a name substring for the full drift report:`];
  for (const [name, e] of [...byName].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    out.push(`  ${name} — ${e.kind} · ${e.tokens.size} token(s)${e.file ? ` · ${e.file}` : ''}`);
  }
  return out.join('\n');
}

export function traceContract(db, project, contract, token, includeTests) {
  // Omitted / empty / whitespace-only => the directory, not a 30-contract dump.
  if (contract === undefined || contract === null || String(contract).trim() === '') {
    const listing = contractListing(db, project);
    if (listing !== null) return listing;
    contract = ''; // pre-v4 db: fall through to the legacy match-everything behaviour
  }
  let q = `SELECT c.name contract, s.compartment compartment, s.file file, s.name name, s.startLine startLine, e.token token
           FROM edges e JOIN symbols s ON s.id=e.src JOIN contracts c ON c.id=e.dst
           WHERE e.project=@project AND e.type='REFERENCES' AND lower(c.name) LIKE '%'||lower(@contract)||'%'`;
  if (token) q += ' AND e.token=@token';
  const rows = db.prepare(q + ' ORDER BY c.name,s.compartment,s.file,s.startLine').all({ project, contract, token });
  const filtered = rows.filter((r) => includeTests || !isTest(r.file));

  const defined = definedContractTokens(db, project, contract, token);
  // A contract can exist in the graph, define tokens, and be referenced by NO
  // code — that is the drift we must not stay silent about. So key the "found
  // anything" check on the set of matching contracts, not on references.
  const contractNames = defined
    ? [...defined.keys()]
    : [...new Set(filtered.map((r) => r.contract))];
  if (!contractNames.length && !filtered.length) {
    return `No contract matches "${contract}"${token ? ` (token "${token}")` : ''}.`;
  }

  // aggregate referencing symbols + per-token referencing compartments
  const byKey = new Map();
  const refCompartments = new Map(); // contract -> Map(token -> Set(compartment))
  for (const r of filtered) {
    const k = `${r.contract}|${r.compartment}|${r.file}|${r.name}|${r.startLine}`;
    if (!byKey.has(k)) byKey.set(k, { ...r, tokens: [] });
    if (r.token && !byKey.get(k).tokens.includes(r.token)) byKey.get(k).tokens.push(r.token);
    if (r.token) {
      if (!refCompartments.has(r.contract)) refCompartments.set(r.contract, new Map());
      const m = refCompartments.get(r.contract);
      if (!m.has(r.token)) m.set(r.token, new Set());
      m.get(r.token).add(r.compartment);
    }
  }
  const byContract = new Map();
  for (const r of byKey.values()) {
    if (!byContract.has(r.contract)) byContract.set(r.contract, new Map());
    const compartments = byContract.get(r.contract);
    if (!compartments.has(r.compartment)) compartments.set(r.compartment, []);
    compartments.get(r.compartment).push(r);
  }

  const out = [];
  const allNames = new Set([...contractNames, ...byContract.keys()]);
  // Built ONCE, lazily: only a report that actually has a one-sided token pays for the two
  // project-wide queries shadowIndex runs.
  let shadowIdx;
  const shadows = (cname, tok, comps) => {
    if (shadowIdx === undefined) shadowIdx = shadowIndex(db, project, includeTests);
    return shadowedBy(shadowIdx, cname, tok, comps);
  };
  for (const cname of [...allNames].sort()) {
    // --- drift summary (only when we have the defined-token set) --------------
    const definedTokens = defined ? defined.get(cname) : null;
    const refMap = refCompartments.get(cname) || new Map();
    let driftLines = [];
    if (definedTokens && definedTokens.size) {
      const unreferenced = [], oneSided = [], violations = [], undeclared = [], unreadable = [], shadowed = [];
      let satisfied = 0;
      for (const [tok, meta] of definedTokens) {
        const comps = refMap.get(tok) || new Set();
        // Drift verdict and declaration violation are INDEPENDENT (see
        // classifyContractToken): a token can be unreferenced AND in violation, and the
        // report says both. It used to say only the second.
        const verdict = classifyContractToken(comps, meta);
        if (verdict === 'unreferenced') {
          // FULLY SHADOWED IS NOT DRIFT (see shadowedVerdictNote). Same gate as the
          // one-sided note, so a disjoint sibling scope still earns nothing.
          const sh = shadows(cname, tok, comps);
          if (sh.length) shadowed.push([tok, shadowedVerdictNote(sh)]);
          else unreferenced.push(tok);
        }
        else if (verdict === 'one-sided') oneSided.push([tok, oneSidedDetail(comps, meta) + shadowNote(shadows(cname, tok, comps))]);
        else satisfied++;
        if (singleWriterViolation(meta)) violations.push([tok, violationDetail(meta)]);
        // Orthogonal again: a token can be satisfied by its declared roles AND still be
        // touched by a compartment nobody declared.
        const extra = undeclaredParticipants(comps, meta);
        if (extra.length) undeclared.push([tok, undeclaredDetail(extra, tokenKind(meta))]);
        const errs = contractMetaErrors(meta);
        if (errs.length) unreadable.push([tok, errs.join('; ')]);
      }
      const total = definedTokens.size;
      // Violation/unreadable segments and flags are appended ONLY when non-empty, so a
      // contract with no resource tokens renders byte-identically to before. DRIFT and
      // VIOLATION can both appear — they are different findings about the same contract.
      const flag = (unreferenced.length ? ' 🔴 DRIFT' : '')
        + (violations.length ? ' 🛑 VIOLATION' : '')
        + (undeclared.length ? ' ⚠️ UNDECLARED' : '')
        + (unreadable.length ? ' 🛑 UNREADABLE' : '')
        + (!unreferenced.length && !violations.length && !unreadable.length && oneSided.length ? ' ⚠️' : '');
      const vSeg = violations.length ? ` · ${violations.length} single-writer violation${violations.length > 1 ? 's' : ''}` : '';
      const oSeg = undeclared.length ? ` · ${undeclared.length} with undeclared participant${undeclared.length > 1 ? 's' : ''}` : '';
      // Appended ONLY when non-empty, so every report without a fully-shadowed token
      // renders byte-identically to before.
      const sSeg = shadowed.length ? ` · ${shadowed.length} shadowed by a narrower contract` : '';
      out.push(`Contract: ${cname} — ${satisfied}/${total} tokens satisfied · ${oneSided.length} one-sided · ${unreferenced.length} unreferenced${sSeg}${vSeg}${oSeg}${flag}`);
      if (violations.length) {
        driftLines.push('  🛑 single-writer violation — the resource declares single_writer but more than one compartment is declared as a writer (concurrent writers on a last-writer-wins/presence resource lose updates):');
        for (const [t, detail] of violations.slice(0, 40)) driftLines.push(`       ${t} — ${detail}`);
        if (violations.length > 40) driftLines.push(`       … +${violations.length - 40} more`);
      }
      if (undeclared.length) {
        // The header follows the CONTRACT's kind, not each token's, because a contract's
        // tokens all come from one spec. `every` (not `some`) keeps the resource header —
        // and therefore every existing resource report — byte-identical.
        const allInproc = undeclared.every(([t]) => tokenKind(definedTokens.get(t)) === 'inproc');
        driftLines.push(allInproc
          ? '  ⚠️ undeclared participant — a compartment REFERENCES the declared symbol but the spec names it as neither provider nor consumer. For an in-process contract this is as likely to be a FALSE POSITIVE as an incomplete spec: the join key is a bare symbol name matched as \\bname\\b, so an unrelated same-named symbol in a third compartment lands here too. Look before you widen the spec:'
          : '  ⚠️ undeclared participant — a compartment REFERENCES the resource but the spec names it as neither writer nor reader (wiregraph detects references, NOT writes, so it cannot tell you which side it belongs on — but it can tell you the spec is incomplete):');
        for (const [t, detail] of undeclared.slice(0, 40)) driftLines.push(`       ${t} — ${detail}`);
        if (undeclared.length > 40) driftLines.push(`       … +${undeclared.length - 40} more`);
      }
      if (unreadable.length) {
        // Same `every`-not-`some` rule as the undeclared header above, and for the same
        // reason: a contract's tokens all come from ONE spec, so this picks the right
        // vocabulary while keeping every existing resource report byte-identical. An inproc
        // token's stored metadata is kind/boundary — it has no semantics and no
        // single_writer — so naming those fields at it would be a report about a column
        // that is not there.
        const allInproc = unreadable.every(([t]) => tokenKind(definedTokens.get(t)) === 'inproc');
        driftLines.push(allInproc
          ? '  🛑 unreadable symbol metadata — the stored kind/boundary did not decode, so what these tokens declare about the seam is UNKNOWN (rebuild the graph; if it persists the spec or the db is corrupt):'
          : '  🛑 unreadable resource metadata — the stored kind/semantics/single_writer did not decode, so the declared discipline for these tokens is UNKNOWN (rebuild the graph; if it persists the spec or the db is corrupt):');
        for (const [t, detail] of unreadable.slice(0, 40)) driftLines.push(`       ${t} — ${detail}`);
        if (unreadable.length > 40) driftLines.push(`       … +${unreadable.length - 40} more`);
      }
      if (unreferenced.length) {
        driftLines.push('  🔴 unreferenced — defined in the contract, NO code references it (code has drifted off the contract, or the compartment is not indexed):');
        for (const t of unreferenced.slice(0, 40)) driftLines.push(`       ${t}`);
        if (unreferenced.length > 40) driftLines.push(`       … +${unreferenced.length - 40} more`);
      }
      if (shadowed.length) {
        driftLines.push('  ⓘ shadowed — defined here, and EVERY reference to it is governed by a narrower contract inside this contract\'s subtree. This is NOT drift and there is nothing to fix; the seam is checked under that contract:');
        for (const [t, detail] of shadowed.slice(0, 40)) driftLines.push(`       ${t} — ${detail}`);
        if (shadowed.length > 40) driftLines.push(`       … +${shadowed.length - 40} more`);
      }
      if (oneSided.length) {
        driftLines.push('  ⚠️ one-sided — only one side of the seam references the token under THIS contract (a cross-compartment seam needs both; the other half is either missing, or governed by a narrower contract — which is named per token below when so):');
        for (const [t, detail] of oneSided.slice(0, 40)) driftLines.push(`       ${t} — ${detail}`);
        if (oneSided.length > 40) driftLines.push(`       … +${oneSided.length - 40} more`);
      }
    } else {
      out.push(`Contract: ${cname}`);
      if (defined && !filtered.length) driftLines.push('  (contract defines no distinctive wire tokens — nothing to drift-check)');
    }
    for (const l of driftLines) out.push(l);

    // --- who references it (the seam detail) ---------------------------------
    const compartments = byContract.get(cname);
    if (compartments && compartments.size) {
      out.push('  referenced by:');
      for (const [compartment, list] of compartments) {
        out.push(`    [${compartment}]`);
        for (const r of list) {
          const toks = r.tokens.slice(0, 10).join(', ') + (r.tokens.length > 10 ? `, +${r.tokens.length - 10} more` : '');
          out.push(`      ${r.file}:${r.startLine} ${r.name} — ${toks}`);
        }
      }
    }
  }
  if (!includeTests) out.push('(test files excluded; includeTests=true to show)');
  return out.join('\n');
}

// Per-contract drift summary across the whole project, for the visualizer to
// COLOR each contract-edge. Returns Map(contractName -> {total, satisfied,
// oneSided, unreferenced, status}) where status is 'ok' | 'one-sided' | 'drift'
// (drift = at least one token no code references; one-sided = a token only one
// compartment touches). Empty on a pre-v4 db (no contract_tokens table).
export function contractDriftByName(db, project, includeTests = false) {
  const out = new Map();
  let defined;
  try {
    // `direction` is selected too: for a resource token it carries the encoded
    // kind/semantics/single_writer the classifier needs to spot a violation.
    defined = db.prepare('SELECT c.name name, ct.token token, ct.direction direction, ct.producers producers, ct.consumers consumers FROM contract_tokens ct JOIN contracts c ON c.id=ct.contract WHERE ct.project=?').all(project);
  } catch {
    return out; // contract_tokens table absent (old schema)
  }
  const refs = db.prepare(
    `SELECT c.name name, s.compartment compartment, s.file file, e.token token
       FROM edges e JOIN symbols s ON s.id=e.src JOIN contracts c ON c.id=e.dst
      WHERE e.project=@project AND e.type='REFERENCES'`).all({ project });
  const refMap = new Map(); // name -> Map(token -> Set(compartment))
  for (const r of refs) {
    if (!r.token || (!includeTests && isTest(r.file))) continue;
    if (!refMap.has(r.name)) refMap.set(r.name, new Map());
    const m = refMap.get(r.name);
    if (!m.has(r.token)) m.set(r.token, new Set());
    m.get(r.token).add(r.compartment);
  }
  // name -> Map(token -> {producers[], consumers[]}) — role metadata per token so the
  // SAME role-aware classifier trace_contract uses can decide each token's verdict.
  const byName = new Map();
  for (const d of defined) {
    if (!byName.has(d.name)) byName.set(d.name, new Map());
    byName.get(d.name).set(d.token, {
      direction: d.direction || null,
      producers: d.producers ? d.producers.split(',') : [],
      consumers: d.consumers ? d.consumers.split(',') : [],
    });
  }
  for (const [name, toks] of byName) {
    let satisfied = 0, oneSided = 0, unreferenced = 0, violations = 0, undeclared = 0;
    const m = refMap.get(name) || new Map();
    for (const [t, meta] of toks) {
      const refs = m.get(t) || new Set();
      const verdict = classifyContractToken(refs, meta);
      if (verdict === 'unreferenced') unreferenced++;
      else if (verdict === 'one-sided') oneSided++;
      else satisfied++;
      if (singleWriterViolation(meta)) violations++; // orthogonal — see classifyContractToken
      if (undeclaredParticipants(refs, meta).length) undeclared++; // orthogonal again
    }
    // `status` is still ONE value because it drives a single edge colour in export-html.
    // Precedence: drift beats violation beats one-sided. A contract that is both drifted
    // and in violation shows as drift AND reports `violations > 0` alongside, so the
    // second finding is not lost the way it was when the two shared a bucket.
    const status = unreferenced > 0 ? 'drift' : (violations > 0 ? 'violation' : (oneSided > 0 ? 'one-sided' : 'ok'));
    // `violations` / `undeclared` are OMITTED when zero. They are embedded
    // verbatim into export-html's DATA blob, so emitting a zero on every row would change
    // the bytes of every generated visualization for every wire-only project — a diff in
    // output for a feature they do not use, and it would falsify the byte-identical claim
    // the export tests make. Present-and-non-zero is the same information.
    out.set(name, {
      total: toks.size, satisfied, oneSided, unreferenced,
      ...(violations ? { violations } : {}),
      ...(undeclared ? { undeclared } : {}),
      status,
    });
  }
  return out;
}

export function pathBetween(db, project, from, to, fromRepo, toRepo, maxHops = 12) {
  const hops = Math.max(1, Math.min(20, Math.floor(Number(maxHops) || 12)));
  // A path over CALLS+REFERENCES can route THROUGH a Contract node (the
  // cross-compartment case this tool exists for), so resolve labels against both
  // tables — symbols first, then contracts (which have a name but no
  // compartment/file). Mirrors Neo4j's generic
  // coalesce(compartment,'')+':'+coalesce(file,name)+... reconstruction.
  const node = (id) =>
    db.prepare('SELECT id,compartment,file,name FROM symbols WHERE id=?').get(id) ||
    db.prepare('SELECT id,NULL compartment,file,name FROM contracts WHERE id=?').get(id) ||
    { compartment: null, file: null, name: id };
  // includeModules: `<module>` is a legitimate endpoint here (see symbolMatches) —
  // module-scope code is where top-level resource writes/reads and route
  // registrations live. Every other caller keeps the old, filtered behavior.
  const starts = symbolMatches(db, project, from, fromRepo, null, { includeModules: true }).map((r) => r.id);
  const goals = new Set(symbolMatches(db, project, to, toRepo, null, { includeModules: true }).map((r) => r.id));
  if (!starts.length || !goals.size) return `No path found between "${from}" and "${to}" within ${hops} hops.`;
  // undirected adjacency over CALLS + REFERENCES + IMPORTS (cross-compartment deps)
  const adj = new Map();
  const add = (a, b, rel) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, rel }); };
  for (const e of db.prepare("SELECT src,dst,type FROM edges WHERE project=? AND type IN ('CALLS','REFERENCES','IMPORTS')").all(project)) {
    add(e.src, e.dst, e.type); add(e.dst, e.src, e.type);
  }
  // BFS
  const prev = new Map(); const seen = new Set(starts);
  let frontier = starts.map((id) => ({ id, depth: 0 }));
  let hit = null;
  while (frontier.length && !hit) {
    const next = [];
    for (const { id, depth } of frontier) {
      if (goals.has(id)) { hit = id; break; }
      if (depth >= hops) continue;
      for (const nb of (adj.get(id) || [])) {
        if (!seen.has(nb.to)) { seen.add(nb.to); prev.set(nb.to, { from: id, rel: nb.rel }); next.push({ id: nb.to, depth: depth + 1 }); }
      }
    }
    frontier = next;
  }
  if (!hit) for (const s of starts) if (goals.has(s)) hit = s;
  if (!hit) return `No path found between "${from}" and "${to}" within ${hops} hops.`;
  // reconstruct
  const chain = [hit]; const rels = [];
  let cur = hit;
  while (prev.has(cur)) { const p = prev.get(cur); rels.unshift(p.rel); chain.unshift(p.from); cur = p.from; }
  // Match Neo4j exactly: coalesce(compartment,'') + ':' + coalesce(file,name) + (file&&name ? ':'+name : '')
  const label = (id) => {
    const n = node(id);
    return `${n.compartment || ''}:${n.file || n.name}${n.file && n.name ? ':' + n.name : ''}`;
  };
  const parts = [];
  for (let i = 0; i < chain.length; i++) { parts.push(label(chain[i])); if (i < rels.length) parts.push(`  --[${rels[i]}]-->`); }
  return parts.join('\n');
}

// Raw read-only SQL escape hatch — the SQLite analogue of the old `cypher` tool,
// for structural questions the shaped tools don't cover. The db is per-project so
// every row already belongs to this project (no scoping needed). Only a single
// read-only SELECT/WITH…SELECT is allowed; anything that could mutate is rejected.
// Read-only is enforced at the ENGINE level via `PRAGMA query_only=ON` (below), so
// no SQL cleverness can write — the string guards (single-statement, must start
// SELECT/WITH, load_extension block) are a first line, but the pragma is what makes
// a write impossible regardless of statement shape.
export function querySql(db, sql) {
  const q = String(sql || '').trim().replace(/;\s*$/, '');
  if (!q) return 'Empty query.';
  if (/;/.test(q)) return 'Refused: only a single statement is allowed (no ";").';
  if (!/^(SELECT|WITH)\b/i.test(q)) return 'Refused: only read-only SELECT (or WITH … SELECT) queries are allowed.';
  // The one dangerous thing callable *inside* a SELECT expression is load_extension()
  // (loads a shared library = arbitrary code execution, which query_only does NOT
  // stop), so we block just that. A broad keyword blocklist would wrongly refuse
  // legitimate reads (e.g. LIKE 'create%', or the scalar replace() function).
  if (/\bload_extension\s*\(/i.test(q)) {
    return 'Refused: load_extension is not allowed. This tool is read-only.';
  }
  // Engine-level read-only enforcement. A leading WITH clause CAN front a
  // data-modifying statement in SQLite (`WITH t AS (...) DELETE FROM ...`), which the
  // SELECT/WITH-start check does NOT catch — query_only makes every such write throw
  // "attempt to write a readonly database", caught below. This is a session setting on
  // the short-lived per-call connection (server.js hands querySql its own freshRead
  // handle), so it never leaks to writers.
  try { db.exec('PRAGMA query_only=ON'); } catch { /* ignore */ }
  let rows;
  try { rows = db.prepare(q).all(); }
  catch (e) { return 'SQL error: ' + e.message; }
  if (!rows.length) return '(no rows)';
  const capped = rows.slice(0, 200);
  return JSON.stringify(capped, null, 2) + (rows.length > 200 ? `\n… (${rows.length - 200} more rows omitted)` : '');
}
