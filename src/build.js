#!/usr/bin/env node
// wiregraph build — walk a folder, extract the call/association graph, load it
// into an embedded SQLite file (no daemon, no JVM).
//
// Usage:
//   node src/build.js [targetDir] [options]
//
// Options:
//   --project <root>    project tag/root to scope nodes under (default: target, realpath)
//   --files <path> [path ...]  incremental: re-index only these files (project- or abs-relative),
//                       deleting their prior nodes first; skips a full walk + reset
//   --contracts <dir>   AsyncAPI contracts dir (default: auto-detect a `contracts`,
//                       `asyncapi`, or `*-contracts` dir under the target)
//   --reset             project-scoped wipe before loading. Implied for every full
//                       build (a full build ALWAYS resets — it is a complete
//                       re-derivation of the union, never additive), so the flag is a
//                       harmless no-op there; only the `--files` incremental path is
//                       additive/surgical and left untouched by it.
//   --db <path>         SQLite file to write (default: <project>/.wiregraph/graph.db,
//                       or $WIREGRAPH_DB)
//   --dump <file>       also write the raw graph as JSON (for inspection)
//   --no-load           skip the SQLite load, just extract (+ optional --dump)

import { writeFileSync, readFileSync, existsSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Graph } from './model.js';
import { extractCode } from './extract/index.js';
import { resolveCalls } from './extract/resolve.js';
import { loadAllContracts, matchContracts, buildWireEdges } from './extract/contracts.js';
import { findCompartmentRoots, compartmentNameFor, walkSources } from './extract/walk.js';
import { connect, loadGraph, loadProjectSymbols, pruneFile, rederiveWireEdges, listIndexedFiles } from './store/sqlite.js';
import { wiregraphDir, updateState, readState, owningMember, graphsListing, memberRoots as memberRootsFromState, registerProject } from '../scripts/lib/state.mjs';
import { migrateMetrics } from '../scripts/lib/metrics.mjs';
import { colorEnabled } from '../scripts/lib/color.mjs';
import { clusterSeams } from './contracts/infer.js';
import { resolveImports } from './contracts/imports.js';

export function parseArgs(argv) {
  const opts = { target: process.cwd(), reset: false, load: true, dump: null, contracts: null, project: null, files: null, db: null, roots: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reset') opts.reset = true;
    else if (a === '--no-load') opts.load = false;
    else if (a === '--db') opts.db = argv[++i];
    else if (a === '--dump') opts.dump = argv[++i];
    else if (a === '--contracts') opts.contracts = argv[++i];
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--root') opts.roots.push(argv[++i]); // repeatable: explicit union override (tests/manual)
    // --files: each following arg is ONE path (a comma delimiter can't represent a path
    // that contains a comma). Consume args until the next --flag.
    else if (a === '--files') {
      opts.files = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) if (argv[++i] !== '') opts.files.push(argv[i]);
    }
    else rest.push(a);
  }
  if (rest[0]) opts.target = resolve(rest[0]);
  return opts;
}

const log = (m) => process.stderr.write(m + '\n');

// Phase progress bars are colored via the shared color policy (color.mjs): color on a
// real TTY (build logs to stderr), plain in the relay/pipes, FORCE_COLOR to override.
// The "N/total label" text is preserved verbatim regardless, so log scanners are safe.
const COLOR_ERR = colorEnabled(false, process.stderr);
function phaseBar(step, total, label) {
  const width = 22;
  const filled = Math.max(0, Math.min(width, Math.round((step / total) * width)));
  const fill = '█'.repeat(filled), rest = '░'.repeat(width - filled);
  const bar = COLOR_ERR ? `\x1b[36m${fill}\x1b[0m\x1b[2m${rest}\x1b[0m` : fill + rest;
  const tag = COLOR_ERR ? `\x1b[1m${step}/${total}\x1b[0m` : `${step}/${total}`;
  return `  [${bar}] ${tag} ${label}`;
}

