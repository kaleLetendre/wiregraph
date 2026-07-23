#!/usr/bin/env node
// wiregraph MCP server — exposes the call/association graph to Claude as a set of
// question-shaped tools (not raw SQL, except as an escape hatch).
//
// The graph lives in an embedded SQLite file (no daemon, no JVM): one .db per
// project at <project>/.wiregraph/graph.db (override with $WIREGRAPH_DB). Every
// row is tagged with its project, and the active project is CLAUDE_PROJECT_DIR
// (set by Claude Code) or the cwd.
//
// ECONOMY (this is where the token win comes from): plan a MINIMAL set of
// queries, trust each result, and don't re-grep what the graph already showed —
// query count is the dominant cost, not file reads. trace_* return the WHOLE
// chain in one call, so don't walk it hop-by-hop. Prefer get_source over Read
// for a single function. BLIND SPOTS the graph cannot see: (a) function-pointer
// / callback edges, (b) string literals (JSON field names, route paths), and
// (c) the C preprocessor — call sites inside #if 0 / disabled #ifdef blocks are
// still counted, so a C caller list is an UPPER BOUND; verify guards. For wire
// questions confirm the exact field/endpoint with one targeted get_source/grep.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, schemaVersion, SCHEMA_VERSION } from '../store/sqlite.js';
import * as Q from '../store/sqlite-query.js';
import { runBuild, reindexFiles } from '../build.js';
import { readState, updateState, findIndexedRoot, wiregraphDir, owningMember, statusAdvisories } from '../../scripts/lib/state.mjs';
import { changedSince, projectRepos, upstreamDivergence } from '../../scripts/lib/git.mjs';
import { record, estTokens } from '../../scripts/lib/metrics.mjs';

const VERSION = '0.4.2';

// Resolve the active project once at startup. realpath so it matches the build
// (build.js tags nodes with realpathSync of the init root).
function resolveProject() {
  const raw = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Prefer the indexed workspace root so the server answers from the right graph
  // even when launched inside a sub-repo; fall back to the raw dir when nothing
  // up the tree is indexed (withDb then surfaces NOT_BUILT / the init nudge).
  const indexed = findIndexedRoot(raw);
  if (indexed) return indexed;
  try { return realpathSync(raw); } catch { return raw; }
}
const PROJECT = resolveProject();
const SESSION = process.env.CLAUDE_SESSION_ID || null; // best-effort; MCP servers may not get it
const NOT_BUILT = `No wiregraph for this project (${PROJECT}). Run /wiregraph-init here to build it.`;

function dbPath() {
  return process.env.WIREGRAPH_DB || join(wiregraphDir(PROJECT), 'graph.db');
}

function text(s) {
  return { content: [{ type: 'text', text: s }] };
}

// Open the project's db read-only for one tool call. SQLite opens are sub-ms, so
// per-call open keeps us robust to the db being built/rebuilt/removed mid-session
// (no stale handle). Returns NOT_BUILT if the file is missing, a friendly rebuild
// prompt on a schema mismatch, and NOT_BUILT if the project has no symbols yet.
function withDb(fn, { requireIndexed = true } = {}) {
  const p = dbPath();
  if (!existsSync(p)) return text(NOT_BUILT);
  let db;
  try { db = connect(p, { readonly: true }); }
  catch { return text(NOT_BUILT); }
  try {
    const v = schemaVersion(db);
    if (v !== SCHEMA_VERSION) {
      return text(v > SCHEMA_VERSION
        ? `wiregraph DB schema is v${v}, NEWER than this plugin (v${SCHEMA_VERSION}). Update wiregraph (/plugin) — do NOT rebuild; that would downgrade the graph and lose data.`
        : `wiregraph DB schema is v${v} but this version expects v${SCHEMA_VERSION}. Run /wiregraph-rebuild to refresh it.`);
    }
    if (requireIndexed) {
      const n = db.prepare('SELECT count(*) AS c FROM symbols WHERE project = ?').get(PROJECT).c;
      if (!n) return text(NOT_BUILT);
    }
    return fn(db);
  } finally {
    db.close();
  }
}

