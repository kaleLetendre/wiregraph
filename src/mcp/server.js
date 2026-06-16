#!/usr/bin/env node
// codegraph MCP server — exposes the call/association graph to Claude as a set of
// question-shaped tools (not raw SQL, except as an escape hatch).
//
// The graph lives in an embedded SQLite file (no daemon, no JVM): one .db per
// project at <project>/.codegraph/graph.db (override with $CODEGRAPH_DB). Every
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
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { connect, schemaVersion, SCHEMA_VERSION } from '../store/sqlite.js';
import * as Q from '../store/sqlite-query.js';
import { runBuild } from '../build.js';
import { readState, updateState } from '../../scripts/lib/state.mjs';
import { changedSince, projectRepos } from '../../scripts/lib/git.mjs';

const VERSION = '0.3.0';

// Resolve the active project once at startup. realpath so it matches the build
// (build.js tags nodes with realpathSync of the init root).
function resolveProject() {
  const raw = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try { return realpathSync(raw); } catch { return raw; }
}
const PROJECT = resolveProject();
const NOT_BUILT = `No codegraph for this project (${PROJECT}). Run /codegraph-init here to build it.`;

function dbPath() {
  return process.env.CODEGRAPH_DB || join(PROJECT, '.codegraph', 'graph.db');
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
      return text(`codegraph DB schema is v${v} but this version expects v${SCHEMA_VERSION}. Run /codegraph-rebuild to refresh it.`);
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

const server = new McpServer({ name: 'codegraph', version: VERSION });

// --- graph_stats ------------------------------------------------------------
server.registerTool('graph_stats', {
  description: 'Overall size of THIS PROJECT\'s code graph: node counts by label, edge counts by type, and per-repo symbol counts. Call this first to confirm the graph is loaded for the active project.',
  inputSchema: {},
}, async () => withDb((db) => text(Q.graphStats(db, PROJECT))));

// --- find_symbol ------------------------------------------------------------
server.registerTool('find_symbol', {
  description: 'Find function/method/class definitions by exact name in this project. Use this to disambiguate before tracing when a name may exist in several files or repos.',
  inputSchema: {
    name: z.string().describe('Exact symbol name, e.g. "parse_request"'),
    repo: z.string().optional().describe('Restrict to a repo, e.g. "api-server"'),
  },
}, async ({ name, repo }) => withDb((db) => text(Q.findSymbol(db, PROJECT, name, repo))));

// --- get_source -------------------------------------------------------------
// Returns ONLY a symbol's definition lines (file:startLine..endLine), read from
// disk at query time. Far cheaper than opening the whole file with Read when you
// only need one function — e.g. a handler lives in an 800-line file, but its body
// is ~70 lines. The graph already knows every symbol's exact line span.
server.registerTool('get_source', {
  description: 'Return the exact source code of a specific function/method/symbol — just its definition lines, not the whole file. PREFER THIS OVER reading a file when you need to see one symbol\'s body: it returns only that symbol\'s lines (e.g. a 70-line function out of an 800-line file), so it costs far fewer tokens than Read. Disambiguate with repo/file if the name is not unique.',
  inputSchema: {
    name: z.string().describe('Symbol name, e.g. "parse_request"'),
    repo: z.string().optional(),
    file: z.string().optional().describe('Substring of the file path, to disambiguate'),
    context: z.number().optional().describe('Extra lines of context above/below (default 0)'),
  },
}, async ({ name, repo, file, context }) => withDb((db) => text(Q.getSource(db, PROJECT, name, repo, file, context))));

// --- trace_callees / trace_callers -----------------------------------------
server.registerTool('trace_callees', {
  description: 'Downward call stack: what this symbol calls, transitively, within its repo. Returns the WHOLE tree in one call (don\'t walk it hop-by-hop). Cross-repo calls are wire calls — use trace_contract / path_between for those. Caveat: blind to function-pointer/callback dispatch and (in C) counts call sites inside disabled #if 0 / #ifdef blocks.',
  inputSchema: {
    name: z.string().describe('Symbol name to trace from'),
    repo: z.string().optional(),
    file: z.string().optional().describe('Substring of the file path, to disambiguate'),
    depth: z.number().optional().describe('Max hops, 1-8 (default 3)'),
    includeTests: z.boolean().optional().describe('Include callees in test files (default false)'),
  },
}, async ({ name, repo, file, depth, includeTests }) =>
  withDb((db) => text(Q.traceCallees(db, PROJECT, name, repo, file, depth, includeTests))));

server.registerTool('trace_callers', {
  description: 'Upward call stack: who calls this symbol, transitively, within its repo. Returns the WHOLE tree in one call (don\'t walk it hop-by-hop) — callers above the symbol. Use to find entrypoints reaching a function. Caveat: the caller set is an UPPER BOUND in C — it includes call sites inside disabled #if 0 / #ifdef blocks (the static graph is blind to the preprocessor); it is also blind to function-pointer/callback dispatch.',
  inputSchema: {
    name: z.string().describe('Symbol name to trace callers of'),
    repo: z.string().optional(),
    file: z.string().optional().describe('Substring of the file path, to disambiguate'),
    depth: z.number().optional().describe('Max hops, 1-8 (default 3)'),
    includeTests: z.boolean().optional().describe('Include callers in test files (default false)'),
  },
}, async ({ name, repo, file, depth, includeTests }) =>
  withDb((db) => text(Q.traceCallers(db, PROJECT, name, repo, file, depth, includeTests))));

// --- trace_contract ---------------------------------------------------------
server.registerTool('trace_contract', {
  description: 'Cross-repo wire seam: which code symbols, in which repos, reference a given contract (matched on its wire tokens — channel paths and payload fields). This links a producer in one repo to the consumer in another that handles the same wire message. Edges are HEURISTIC (evidence: contract-match): "mentions a token this contract defines", not verified to implement it — confirm the exact field/endpoint with a targeted get_source.',
  inputSchema: {
    contract: z.string().describe('Substring of the contract name, e.g. "Heartbeat", "Provisioning"'),
    token: z.string().optional().describe('Restrict to symbols referencing a specific wire token, e.g. "order_id"'),
    includeTests: z.boolean().optional().describe('Include symbols in test files (default false)'),
  },
}, async ({ contract, token, includeTests }) =>
  withDb((db) => text(Q.traceContract(db, PROJECT, contract, token, includeTests))));

// --- path_between -----------------------------------------------------------
server.registerTool('path_between', {
  description: 'Shortest path between two symbols across CALLS and contract REFERENCES edges (undirected) within this project. This can cross repos by routing through a shared Contract node — e.g. an emitter in one repo to the handler in another. Returns the chain of nodes and edge types.',
  inputSchema: {
    from: z.string().describe('Source symbol name'),
    to: z.string().describe('Target symbol name'),
    fromRepo: z.string().optional(),
    toRepo: z.string().optional(),
    maxHops: z.number().optional().describe('Max path length, 1-20 (default 12)'),
  },
}, async ({ from, to, fromRepo, toRepo, maxHops }) =>
  withDb((db) => text(Q.pathBetween(db, PROJECT, from, to, fromRepo, toRepo, maxHops))));

// --- graph_status -----------------------------------------------------------
// A cheap "is the graph healthy and fresh for this project?" check Claude calls
// to decide whether to update before trusting a trace.
server.registerTool('graph_status', {
  description: 'Health + freshness of the codegraph for THIS project: is the project indexed (counts), when was the last full build, and is the graph STALE versus the repos\' current git HEAD / uncommitted edits. Call this when a trace looks out of date; if it reports stale, call update_graph.',
  inputSchema: {},
}, async () => withDb((db) => {
  const stats = Q.graphStats(db, PROJECT);
  if (stats.startsWith('No codegraph')) return text(NOT_BUILT);
  const state = readState(PROJECT);
  const lines = [
    stats.split('\n').slice(0, 3).join('\n'), // Project / Nodes / Edges lines
    `Last full build: ${state?.lastFullBuild || 'unknown'}`,
    `Auto-update posture: ${state?.autoUpdate || '(not set)'}`,
  ];
  // Staleness: source files changed since the last index (committed diff vs
  // stored per-root sha + uncommitted edits). changedSince folds in both.
  let changed = [];
  try { changed = changedSince(PROJECT, state?.reposLastSha || {}).files; }
  catch { /* git not available — skip staleness */ }
  if (changed.length) {
    const preview = changed.slice(0, 5).map((f) => f.replace(PROJECT + '/', '')).join(', ');
    lines.push(`STALE: ${changed.length} changed source file(s) (${preview}${changed.length > 5 ? ', …' : ''}). Run update_graph to refresh.`);
  } else {
    lines.push('Fresh: no source changes detected since last index.');
  }
  return text(lines.join('\n'));
}, { requireIndexed: false }));

// --- update_graph -----------------------------------------------------------
// Lets Claude refresh the active project's graph mid-session without a shell.
server.registerTool('update_graph', {
  description: 'Refresh THIS project\'s codegraph in place. With no args it does an INCREMENTAL update of files changed since the last index (git diff + uncommitted edits) — cheap; call it after you edit code or when graph_status reports stale. Pass files:[...] to re-index specific paths, or full:true for a from-scratch project-scoped rebuild (the correctness backstop after big refactors/renames).',
  inputSchema: {
    files: z.array(z.string()).optional().describe('Specific files to re-index (project-relative or absolute). Omit to auto-detect changed files.'),
    full: z.boolean().optional().describe('Full project-scoped rebuild instead of incremental (default false).'),
  },
}, async ({ files, full }) => {
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

    // Incremental: explicit files, else auto-detect from git.
    let targets = files;
    let newShas = state?.reposLastSha || {};
    if (!targets || !targets.length) {
      const c = changedSince(PROJECT, state?.reposLastSha || {});
      targets = c.files;
      newShas = { ...newShas, ...c.newShas };
      if (!targets.length) return text('Graph already current — no changed source files detected.');
    }
    await runBuild({ target: PROJECT, project: PROJECT, files: targets });
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
  description: 'Run a read-only SQL SELECT against the graph for structural questions the shaped tools do not cover. Rejected if it is not a single read-only SELECT/WITH. The db holds ONLY this project, so no project filter is needed. Schema — tables: symbols(id,project,repo,file,name,kind,lang,startLine,endLine), files(id,project,repo,path,lang), repos(id,project,name,root), contracts(id,project,name,file), edges(type,src,dst,project,token,cnt,resolution,evidence,direction,contract). edges.type is one of CALLS|DEFINED_IN|REFERENCES|WIRE|IN_REPO; src/dst are node ids — CALLS/WIRE join symbols.id↔symbols.id, DEFINED_IN symbols.id→files.id, REFERENCES symbols.id→contracts.id, IN_REPO files.id→repos.id. Example: SELECT s.repo, count(*) n FROM symbols s WHERE s.kind=\'function\' GROUP BY s.repo.',
  inputSchema: {
    query: z.string().describe('A single read-only SQL SELECT (or WITH … SELECT)'),
  },
}, async ({ query }) => withDb((db) => text(Q.querySql(db, query))));

const transport = new StdioServerTransport();
await server.connect(transport);