// A directory name that marks a contracts home: `contracts`/`asyncapi` (any case),
// or any `*-contracts` dir. Matched case-insensitively.
const CONTRACTS_DIR_NAME = /^(contracts|asyncapi)$/i;
function isContractsDirName(name) {
  return CONTRACTS_DIR_NAME.test(name) || /-contracts$/i.test(name);
}

// Does `dir` DIRECTLY contain at least one AsyncAPI spec file? (Lets a standalone
// `payments-contracts/` repo whose specs sit at its top level be discovered as its
// own contracts home, not just via a nested contracts/ child.)
function hasTopLevelSpec(dir) {
  try {
    for (const f of readdirSync(dir)) if (/\.asyncapi\.ya?ml$/i.test(f)) return true;
  } catch { /* unreadable */ }
  return false;
}

// Auto-detect the AsyncAPI contracts dirs for `root`, returning ALL matches deduped
// (a root with both contracts/ and api-contracts/ loads BOTH, deterministically):
//   - `root` ITSELF when its basename looks like a contracts dir, or it directly
//     holds *.asyncapi.y(a)ml files (a standalone *-contracts repo linked in);
//   - every CHILD dir whose name looks like a contracts dir — matched
//     case-insensitively and following a symlink-to-dir.
// The cross-compartment wire feature only activates if at least one exists, so
// projects without any just skip it.
export function detectContractsDirs(root) {
  const dirs = [];
  const seen = new Set();
  const add = (p) => { if (!seen.has(p)) { seen.add(p); dirs.push(p); } };

  if (isContractsDirName(basename(root)) || hasTopLevelSpec(root)) add(root);

  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!isContractsDirName(e.name)) continue;
      const full = join(root, e.name);
      // A plain dir counts; so does a symlink that RESOLVES to a dir (isDirectory()
      // is false for a symlink-to-dir, so stat the target explicitly).
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try { isDir = statSync(full).isDirectory(); } catch { isDir = false; }
      }
      if (isDir) add(full);
    }
  } catch { /* unreadable root — skip contracts */ }

  return dirs;
}

// Ordered LIST of contract dirs for a full build over the union: each member's own
// hand-written contracts dir(s), then this graph's out-of-source inferred/ dir.
// Order is own-root-first, then members, then inferred — a hand-written spec always
// precedes the auto-inferred one. Deduped. The inferred dir is written by
// link/unlink's infer-to-disk phase (fullBuild only MATCHES on-disk specs).
function resolveContractsDirs(opts, roots, project) {
  if (opts.contracts) return [opts.contracts];
  const dirs = [];
  const seen = new Set();
  const add = (d) => { if (!seen.has(d)) { seen.add(d); dirs.push(d); } };
  for (const root of roots) for (const d of detectContractsDirs(root)) add(d);
  const inferred = join(wiregraphDir(project), 'inferred');
  if (existsSync(inferred)) add(inferred);
  return dirs;
}

// The union of roots a full build walks for `project`: an explicit --root override
// (tests/manual) wins; otherwise the graph's own root ∪ its linked members, read
// from state. Non-existent members are dropped (with a warning) by the state layer.
function memberRoots(project, opts = {}) {
  if (opts.roots && opts.roots.length) {
    const out = [];
    const seen = new Set();
    const push = (p) => {
      let r; try { r = realpathSync(resolve(p)); } catch { r = null; }
      if (r && !seen.has(r)) { seen.add(r); out.push(r); }
    };
    push(project);
    for (const r of opts.roots) push(r);
    return out;
  }
  return memberRootsFromState(project);
}

// One db per project, alongside the project's .wiregraph/ state. The MCP server
// resolves the same path, so a build here is immediately queryable there.
export function resolveDbPath(opts, project) {
  return opts.db || process.env.WIREGRAPH_DB || join(wiregraphDir(project), 'graph.db');
}