// --- self-heal on read ------------------------------------------------------
// The directive tells Claude to TRUST the graph, so the graph must actually be
// current at query time. Before a read tool answers, cheaply detect source files
// that changed on disk since they were indexed and re-index just those — so an
// edit (by Claude or the user, committed or not) is reflected without Claude
// having to notice staleness and call update_graph. Bounded by a short TTL so a
// burst of queries pays the git+stat probe at most once per window.
const FRESH_TTL_MS = 1500;
let lastFreshAt = 0;
let schemaConfirmed = false;   // set once the on-disk db is known to be on the current schema (per process)
let schemaHealPromise = null;  // dedups a concurrent schema-migration rebuild

// A schema bump (e.g. v1 -> v2) leaves an existing graph on the OLD schema. Until
// now the read tools returned "run /wiregraph-rebuild" and the model fell back to
// grep — the exact failure users hit after an update. Migrate transparently
// instead: a full reset rebuild recreates the tables at the current schema (the
// loader's migrate-on-reset path). It's deduped within the process and AWAITED by
// every caller before serving, so a fan-out of verifier subagents triggers a
// single rebuild and none of them ever sees the mismatch and bails to grep.
async function ensureSchemaCurrent() {
  if (schemaConfirmed) return;
  const p = dbPath();
  if (!existsSync(p)) return; // not built at all → withDb surfaces NOT_BUILT, not a schema issue
  let v = null, db;
  try { db = connect(p, { readonly: true }); v = schemaVersion(db); }
  catch { return; }
  finally { try { db?.close(); } catch { /* */ } }
  if (v === SCHEMA_VERSION) { schemaConfirmed = true; return; }
  // A NEWER db (written by a later wiregraph) must NOT be auto-rebuilt — a reset
  // rebuild recreates the tables at THIS (older) schema, silently downgrading and
  // discarding whatever the newer version stored. Leave it; withDb surfaces the
  // "update wiregraph" message instead of quietly destroying data.
  if (v > SCHEMA_VERSION) return;
  if (!schemaHealPromise) {
    schemaHealPromise = runBuild({ target: PROJECT, project: PROJECT, reset: true })
      .then(() => { schemaConfirmed = true; lastFreshAt = Date.now(); }) // just rebuilt → also fresh
      .catch(() => { /* withDb's mismatch message remains the backstop */ })
      .finally(() => { schemaHealPromise = null; });
  }
  await schemaHealPromise;
}

// Read-only probe: of the files git says changed, which actually differ from what
// was indexed (mtime/size)? Cheap, and free of the old false-positive where an
// uncommitted-but-already-reindexed file looked stale forever.
function staleNow() {
  const p = dbPath();
  if (!existsSync(p)) return [];
  let db;
  try { db = connect(p, { readonly: true }); } catch { return []; }
  try {
    if (schemaVersion(db) !== SCHEMA_VERSION) return []; // mismatch → withDb prompts a rebuild
    const state = readState(PROJECT);
    let candidates;
    try { candidates = changedSince(PROJECT, state?.reposLastSha || {}).files; } catch { return []; }
    return Q.staleAmong(db, PROJECT, candidates);
  } finally { db.close(); }
}

async function ensureFresh() {
  const now = Date.now();
  if (now - lastFreshAt < FRESH_TTL_MS) return;
  lastFreshAt = now; // claim the window up front so concurrent reads don't stampede
  const stale = staleNow();
  if (!stale.length) return;
  // A stale file may live under a linked member — reindexFiles attributes each to
  // its owning member and fans the update into every graph that includes it, so a
  // read stays self-healing across the whole union, not just this project's tree.
  try { await reindexFiles(stale, PROJECT, { fanOut: true }); }
  catch { /* best-effort: serve what we have rather than fail the read */ }
}

