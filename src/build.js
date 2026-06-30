#!/usr/bin/env node
// wiregraph build — walk a folder, extract the call/association graph, load it
// into an embedded SQLite file (no daemon, no JVM).
//
// Usage:
//   node src/build.js [targetDir] [options]
//
// Options:
//   --project <root>    project tag/root to scope nodes under (default: target, realpath)
//   --files <a,b,c>     incremental: re-index only these files (project- or abs-relative),
//                       deleting their prior nodes first; skips a full walk + reset
//   --contracts <dir>   AsyncAPI contracts dir (default: auto-detect a `contracts`,
//                       `asyncapi`, or `*-contracts` dir under the target)
//   --reset             project-scoped wipe before loading (full build only)
//   --db <path>         SQLite file to write (default: <project>/.wiregraph/graph.db,
//                       or $WIREGRAPH_DB)
//   --dump <file>       also write the raw graph as JSON (for inspection)
//   --no-load           skip the SQLite load, just extract (+ optional --dump)

import { writeFileSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { resolve, join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Graph } from './model.js';
import { extractCode } from './extract/index.js';
import { resolveCalls } from './extract/resolve.js';
import { loadContracts, matchContracts, buildWireEdges } from './extract/contracts.js';
import { findRepoRoots, repoNameFor } from './extract/walk.js';
import { connect, loadGraph, loadProjectSymbols, pruneFile } from './store/sqlite.js';
import { wiregraphDir, updateState } from '../scripts/lib/state.mjs';
import { clusterSeams } from './contracts/infer.js';

function parseArgs(argv) {
  const opts = { target: process.cwd(), reset: false, load: true, dump: null, contracts: null, project: null, files: null, db: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reset') opts.reset = true;
    else if (a === '--no-load') opts.load = false;
    else if (a === '--db') opts.db = argv[++i];
    else if (a === '--dump') opts.dump = argv[++i];
    else if (a === '--contracts') opts.contracts = argv[++i];
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--files') opts.files = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else rest.push(a);
  }
  if (rest[0]) opts.target = resolve(rest[0]);
  return opts;
}

const log = (m) => process.stderr.write(m + '\n');

function resolveContractsDir(opts, root) {
  if (opts.contracts) return opts.contracts;
  // Auto-detect an AsyncAPI contracts dir: one named `contracts`/`asyncapi`, or any
  // `*-contracts` dir directly under the target. The cross-repo wire feature only
  // activates if such a dir exists, so projects without one just skip it.
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && (e.name === 'contracts' || e.name === 'asyncapi' || /-contracts$/.test(e.name))) {
        return join(root, e.name);
      }
    }
  } catch { /* unreadable root — skip contracts */ }
  return null;
}

// One db per project, alongside the project's .wiregraph/ state. The MCP server
// resolves the same path, so a build here is immediately queryable there.
export function resolveDbPath(opts, project) {
  return opts.db || process.env.WIREGRAPH_DB || join(wiregraphDir(project), 'graph.db');
}

// --- full build -------------------------------------------------------------
function fullBuild(opts, root, project) {
  log(`wiregraph: scanning ${root} (project ${project})`);
  const graph = new Graph(project);

  log('1/4 extracting code symbols + calls...');
  const { calls, candidates } = extractCode(graph, root, log);

  log('2/4 resolving calls...');
  resolveCalls(graph, calls, log);

  const contractsDir = resolveContractsDir(opts, root);
  if (contractsDir) {
    log(`3/4 loading + matching contracts from ${contractsDir}...`);
    const contracts = loadContracts(graph, contractsDir, log);
    matchContracts(graph, root, contracts, log);
    buildWireEdges(graph, contracts, log);
  } else {
    log('3/4 no contracts dir found — skipping cross-repo wire edges');
  }

  // Persist the cross-repo seam count + detected contracts dir so SessionStart and
  // /wiregraph-status nudge toward /wiregraph-contracts only when there's real,
  // *uncovered* potential (seams found AND no contracts dir present).
  try { updateState(project, { inferredSeams: clusterSeams(candidates).length, contractsDir: contractsDir || null }); }
  catch { /* metadata only — never fail a build over it */ }

  const stats = graph.stats();
  log('graph stats: ' + JSON.stringify(stats, null, 2));

  if (opts.dump) {
    const payload = {
      repos: [...graph.repos.values()], files: [...graph.files.values()],
      symbols: [...graph.symbols.values()], contracts: [...graph.contracts.values()],
      edges: graph.edges, stats,
    };
    writeFileSync(opts.dump, JSON.stringify(payload, null, 2));
    log(`dumped graph JSON -> ${opts.dump}`);
  }

  if (!opts.load) {
    log('4/4 --no-load: skipping SQLite load');
    return;
  }

  const dbPath = resolveDbPath(opts, project);
  log(`4/4 loading into SQLite -> ${dbPath}`);
  const db = connect(dbPath);
  try {
    loadGraph(db, graph, { reset: opts.reset, log });
    log('done.');
  } finally {
    db.close();
  }
}