// --- full build -------------------------------------------------------------
// `roots` is the UNION this graph indexes (own root ∪ linked members). Every root
// is walked into ONE Graph under a single project tag; ids are project-free so
// members merge cleanly. Contracts are loaded from an ordered list of dirs and
// matched against EACH member root (so both the producer- and consumer-side
// REFERENCES a WIRE edge needs get minted), then buildWireEdges runs once.
function fullBuild(opts, roots, project) {
  log(`wiregraph: scanning ${roots.join(', ')} (project ${project})`);
  const graph = new Graph(project);

  log(phaseBar(1, 4, 'extracting code symbols + calls...'));
  const calls = [];
  const candidates = [];
  for (const r of roots) {
    const res = extractCode(graph, r, log);
    calls.push(...res.calls);
    candidates.push(...res.candidates);
  }

  log(phaseBar(2, 4, 'resolving calls...'));
  resolveCalls(graph, calls, log);

  const contractsDirs = resolveContractsDirs(opts, roots, project);
  if (contractsDirs.length) {
    log(phaseBar(3, 4, `loading + matching contracts from ${contractsDirs.join(', ')}...`));
    const contracts = loadAllContracts(graph, contractsDirs, log);
    for (const r of roots) matchContracts(graph, r, contracts, log);
    buildWireEdges(graph, contracts, log);
  } else {
    log(phaseBar(3, 4, 'no contracts dir found — skipping cross-compartment wire edges'));
  }

  // Cross-compartment library/SDK boundaries: resolve import specifiers into
  // IMPORTS edges (explicit deps, so safe to link across compartments — unlike
  // name-based calls).
  const importEdges = resolveImports(candidates, graph);
  for (const e of importEdges) graph.addEdge('IMPORTS', e.from, e.to, { evidence: 'import' });
  if (importEdges.length) log(`  resolved ${importEdges.length} cross-compartment IMPORTS edge(s)`);

  // Persist the cross-compartment seam count + detected contracts dir so SessionStart and
  // /wiregraph-status nudge toward /wiregraph-contracts only when there's real,
  // *uncovered* potential (seams found AND no HAND-WRITTEN contracts dir present).
  // The out-of-source inferred/ dir is deliberately excluded here: it is our own
  // synthesized output, not user-authored coverage, so its presence must not silence
  // the nudge. candidates already span every member root, so the seam count is union-wide.
  const handWritten = opts.contracts || roots.flatMap(detectContractsDirs)[0] || null;
  try { updateState(project, { inferredSeams: clusterSeams(candidates).length, contractsDir: handWritten, structuralDriftSinceFullBuild: false, seamStaleSinceInference: false }); }
  catch { /* metadata only — never fail a build over it */ }

  const stats = graph.stats();
  log('graph stats: ' + JSON.stringify(stats, null, 2));

  if (opts.dump) {
    const payload = {
      compartments: [...graph.compartments.values()], files: [...graph.files.values()],
      symbols: [...graph.symbols.values()], contracts: [...graph.contracts.values()],
      edges: graph.edges, stats,
    };
    writeFileSync(opts.dump, JSON.stringify(payload, null, 2));
    log(`dumped graph JSON -> ${opts.dump}`);
  }

  if (!opts.load) {
    log(phaseBar(4, 4, '--no-load: skipping SQLite load'));
    return;
  }

  const dbPath = resolveDbPath(opts, project);
  log(phaseBar(4, 4, `loading into SQLite -> ${dbPath}`));
  const db = connect(dbPath);
  try {
    // opts.allowReducedUnion opts OUT of the member-losing-reset backstop: unlink sets
    // it for its INTENTIONAL reduced rebuild (peer still recorded but deliberately
    // excluded from the union, so records can be retracted only after both rebuilds
    // succeed). A bare --root override without it (a stray narrow reset) is still caught.
    loadGraph(db, graph, { reset: opts.reset, log, allowReducedUnion: !!opts.allowReducedUnion });
    log(COLOR_ERR ? '\x1b[1m\x1b[32m✓ done.\x1b[0m' : 'done.');
  } finally {
    db.close();
  }
}