// --- upstream-divergence caveat ---------------------------------------------
// ensureFresh keeps the index matching the WORKING TREE, but "matches my
// checkout" is not "matches the code I think I'm reading" when the checkout is a
// branch behind its upstream — the graph then serves stale code while reporting
// Fresh, and an agent that trusts it (without ever calling graph_status) reasons
// over the wrong tree. Surface ahead/behind vs @{upstream} as a one-line caveat.
// Warn, never block: the graph isn't wrong, it's just indexing an old branch.
let upstreamBannerSent = false; // once per process — not on every read
function upstreamCaveatLine() {
  let div;
  // Home-only: the once-per-process banner flags THIS project's checkout; a linked
  // member parked on an old branch is not this project's concern (graph_status
  // reports the full union on demand).
  try { div = upstreamDivergence(PROJECT, { homeOnly: true }); } catch { return null; }
  const behind = (div || []).filter((d) => d.behind > 0);
  if (!behind.length) return null;
  const parts = behind.map((d) =>
    `${d.name}: on '${d.branch}', ${d.behind} behind${d.ahead ? `/${d.ahead} ahead` : ''} of ${d.upstream}`);
  return `⚠ wiregraph reflects your CHECKOUT, which is behind upstream — ${parts.join('; ')}. `
    + `Pull or switch branches if you expect upstream's code; the graph isn't wrong, it's indexing an old branch.`;
}

// Wrap a read tool: migrate an out-of-date schema, refresh stale files, then open
// read-only and serve. Schema heal comes first so ensureFresh runs against v2.
async function freshRead(fn, opts) {
  await ensureSchemaCurrent();
  await ensureFresh();
  const res = withDb(fn, opts);
  // One-time-per-process banner so the FIRST read of a session flags a stale
  // checkout without the agent having to call graph_status (the skipped step in
  // the session this guards against). Mark sent unconditionally — exactly one git
  // probe per process — and prepend only when actually behind and serving text.
  if (!upstreamBannerSent) {
    upstreamBannerSent = true;
    const caveat = upstreamCaveatLine();
    if (caveat && res?.content?.[0]?.type === 'text') {
      res.content[0].text = `${caveat}\n\n${res.content[0].text}`;
    }
  }
  return res;
}

// --- impact metrics ---------------------------------------------------------
// Record graph-tool usage + an estimate of tokens saved to .wiregraph/metrics.jsonl
// (see scripts/lib/metrics.mjs for the honesty caveats). ALL best-effort: a
// measurement failure must NEVER fail the tool call.
const GS_HEADER = /^([^:\n]+):([^:\n]+):(\d+)-(\d+)\s/; // "compartment:file:start-end name" header (sqlite-query.js)

// get_source's saving is the clean counterfactual: the whole file you'd have Read
// vs the symbol body it returned. Parse the header for compartment/file, resolve the
// file via the live db (same compartments lookup Q.getSource does), measure both sides.
function recordGetSource(db, out) {
  try {
    const returnedTokens = estTokens(out);
    const m = GS_HEADER.exec(out);
    if (!m) { record(PROJECT, { sessionId: SESSION, kind: 'use', tool: 'get_source', returnedTokens }); return; }
    const [, compartment, file] = m;
    let fileTokens = 0;
    const root = db.prepare('SELECT root FROM compartments WHERE project=? AND name=?').get(PROJECT, compartment)?.root;
    if (root) { try { fileTokens = estTokens(readFileSync(join(root, file), 'utf8')); } catch { /* file gone */ } }
    record(PROJECT, { sessionId: SESSION, kind: 'use', tool: 'get_source', compartment, file,
      returnedTokens, fileTokens, savedTokens: Math.max(0, fileTokens - returnedTokens) });
  } catch { /* best-effort */ }
}

// A trace answers a whole call tree in one call. Node count (one arrow per node)
// and returned tokens are exact; the modeled "saved" figure lives in summarize.
function recordTrace(tool, out) {
  try {
    record(PROJECT, { sessionId: SESSION, kind: 'use', tool,
      nodes: (String(out).match(/[→◄]/g) || []).length, returnedTokens: estTokens(out) });
  } catch { /* best-effort */ }
}