// --- incremental build ------------------------------------------------------
// Re-index only the given files: delete their prior nodes, extract just them,
// resolve their OUTGOING calls against the whole project (read from the db), then
// reload. Incoming name-based CALLS to a renamed symbol may dangle until a full
// rebuild; WIRE (cross-repo derived) edges are not rebuilt here — both are the
// documented full-rebuild backstop.
function incrementalBuild(opts, root, project) {
  if (!opts.load) throw new Error('--files (incremental) requires a load; remove --no-load');

  // Attribute each changed path to its repo (works for existing AND deleted files).
  const repoRoots = findRepoRoots(root);
  const rootName = basename(root);
  const changed = opts.files.map((f) => {
    const abs = resolve(root, f);
    const { name: repo, root: repoRoot } = repoNameFor(abs, repoRoots, rootName, root);
    return { abs, repo, relPath: relative(repoRoot, abs), exists: existsSync(abs) };
  });
  log(`wiregraph incremental: ${changed.length} file(s) in project ${project}`);

  const dbPath = resolveDbPath(opts, project);
  const db = connect(dbPath);
  try {
    // 1. extract the existing changed files into a fresh graph.
    const present = changed.filter((c) => c.exists);
    const fileFilter = new Set(present.map((c) => c.abs));
    const graph = new Graph(project);
    const { calls } = present.length ? extractCode(graph, root, log, fileFilter) : { calls: [] };

    // 2. resolve outgoing calls against the rest of the project (read from the db).
    if (present.length) {
      // Exclude the changed files' OWN symbols from extraDefs — the fresh graph
      // already holds them. Otherwise a re-indexed file's unchanged symbols appear
      // twice (fresh + stale-in-db) and same-file calls get falsely tagged
      // ~ambiguous against their own duplicate.
      const changedKeys = new Set(changed.map((c) => `${c.repo}\0${c.relPath}`));
      const extraDefs = loadProjectSymbols(db, project).filter((s) => !changedKeys.has(`${s.repo}\0${s.file}`));
      resolveCalls(graph, calls, log, extraDefs);
      const contractsDir = resolveContractsDir(opts, root);
      if (contractsDir) {
        const contracts = loadContracts(graph, contractsDir, log);
        matchContracts(graph, root, contracts, log, fileFilter);
      }
    }

    // 3. prune each changed file: drop vanished symbols + surviving symbols'
    //    outgoing edges, KEEP incoming edges to stable symbols. keepIds is the
    //    set of symbol ids the fresh extraction produced for that file.
    for (const c of changed) {
      const keepIds = [...graph.symbols.values()]
        .filter((s) => s.repo === c.repo && s.file === c.relPath)
        .map((s) => s.id);
      pruneFile(db, project, c.repo, c.relPath, keepIds, log);
    }

    if (!present.length) {
      log('  all changed files were deletions — nodes removed, nothing to reload.');
      return;
    }

    // 4. load (no reset — survivors INSERT-OR-REPLACE; outgoing edges recreated).
    loadGraph(db, graph, { reset: false, log });
    log('incremental done.');
  } finally {
    db.close();
  }
}

// Programmatic entry point — used by the MCP update_graph tool and the hooks so
// they can refresh the graph in-process without shelling out. opts mirrors the
// CLI flags: { target, project?, files?, reset?, contracts?, db?, load?, dump? }.
export async function runBuild(opts = {}) {
  const o = { load: true, reset: false, dump: null, contracts: null, project: null, files: null, db: null, ...opts };
  const root = realpathSync(resolve(o.target));
  const project = o.project ? realpathSync(resolve(o.project)) : root;
  if (o.files && o.files.length) return incrementalBuild(o, root, project);
  return fullBuild(o, root, project);
}

async function main() {
  await runBuild(parseArgs(process.argv.slice(2)));
}

// Only auto-run when invoked directly as a script, not when imported.
const isCli = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((e) => {
    log('ERROR: ' + (e.stack || e.message));
    process.exit(1);
  });
}