// --- incremental build ------------------------------------------------------
// Re-index only the given files: delete their prior nodes, extract just them,
// resolve their OUTGOING calls against the whole project (read from the db), then
// reload. Incoming name-based CALLS to a renamed symbol may dangle until a full
// rebuild; WIRE (cross-compartment derived) edges are not rebuilt here — both are
// the documented full-rebuild backstop.
function incrementalBuild(opts, root, project) {
  if (!opts.load) throw new Error('--files (incremental) requires a load; remove --no-load');

  // Attribute each changed path to the MEMBER root that owns it (longest-prefix
  // match over the union), then to its compartment within that owner — so a file
  // under a linked member is attributed with the member's own boundaries/basename,
  // matching that member's full build. Works for existing AND deleted files.
  const roots = memberRoots(project, opts);
  const infoCache = new Map();
  const infoFor = (r) => {
    if (!infoCache.has(r)) infoCache.set(r, { compartmentRoots: findCompartmentRoots(r), rootName: basename(r) });
    return infoCache.get(r);
  };
  const ownerOf = (abs) => {
    let best = null;
    for (const r of roots) if (abs === r || abs.startsWith(r + sep)) { if (!best || r.length > best.length) best = r; }
    return best || root;
  };
  const changed = opts.files.map((f) => {
    const abs = resolve(root, f);
    const owner = ownerOf(abs);
    const { compartmentRoots, rootName } = infoFor(owner);
    const { name: compartment, root: compartmentRoot } = compartmentNameFor(abs, compartmentRoots, rootName, owner);
    return { abs, owner, compartment, relPath: relative(compartmentRoot, abs), exists: existsSync(abs) };
  });
  log(`wiregraph incremental: ${changed.length} file(s) in project ${project}`);

  const dbPath = resolveDbPath(opts, project);
  const db = connect(dbPath);
  // The in-memory db becomes durable only at close(). pruneFile commits its deletes
  // in-memory BEFORE the reload; if anything between the prunes and the end of the
  // body throws (e.g. loadGraph's newer-schema guard), persisting would write the
  // pruned-but-not-reloaded db over the good file — the edited files' symbols/edges
  // would be lost until a full rebuild (M6). So persist ONLY on success: this flag
  // flips true as the last statement of the try, and any earlier throw leaves it
  // false → close(persist:false) discards the mutations and re-raises.
  let ok = false;
  try {
    // 1. extract the existing changed files into a fresh graph. Walk each OWNER root
    //    that actually holds a present changed file (with the abs-path filter), so a
    //    file under a linked member is extracted with that member's own compartment
    //    boundaries — the same walk its full build uses.
    const present = changed.filter((c) => c.exists);
    const fileFilter = new Set(present.map((c) => c.abs));
    // The MEMBER roots that actually own a present changed file — reused for both the
    // extraction walk and the contract re-match below, so both see the same union a
    // full build would.
    const owners = new Set(present.map((c) => c.owner));
    const graph = new Graph(project);
    let structuralDrift = false;
    const calls = [];

    // Contract wiring is resolved ONCE up front (not just inside the present branch)
    // so both the WIRE re-derive (Change 1) and the seam-staleness flag (Change 2) can
    // see it even on a deletion-only update. `contracts` is the merged set matchContracts
    // used, reused by the re-derive so orientation matches a full build.
    const contractsDirs = resolveContractsDirs(opts, roots, project);
    let contracts = null;
    // Compartments this update touched, and a reader for the compartments that CURRENTLY
    // reference a contract in the db — used by Change 2's contract-relevance heuristic.
    const changedCompartments = new Set(changed.map((c) => c.compartment));
    const refCompartmentsInDb = () => new Set(
      db.prepare("SELECT DISTINCT s.compartment comp FROM edges e JOIN symbols s ON s.id = e.src WHERE e.project = ? AND e.type = 'REFERENCES'")
        .all(project).map((r) => r.comp),
    );
    if (present.length) {
      for (const r of roots) {
        if (!owners.has(r)) continue;
        const res = extractCode(graph, r, log, fileFilter);
        calls.push(...res.calls);
      }
    }

    // 2. resolve outgoing calls against the rest of the project (read from the db).
    if (present.length) {
      // Exclude the changed files' OWN symbols from extraDefs — the fresh graph
      // already holds them. Otherwise a re-indexed file's unchanged symbols appear
      // twice (fresh + stale-in-db) and same-file calls get falsely tagged
      // ~ambiguous against their own duplicate.
      const changedKeys = new Set(changed.map((c) => `${c.compartment}\0${c.relPath}`));
      const allPrior = loadProjectSymbols(db, project);
      const extraDefs = allPrior.filter((s) => !changedKeys.has(`${s.compartment}\0${s.file}`));
      resolveCalls(graph, calls, log, extraDefs);
      // Load contracts over the SAME union a full build uses (every member root's
      // hand-written dir + this graph's out-of-source inferred/ dir) — NOT just this
      // root's own dir. pruneFile drops an edited symbol's REFERENCES; if we re-matched
      // against a narrower set, a body-only edit to a producer would fail to re-mint its
      // REFERENCES to the inferred/sibling-member contract, silently dropping the
      // cross-repo seam until a full rebuild (M1). Re-match on each OWNER root that holds
      // a changed file, mirroring fullBuild's per-root matchContracts. (WIRE is NOT
      // re-derived here — that stays a full-rebuild backstop; only REFERENCES are
      // restored.)
      if (contractsDirs.length) {
        contracts = loadAllContracts(graph, contractsDirs, log);
        for (const r of owners) matchContracts(graph, r, contracts, log, fileFilter);
      }
      // Structural drift: did this update change the symbol NAME-set (add / remove /
      // rename) rather than only edit a body? If so, callers resolved by name in
      // UNCHANGED files may be approximate until the next full rebuild.
      // Compare only real symbols: loadProjectSymbols (priorNames) excludes the
      // synthetic <module> symbol, so freshNames must too — otherwise the module
      // entry is always "new" and a pure body edit falsely reads as drift, nagging
      // "run rebuild" after every incremental update.
      const priorNames = new Set(allPrior.filter((s) => changedKeys.has(`${s.compartment}\0${s.file}`)).map((s) => `${s.compartment}\0${s.file}\0${s.name}`));
      const freshNames = new Set([...graph.symbols.values()].filter((s) => s.kind !== 'module').map((s) => `${s.compartment}\0${s.file}\0${s.name}`));
      structuralDrift = priorNames.size !== freshNames.size || [...freshNames].some((k) => !priorNames.has(k));
    }

    // Contract-relevance for Change 2 is "has OR had REFERENCES", so snapshot the
    // referencing compartments BEFORE the prune (a route REMOVED by this edit is still
    // visible here); it's unioned with the post-reload snapshot below (a route ADDED).
    const priorRefComps = refCompartmentsInDb();

    // 3. prune each changed file: drop vanished symbols + surviving symbols'
    //    outgoing edges, KEEP incoming edges to stable symbols. keepIds is the
    //    set of symbol ids the fresh extraction produced for that file.
    for (const c of changed) {
      const keepIds = [...graph.symbols.values()]
        .filter((s) => s.compartment === c.compartment && s.file === c.relPath)
        .map((s) => s.id);
      pruneFile(db, project, c.compartment, c.relPath, keepIds, log);
    }

    // 4. load (no reset — survivors INSERT-OR-REPLACE; outgoing edges recreated).
    if (present.length) {
      loadGraph(db, graph, { reset: false, log });
      log('incremental done.');
    } else {
      log('  all changed files were deletions — nodes removed, nothing to reload.');
      structuralDrift = true; // removing symbols is a structural change
    }

    // Change 1: re-derive the WIRE seam from the now-fresh db REFERENCES. pruneFile just
    // deleted every WIRE touching a changed/surviving symbol; without this the producer
    // -side seam stays dark in export/visualize until a full rebuild. This reads only the
    // db (no source re-parse) and is ROBUST: any failure logs and degrades to the old
    // seam-dark behavior — it must never break the incremental update or a self-healing
    // read. (On a deletion-only update, contracts weren't loaded above, so load them now
    // via a throwaway graph — only the merged contract objects are needed here.)
    if (contractsDirs.length) {
      try {
        if (!contracts) contracts = loadAllContracts(new Graph(project), contractsDirs, log);
        rederiveWireEdges(db, project, contracts, log);
      } catch (e) {
        log(`  WIRE re-derive failed (${e.message}); seam left dark until a full rebuild`);
      }
    }

    // Honesty: record structural drift so graph_status stops reporting a flat
    // "fresh" when cross-file caller edges may be stale — a full rebuild reconciles.
    if (structuralDrift) {
      const patch = { structuralDriftSinceFullBuild: true };
      // Change 2 — seam-inference staleness. Set ONLY when the update BOTH changed the
      // symbol name-set (structuralDrift, so a pure body edit never nags) AND touched a
      // compartment that participates in the contract seam (has/had REFERENCES). That
      // signals a route may have been added/removed — but the INFERRED spec is
      // regenerated only by a full rebuild, so flag it to keep trace_contract/graph_status
      // honest. Conservative by construction: no drift ⇒ no flag; no contract-touching
      // compartment ⇒ no flag.
      if (contractsDirs.length) {
        const seamComps = new Set([...priorRefComps, ...refCompartmentsInDb()]);
        if ([...changedCompartments].some((c) => seamComps.has(c))) patch.seamStaleSinceInference = true;
      }
      try { updateState(project, patch); }
      catch { /* metadata only — never fail an update over it */ }
    }
    ok = true; // whole incremental completed — safe to persist the mutations
  } finally {
    db.close({ persist: ok });
  }
}