// Plain usage tally for the other read tools (the denominator).
function recordUse(tool, out) {
  try { record(PROJECT, { sessionId: SESSION, kind: 'use', tool, returnedTokens: estTokens(out) }); }
  catch { /* best-effort */ }
}

const server = new McpServer({ name: 'wiregraph', version: VERSION });

// --- graph_stats ------------------------------------------------------------
server.registerTool('graph_stats', {
  description: 'Overall size of THIS PROJECT\'s code graph: node counts by label, edge counts by type, and per-compartment symbol counts. Call this first to confirm the graph is loaded for the active project.',
  inputSchema: {},
}, async () => freshRead((db) => text(Q.graphStats(db, PROJECT))));

// --- find_symbol ------------------------------------------------------------
server.registerTool('find_symbol', {
  description: 'Find function/method/class definitions by exact name in this project. Use this to disambiguate before tracing when a name may exist in several files or compartments.',
  inputSchema: {
    name: z.string().describe('Exact symbol name, e.g. "parse_request"'),
    compartment: z.string().optional().describe('Restrict to a compartment (a package/module or repo), e.g. "api-server"'),
  },
}, async ({ name, compartment }) => freshRead((db) => {
  const out = Q.findSymbol(db, PROJECT, name, compartment);
  recordUse('find_symbol', out);
  return text(out);
}));

// --- get_source -------------------------------------------------------------
// Returns ONLY a symbol's definition lines (file:startLine..endLine), read from
// disk at query time. Far cheaper than opening the whole file with Read when you
// only need one function — e.g. a handler lives in an 800-line file, but its body
// is ~70 lines. The graph already knows every symbol's exact line span.
server.registerTool('get_source', {
  description: 'Return the exact source code of a specific function/method/symbol — just its definition lines, not the whole file. PREFER THIS OVER reading a file when you need to see one symbol\'s body: it returns only that symbol\'s lines (e.g. a 70-line function out of an 800-line file), so it costs far fewer tokens than Read. Disambiguate with compartment/file if the name is not unique.',
  inputSchema: {
    name: z.string().describe('Symbol name, e.g. "parse_request"'),
    compartment: z.string().optional(),
    file: z.string().optional().describe('Substring of the file path, to disambiguate'),
    context: z.number().optional().describe('Extra lines of context above/below (default 0)'),
  },
}, async ({ name, compartment, file, context }) => freshRead((db) => {
  const out = Q.getSource(db, PROJECT, name, compartment, file, context);
  recordGetSource(db, out);
  return text(out);
}));

// --- trace_callees / trace_callers -----------------------------------------
server.registerTool('trace_callees', {
  description: 'Downward call stack: what this symbol calls, transitively, within its compartment. Returns the WHOLE tree in one call (don\'t walk it hop-by-hop). Cross-compartment calls are wire calls — use trace_contract / path_between for those. Caveat: blind to function-pointer/callback dispatch and (in C) counts call sites inside disabled #if 0 / #ifdef blocks.',
  inputSchema: {
    name: z.string().describe('Symbol name to trace from'),
    compartment: z.string().optional(),
    file: z.string().optional().describe('Substring of the file path, to disambiguate'),
    depth: z.number().optional().describe('Max hops, 1-8 (default 3)'),
    includeTests: z.boolean().optional().describe('Include callees in test files (default false)'),
  },
}, async ({ name, compartment, file, depth, includeTests }) =>
  freshRead((db) => {
    const out = Q.traceCallees(db, PROJECT, name, compartment, file, depth, includeTests);
    recordTrace('trace_callees', out);
    return text(out);
  }));