// Programmatic entry point — used by the MCP update_graph tool and the hooks so
// they can refresh the graph in-process without shelling out. opts mirrors the
// CLI flags: { target, project?, files?, reset?, contracts?, db?, load?, dump? }.
export async function runBuild(opts = {}) {
  const o = { load: true, reset: false, dump: null, contracts: null, project: null, files: null, db: null, ...opts };
  const root = realpathSync(resolve(o.target));
  const project = o.project ? realpathSync(resolve(o.project)) : root;
  // Soft metrics migration (CHANGE B). runBuild is the funnel for /wiregraph-init,
  // -build, -rebuild and -update, so a user who updates and rebuilds (rather than
  // starting a fresh session) still gets their pre-v2 log archived exactly once.
  // Version-gated + idempotent + best-effort: a no-op once at METRICS_VERSION, and it
  // never throws (a failed migration must not break a build). A brand-new init has no
  // state yet ⇒ migrateMetrics no-ops here, and once state is seeded defaultState stamps
  // the current version, so a fresh install never migrates an empty log.
  try { migrateMetrics(project); } catch { /* best-effort */ }
  // Record this graph root in the global registry so /wiregraph-stats aggregates it
  // WITHOUT a filesystem scan. Runs on every build (full AND incremental) so a project
  // indexed before this feature self-registers on its first edit/use — no rescan, no
  // manual step. registerProject writes only when the root is new, so the steady state
  // is a cheap read. Best-effort — a registry write must never fail a build.
  try { registerProject(project); } catch { /* best-effort */ }
  if (o.files && o.files.length) return incrementalBuild(o, root, project);
  // A full (non-`files`) build is a COMPLETE re-derivation of the whole union, so it
  // must always reset: loadGraph upserts nodes idempotently but INSERTs edges (deduped
  // only within a batch), so accumulating a full build on top of existing rows would
  // re-insert every edge additively — doubling counts on the 2nd run, tripling on the
  // 3rd (M7). Force reset here regardless of --reset; the incremental (`--files`) path
  // above legitimately keeps reset:false + per-file prune. (unlink's reduced-union
  // rebuild already passes reset:true + allowReducedUnion:true, so it's unaffected.)
  o.reset = true;
  // Every reset/full build funnels here, so the union walk is the single source of
  // truth: a stray single-root rebuild can't silently drop linked members.
  const roots = memberRoots(project, o);
  return fullBuild(o, roots, project);
}

// --- edit-sync primitive ----------------------------------------------------
// The single entry point every incremental edit-sync path funnels through (the
// MCP self-heal, update_graph incremental, and the refresh.mjs hooks). Attributes
// each changed file to the MEMBER root that owns it, then re-indexes it into the
// right graph(s):
//   1. group `files` by owningMember(abs, editingProject); files under no member
//      are dropped (an edit outside every indexed root is not ours to index);
//   2. for each owning member M, the target graphs are M's own graph plus every
//      graph linked to M when fanOut is set (graphsListing(M) — a fully-local
//      symmetric reverse index), else just the editing graph;
//   3. re-index into each target G sequentially (distinct dbs; sequential avoids
//      two writers racing the same peer db), skipping only a graph whose posture
//      is 'off'. `target: M` makes attribution use M's own compartment boundaries
//      (matching M's full build); `project: G` tags the rows and picks G's db.
// Files MUST be absolute. Returns the set of graph roots that were rebuilt.
export async function reindexFiles(files, editingProject, { fanOut = false } = {}) {
  const byMember = new Map();
  for (const f of files || []) {
    const abs = resolve(f);
    const m = owningMember(abs, editingProject);
    if (!m) continue;
    if (!byMember.has(m)) byMember.set(m, []);
    byMember.get(m).push(abs);
  }
  const rebuilt = new Set();
  for (const [m, filesForM] of byMember) {
    const targets = fanOut ? graphsListing(m) : [editingProject];
    for (const G of targets) {
      // The 'off' posture opts a graph out of edits FANNED IN from other graphs — it
      // must NOT gag the explicit editing target itself. An update_graph / read-time
      // self-heal on an 'off' project is a first-party request for THIS graph and is
      // always honored; only peers (G !== editingProject) are skipped when opted out.
      // Skipping the editing target here would index nothing yet still let the caller
      // advance reposLastSha and report success — a permanently-missed change.
      if (G !== editingProject && readState(G)?.autoUpdate === 'off') continue;
      await runBuild({ target: m, project: G, files: filesForM });
      rebuilt.add(G);
    }
  }
  return [...rebuilt];
}