server.registerTool('trace_callers', {
  description: 'Upward call stack: who calls this symbol, transitively, within its compartment. Returns the WHOLE tree in one call (don\'t walk it hop-by-hop) — callers above the symbol. Use to find entrypoints reaching a function. Caveat: the caller set is an UPPER BOUND in C — it includes call sites inside disabled #if 0 / #ifdef blocks (the static graph is blind to the preprocessor); it is also blind to function-pointer/callback dispatch.',
  inputSchema: {
    name: z.string().describe('Symbol name to trace callers of'),
    compartment: z.string().optional(),
    file: z.string().optional().describe('Substring of the file path, to disambiguate'),
    depth: z.number().optional().describe('Max hops, 1-8 (default 3)'),
    includeTests: z.boolean().optional().describe('Include callers in test files (default false)'),
  },
}, async ({ name, compartment, file, depth, includeTests }) =>
  freshRead((db) => {
    const out = Q.traceCallers(db, PROJECT, name, compartment, file, depth, includeTests);
    recordTrace('trace_callers', out);
    return text(out);
  }));

// --- trace_contract ---------------------------------------------------------
server.registerTool('trace_contract', {
  description: 'Cross-compartment wire seam AND code↔contract DRIFT check: which code symbols, in which compartments, reference a given contract (matched on its wire tokens — channel paths and payload fields), PLUS which of the contract\'s tokens are unreferenced or only touched by one side. Every call diffs the contract\'s FULL defined-token set against the code: 🔴 unreferenced = defined in the contract but NO code references it (code drifted off the contract), ⚠️ one-sided = only one compartment references it (a cross-compartment seam missing its other half), satisfied = both sides present. A clean report is EARNED, not assumed — trust the drift lines. Edges are HEURISTIC (evidence: contract-match): "mentions a token this contract defines", not verified to implement it, and a token can be present but with a drifted PAYLOAD SHAPE the string match can\'t see — confirm the exact field/endpoint with a targeted get_source.',
  inputSchema: {
    contract: z.string().describe('Substring of the contract name, e.g. "Heartbeat", "Provisioning"'),
    token: z.string().optional().describe('Restrict to symbols referencing a specific wire token, e.g. "order_id"'),
    includeTests: z.boolean().optional().describe('Include symbols in test files (default false)'),
  },
}, async ({ contract, token, includeTests }) =>
  freshRead((db) => {
    let out = Q.traceContract(db, PROJECT, contract, token, includeTests);
    // traceContract is a pure db fn (reads REFERENCES only); the inference-staleness
    // flag lives in state, so append its warning HERE rather than contorting the query.
    const state = readState(PROJECT);
    if (state?.seamStaleSinceInference) {
      out += '\n⚠ a route may have changed since the last contract inference — the inferred spec was NOT regenerated, so a newly added/removed endpoint may be missing here. Run /wiregraph-rebuild to re-infer the seams.';
    }
    recordUse('trace_contract', out);
    return text(out);
  }));

// --- path_between -----------------------------------------------------------
server.registerTool('path_between', {
  description: 'Shortest path between two symbols across CALLS and contract REFERENCES edges (undirected) within this project. This can cross compartments by routing through a shared Contract node — e.g. an emitter in one compartment to the handler in another. Returns the chain of nodes and edge types.',
  inputSchema: {
    from: z.string().describe('Source symbol name'),
    to: z.string().describe('Target symbol name'),
    fromCompartment: z.string().optional(),
    toCompartment: z.string().optional(),
    maxHops: z.number().optional().describe('Max path length, 1-20 (default 12)'),
  },
}, async ({ from, to, fromCompartment, toCompartment, maxHops }) =>
  freshRead((db) => {
    const out = Q.pathBetween(db, PROJECT, from, to, fromCompartment, toCompartment, maxHops);
    recordUse('path_between', out);
    return text(out);
  }));

// --- graph_status -----------------------------------------------------------
// A cheap "is the graph healthy and fresh for this project?" check Claude calls
// to decide whether to update before trusting a trace.
server.registerTool('graph_status', {
  description: 'Health + freshness of the wiregraph for THIS project: is the project indexed (counts), when was the last full build, is the graph STALE (any file whose on-disk content differs from what was indexed), and whether the checkout is BEHIND its upstream branch (the graph mirrors your working tree, so a stale branch serves stale code while still reporting fresh). The read tools already self-heal — they re-index changed files before answering — so you rarely need this; use it to confirm freshness, check you are not on a stale branch, or before a full rebuild after a big refactor.',
  inputSchema: {},
}, async () => withDb((db) => {
  const stats = Q.graphStats(db, PROJECT);
  if (stats.startsWith('No wiregraph')) return text(NOT_BUILT);
  const state = readState(PROJECT);
  const lines = [
    stats.split('\n').slice(0, 3).join('\n'), // Project / Nodes / Edges lines
    `Last full build: ${state?.lastFullBuild || 'unknown'}`,
    `Auto-update posture: ${state?.autoUpdate || '(not set)'}`,
  ];
  // Staleness: of the files git says changed (committed diff vs stored per-root
  // sha + uncommitted edits), only those whose on-disk mtime/size differs from
  // what was indexed are actually stale — so a re-indexed-but-uncommitted file is
  // NOT counted (the old git-only check flagged it forever).
  let changed = [];
  try { changed = Q.staleAmong(db, PROJECT, changedSince(PROJECT, state?.reposLastSha || {}).files); }
  catch { /* git not available — skip staleness */ }
  if (changed.length) {
    // Strip the OWNING member's prefix (own root or a linked member), not just
    // PROJECT's — a stale file under a linked member would otherwise print its full
    // absolute path here.
    const strip = (f) => { const m = owningMember(f, PROJECT); return m ? f.slice(f.startsWith(m + '/') ? m.length + 1 : 0) : f; };
    const preview = changed.slice(0, 5).map(strip).join(', ');
    lines.push(`STALE: ${changed.length} changed source file(s) (${preview}${changed.length > 5 ? ', …' : ''}). Run update_graph to refresh.`);
  } else {
    lines.push('Fresh: no source changes detected since last index.');
  }
  // Honesty flags surfaced after "fresh": incremental updates that added/removed/
  // renamed symbols can leave cross-file caller edges approximate (structural drift),
  // and a route added/removed in a contract-bearing compartment is invisible to the
  // seams until a full rebuild re-infers (seam staleness). statusAdvisories renders the
  // exact lines from state so "fresh" is never read as "everything is guaranteed correct."
  lines.push(...statusAdvisories(state));
  // Upstream divergence: the graph mirrors the working tree, so "fresh" can still
  // mean "indexing a branch behind origin". Report ahead/behind vs each repo's
  // @{upstream} — a trust caveat, not a staleness error (no re-index would fix it;
  // only a pull/switch would). Recomputed live here, unlike the once-per-session
  // banner the read tools emit.
  let div = [];
  try { div = upstreamDivergence(PROJECT); } catch { /* git not available — skip */ }
  const behind = div.filter((d) => d.behind > 0);
  if (behind.length) {
    for (const d of behind) {
      lines.push(`BEHIND UPSTREAM: ${d.name} on '${d.branch}' is ${d.behind} behind${d.ahead ? `/${d.ahead} ahead` : ''} of ${d.upstream}. The graph reflects this checkout — pull or switch if you expect upstream's code.`);
    }
  } else if (div.length) {
    lines.push('Upstream: ahead of upstream but not behind (checkout is current).');
  }
  return text(lines.join('\n'));
}, { requireIndexed: false }));