// --- invalid-baseline content reconcile -------------------------------------
// After a history rewrite (amend/rebase) whose orphaned commit was pruned by `git
// gc`, a repo's stored baseline sha is no longer reachable, so `git diff last..HEAD`
// fails and the last..HEAD file list is UNKNOWABLE. changedSince flags such a repo in
// `invalidBaselineRepos`. The old behavior tore down and rebuilt the ENTIRE project
// (all repos AND linked members) — a massive, needless rebuild that recurred on every
// rebase+gc cycle, firing even when a message-only `git commit --amend` never touched a
// working-tree file.
//
// This computes the MINIMAL reconcile for ONE repo WITHOUT any git diff: the working
// tree already reflects the new HEAD, and the store recorded each file's on-disk
// mtime+size AND a content hash at index time (schema v2/v5), so "what changed" is
// precisely "the working tree differs from what was indexed". We walk the repo's current
// sources and return the abs paths that are NEW / DIFFER (reindex) or VANISHED (prune):
//   - mtime OR size differs from the recorded stamp → DIFFERS, reindex (no hashing — a
//     stamp mismatch already proves a change);
//   - mtime AND size MATCH → the FAST path says "probably unchanged", but that alone
//     MISSES a same-size, mtime-PRESERVED edit (cp -p / rsync -a / tar / a coarse-mtime
//     FAT/exFAT/NFS clock — MED-2). So CONFIRM the match by content: hash the on-disk
//     file and compare to the recorded hash. Differ → reindex; equal → trust (the
//     message-only-amend no-op stays a no-op). A NULL recorded hash (a pre-v5 / unstamped
//     row) can't confirm → reindex (superset-safe).
// This never UNDER-reports a real change (correctness); a message-only amend leaves every
// file byte-identical → hashes match → an empty set → a true content no-op. Only THIS
// repo's files are considered (compartment root under repoRoot), so sibling repos/members
// stay untouched.
//
// Returns { ok, files }. ok:false means the store lacks a usable stamp for this repo's
// files (e.g. a pre-v2 db, or none populated) — the caller MUST fall back to a full
// rebuild rather than risk silently dropping a committed change (safety over
// cleverness). files is the abs paths to hand to reindexFiles (which routes a
// no-longer-existing path through pruneFile, deleting the vanished file's nodes).
export function reconcileRepoByContent(repoRoot, project) {
  const root = (() => { try { return realpathSync(repoRoot); } catch { return repoRoot; } })();
  const dbPath = resolveDbPath({}, project);
  if (!existsSync(dbPath)) return { ok: false, files: [] };

  // Recorded stamps for files under THIS repo, keyed by reconstructed abs path.
  const db = connect(dbPath, { readonly: true });
  let indexed;
  try { indexed = listIndexedFiles(db, project); } finally { db.close(); }
  const recorded = new Map();
  let anyStamped = false;
  for (const r of indexed) {
    const abs = join(r.root, r.path);
    if (abs !== root && !abs.startsWith(root + sep)) continue; // sibling repo/member — leave it alone
    recorded.set(abs, { mtime: r.mtime, size: r.size, hash: r.hash });
    if (r.mtime != null && r.size != null) anyStamped = true;
  }
  // No usable stamp on ANY of this repo's indexed files → we cannot compare by content.
  // Fall back to the full rebuild. (A repo with NO indexed files at all is fine: every
  // on-disk file below reads as "new" and gets reindexed.)
  if (recorded.size && !anyStamped) return { ok: false, files: [] };

  const files = new Set();
  const onDisk = new Set();
  for (const f of walkSources(root)) {
    onDisk.add(f.abs);
    let mtime = null, size = null;
    try { const st = statSync(f.abs); mtime = st.mtimeMs; size = st.size; } catch { /* unreadable → treat as differing, reindex */ }
    const rec = recorded.get(f.abs);
    // NEW file (never indexed) or any mtime/size divergence → reindex outright (no hashing;
    // a stamp mismatch already proves a change). A null recorded stamp counts as "differs"
    // so a partially-stamped repo still reconciles correctly.
    if (!rec || rec.mtime == null || rec.size == null || rec.mtime !== mtime || rec.size !== size) {
      files.add(f.abs);
      continue;
    }
    // mtime+size MATCH — the "probably unchanged" FAST path. Confirm by CONTENT so a
    // same-size, mtime-preserved edit is still caught (MED-2). Hash the on-disk file and
    // compare to the recorded hash: a NULL recorded hash (pre-v5 / unstamped) can't confirm
    // → reindex; a read failure can't confirm → reindex; a mismatch → reindex; equal →
    // trust (keeps the message-only-amend no-op a no-op). Only matched candidates are
    // hashed, so the steady-state cost is one hash per still-present file.
    // Hash the SAME representation the extractor stamped (the utf8 string it parses), so
    // an unchanged file's on-disk hash matches its recorded hash byte-for-byte.
    let onDiskHash = null;
    try { onDiskHash = createHash('sha1').update(readFileSync(f.abs, 'utf8')).digest('hex'); } catch { /* unreadable → reindex */ }
    if (rec.hash == null || onDiskHash == null || rec.hash !== onDiskHash) files.add(f.abs);
  }
  // VANISHED: recorded under this repo but gone from disk → prune.
  for (const abs of recorded.keys()) if (!onDisk.has(abs)) files.add(abs);

  return { ok: true, files: [...files] };
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