// --- update_graph -----------------------------------------------------------
// Lets Claude refresh the active project's graph mid-session without a shell.
server.registerTool('update_graph', {
  description: 'Refresh THIS project\'s wiregraph in place. With no args it does an INCREMENTAL update of files changed since the last index (git diff + uncommitted edits) — cheap; call it after you edit code or when graph_status reports stale. Pass files:[...] to re-index specific paths, or full:true for a from-scratch project-scoped rebuild (the correctness backstop after big refactors/renames).',
  inputSchema: {
    files: z.array(z.string()).optional().describe('Specific files to re-index (project-relative or absolute). Omit to auto-detect changed files.'),
    full: z.boolean().optional().describe('Full project-scoped rebuild instead of incremental (default false).'),
  },
}, async ({ files, full }) => {
  // An incremental update against an old-schema db would try to write v2 columns
  // into v1 tables and fail; migrate first (no-op once on the current schema).
  if (!full) await ensureSchemaCurrent();
  const state = readState(PROJECT);
  const now = new Date().toISOString();
  try {
    if (full) {
      await runBuild({ target: PROJECT, project: PROJECT, reset: true });
      const repos = projectRepos(PROJECT);
      const newShas = {};
      for (const r of repos) if (r.head) newShas[r.root] = r.head;
      updateState(PROJECT, { lastFullBuild: now, reposLastSha: newShas }, VERSION);
      const n = withDbCount();
      return text(`Full rebuild complete: ${n} symbols indexed. Graph is fresh.`);
    }

    // Incremental: explicit files, else auto-detect the files that actually DIFFER
    // from what's indexed (mtime/size), not merely what git shows as changed — so
    // an already-reindexed uncommitted file isn't pointlessly rebuilt and the call
    // reports "already current" instead of churning forever.
    let targets = files;
    let newShas = state?.reposLastSha || {};
    if (!targets || !targets.length) {
      newShas = { ...newShas, ...changedSince(PROJECT, state?.reposLastSha || {}).newShas };
      targets = staleNow();
      if (!targets.length) {
        updateState(PROJECT, { reposLastSha: newShas }, VERSION); // advance shas; nothing to re-index
        return text('Graph already current — no changed source files detected.');
      }
    }
    // Attribute each file to its owning member and fan the update into every graph
    // that includes it (a linked member's edit updates both dbs).
    await reindexFiles(targets, PROJECT, { fanOut: true });
    updateState(PROJECT, { reposLastSha: newShas }, VERSION);
    return text(`Incremental update complete: re-indexed ${targets.length} file(s).`);
  } catch (e) {
    return text(`update_graph failed: ${e.message.split('\n')[0]}`);
  }
});

// Count this project's symbols via a fresh read-only connection (used after a
// build, when withDb's cached-free open reflects the just-written rows).
function withDbCount() {
  const p = dbPath();
  if (!existsSync(p)) return 0;
  const db = connect(p, { readonly: true });
  try { return db.prepare("SELECT count(*) AS c FROM symbols WHERE project = ? AND kind <> 'module'").get(PROJECT).c; }
  finally { db.close(); }
}

// --- query_sql (read-only escape hatch) -------------------------------------
server.registerTool('query_sql', {
  description: 'Run a read-only SQL SELECT against the graph for structural questions the shaped tools do not cover. Rejected if it is not a single read-only SELECT/WITH. The db holds ONLY this project, so no project filter is needed. Schema — tables: symbols(id,project,compartment,file,name,kind,lang,startLine,endLine), files(id,project,compartment,path,lang), compartments(id,project,name,root), contracts(id,project,name,file), edges(type,src,dst,project,token,cnt,resolution,evidence,direction,contract). edges.type is one of CALLS|DEFINED_IN|REFERENCES|WIRE|IN_COMPARTMENT; src/dst are node ids — CALLS/WIRE join symbols.id↔symbols.id, DEFINED_IN symbols.id→files.id, REFERENCES symbols.id→contracts.id, IN_COMPARTMENT files.id→compartments.id. Example: SELECT s.compartment, count(*) n FROM symbols s WHERE s.kind=\'function\' GROUP BY s.compartment.',
  inputSchema: {
    query: z.string().describe('A single read-only SQL SELECT (or WITH … SELECT)'),
  },
}, async ({ query }) => freshRead((db) => {
  const out = Q.querySql(db, query);
  recordUse('query_sql', out);
  return text(out);
}));

const transport = new StdioServerTransport();
await server.connect(transport);
