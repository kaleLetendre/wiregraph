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

import { writeFileSync, readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Graph } from './model.js';
import { extractCode } from './extract/index.js';
import { resolveCalls } from './extract/resolve.js';
import { loadAllContracts, matchContracts, buildWireEdges, buildResourceEdges, buildInprocEdges, constDefIndex, handWrittenTokens } from './extract/contracts.js';
import { compartmentNameFor, walkSources } from './extract/walk.js';
import { detectContractsDirs, rootContractsEntries, contractsDirSpecs } from './contracts-dirs.js';
import { connect, loadGraph, loadProjectSymbols, pruneFile, rederiveWireEdges, listIndexedFiles } from './store/sqlite.js';
import { wiregraphDir, updateState, readState, owningMember, graphsListing, memberRoots as memberRootsFromState, registerProject, compartmentsFingerprint, compartmentsDrift, stampCompartmentsFingerprint, compartmentPartition, contractsFingerprint, contractsDrift, stampContractsFingerprint, isRecursiveMode, splitWarningBlocks, recordBuildWarnings } from '../scripts/lib/state.mjs';
import { migrateMetrics } from '../scripts/lib/metrics.mjs';
import { colorEnabled } from '../scripts/lib/color.mjs';
import { clusterSeams, clusterResourceSeams } from './contracts/infer.js';
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

// --- CONTENT-DROPPING WARNINGS MUST SURVIVE EVERY BUILD PATH -------------------
// Every warning the build emits is a bare `process.stderr.write` several call frames down
// (src/extract/contracts.js, src/extract/walk.js), and on the hook path that stream is a log
// nobody reads. A tee of THIS PROCESS's stderr catches all of them in-process, wherever they
// are raised, with no plumbing through five signatures — and it keeps working for warnings
// added later, because it keys on the markers the build already uses.
//
// IT LIVES HERE, NOT IN THE HOOK, AND THAT IS THE FIX. It used to be installed only by
// scripts/hooks/refresh.mjs, so `update_graph {full:true}` (what /wiregraph-rebuild prefers)
// and `node src/build.js --reset` (what /wiregraph-init runs) recorded NOTHING: a build that
// dropped an entire contract left no trace, and graph_status then rendered warnings from a
// DIFFERENT, OLDER build captioned as the current one. runBuild is the funnel every build
// path goes through, so installing it here reaches all of them at once.
//
// Installation is IDEMPOTENT and the tee always passes the chunk through to the original
// write, so importing this module never changes what anything prints. refresh.mjs installs
// it EARLY (before its own discovery walk) because walk.js memoizes its warnings per
// process: a collision warning raised while comparing fingerprints is not re-emitted inside
// the build that follows, and a capture that started at the build would miss it.
//
// The accumulator is DRAINED per build (not per process): each build records the blocks
// emitted since the previous one — which correctly includes the discovery walk that preceded
// it — so nothing accumulates across a long-lived process and one project's warning can
// never be persisted into another's state.
let _warnOrig = null;
let _warnPending = '';
let _warnBlocks = [];
const _warnSinks = new Set();

export function installBuildWarningCapture() {
  if (_warnOrig) return;
  _warnOrig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, enc, cb) => {
    try {
      _warnPending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      const lines = _warnPending.split('\n');
      _warnPending = lines.pop(); // the trailing partial line stays buffered
      for (const b of splitWarningBlocks(lines)) _warnBlocks.push(b);
    } catch { /* capture must NEVER break or drop the underlying write */ }
    return _warnOrig(chunk, enc, cb);
  };
}

// Take everything captured since the last drain, flushing any buffered partial line.
export function drainBuildWarnings() {
  try {
    if (_warnPending) { for (const b of splitWarningBlocks([_warnPending])) _warnBlocks.push(b); _warnPending = ''; }
  } catch { /* best-effort */ }
  const out = _warnBlocks;
  _warnBlocks = [];
  return out;
}

// Observers of each build's captured blocks — refresh.mjs registers one so refresh.log keeps
// its per-run, per-warning truth (state holds only a replaceable snapshot).
export function onBuildWarnings(fn) {
  _warnSinks.add(fn);
  return () => _warnSinks.delete(fn);
}

// Test seam: forget the capture entirely (used by test/run.mjs so one case's warnings cannot
// leak into the next). Restores the original stderr.write.
export function __resetBuildWarningCapture() {
  if (_warnOrig) { process.stderr.write = _warnOrig; _warnOrig = null; }
  _warnPending = '';
  _warnBlocks = [];
  _warnSinks.clear();
}

function flushBuildWarnings(project, kind, complete) {
  const blocks = drainBuildWarnings();
  for (const fn of _warnSinks) { try { fn(blocks, { project, kind, complete }); } catch { /* a sink must not fail a build */ } }
  try { recordBuildWarnings(project, kind, blocks, { complete }); } catch { /* persistence is best-effort */ }
}

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

// detectContractsDirs / isContractsDirName / hasTopLevelSpec now live in
// src/contracts-dirs.js — ONE copy, shared with scripts/contracts.mjs (which used to
// carry a hand-synced duplicate) and scripts/lib/compartments.mjs. Re-exported here
// because this module's path is the one every caller already imports it from.
export { detectContractsDirs };

// --- contracts-dir discovery, per walked root --------------------------------
// Mode is read from the WALKED ROOT's own state.json, never from the editing project —
// the same rule findCompartmentRoots follows (src/extract/walk.js), and for the same
// reason: a linked member is indexed with ITS OWN boundaries so an incremental matches
// that member's full build. A global-mode member linked into a recursive-mode graph
// therefore keeps depth-1 discovery and unscoped matching.
//
// SCOPED TO ONE runBuild CALL, NEVER TO THE PROCESS. This used to be a pair of
// module-level Maps keyed by root alone, never invalidated, living for the whole process
// — and the MCP server IS a long-lived process that calls runBuild({reset:true}) over and
// over (src/mcp/server.js), which is the path /wiregraph-rebuild explicitly prefers. The
// consequence was that a contracts dir CREATED between two builds in that process was
// invisible to the second one: `/wiregraph-contracts apply` created `<root>/contracts/`,
// the follow-up full rebuild still reported zero contracts and zero seams, `contractsDir`
// stayed null, the SessionStart nudge kept firing, and the stale list was PERSISTED. The
// comments claiming a full build "always walks live" were false — every path went through
// the memo; only the (now removed) disk cache was gated. A per-CALL context keeps the
// reason the memo existed (fullBuild resolves the dirs for loading, for the state stamp
// and for the fingerprint — one walk, not three) with none of the staleness.
//
// SCOPED TO ONE SAVE, NOT ONE runBuild, WHEN THE CALLER PASSES ONE IN. The post-edit hook
// resolved the set TWICE per save otherwise: healPartitionDrift compares the fingerprint
// (a live walk), then incrementalBuild — one function call later, in the SAME process —
// built a fresh context and walked again, neither sharing the other's memo. Measured at
// ~38ms per walk on a 4,300-directory tree, i.e. ~76ms per save, about 2.6x the per-edit
// regression Phase 0 rejected as unacceptable. refresh.mjs now creates ONE context and
// threads it through reindexFiles into the incremental. It stays a CONTEXT, not a cache:
// it lives for one hook invocation and dies with it. A cross-process cache cannot answer
// "did this change?" — only the stamp can — which is why the disk cache was correctly
// deleted rather than repaired.
//
// IT CARRIES THE COMPARTMENT PARTITION TOO. Phase 3 built this context for the CONTRACTS
// partition and left the COMPARTMENTS partition — the older of the two, and the one whose
// resolution is the more expensive — with no memoization at all. A single save resolved it
// about five times: healPartitionDrift's comparison, incrementalBuild's refusal check,
// infoFor's attribution, and both walkSources passes. Resolving a declaration re-validates
// every declared path against disk (~10.8ms on a large tree), and resolving an INFERRED
// partition — now that global mode is fingerprinted too, which is the whole point of that
// fix — is a full boundary walk. One memo per save, exactly like the contracts half.
export function discoveryContext() {
  const modes = new Map();
  const entries = new Map();
  const specs = new Map();
  const partitions = new Map();
  const recursive = (root) => {
    if (!modes.has(root)) {
      let v = false;
      try { v = isRecursiveMode(readState(root)); } catch { v = false; }
      modes.set(root, v);
    }
    return modes.get(root);
  };
  const key = (root) => `${recursive(root) ? 'R' : 'G'}\0${root}`;
  const ctx = {
    recursive,
    // `{ dir, scopeRoot }[]` for one root — the shared rule in src/contracts-dirs.js, so
    // the build and the fingerprint can never disagree about what governs what.
    entries(root) {
      const k = key(root);
      if (!entries.has(k)) entries.set(k, rootContractsEntries(root, recursive(root)));
      return entries.get(k);
    },
    // `{ spec, scopeRoot, digest }[]` for one root — what the FINGERPRINT hashes. Built
    // from the entries above rather than by re-walking, so the walk really is once per
    // context, and the spec reads (a readdir + a readFile per spec, on a handful of small
    // files) happen once too.
    specs(root) {
      const k = key(root);
      if (!specs.has(k)) specs.set(k, ctx.entries(root).flatMap(contractsDirSpecs));
      return specs.get(k);
    },
    // `{ declared, value, roots }` for one root — the COMPARTMENT partition in force:
    // what the fingerprint hashes AND the `[{dir,name}]` list attribution uses, from ONE
    // resolution, so the guard and the walk can never disagree about what the partition is.
    compartments(root) {
      if (!partitions.has(root)) partitions.set(root, compartmentPartition(root));
      return partitions.get(root);
    },
  };
  return ctx;
}

// THERE IS NO CROSS-PROCESS DISCOVERY CACHE ANY MORE, deliberately. Phase 3 shipped a
// `.wiregraph/contracts-dirs.json` written by the full build and reused by the save loop,
// to spare the incremental path a live recursive walk (measured at ~34ms on a 3,900
// -directory tree). The contracts-dir FINGERPRINT (scripts/lib/state.mjs) makes it dead
// weight: the incremental now has to resolve the dir set LIVE anyway, to compare it against
// what the last full build stamped — a cache read cannot answer "did this change?", it can
// only answer with the stamp itself. One live walk per save, its result memoized for the
// rest of that build, is therefore the whole cost, and it replaces a cache whose staleness
// signal (an existsSync per cached dir) was vacuous on the exact sequence that broke
// scoping: a delete+add — i.e. a MOVE — passed the guard and fed the save loop the OLD
// scopes. Removing it also removes a bare writeFileSync into the one directory with a
// documented torn-write incident, and a `[].every(existsSync)` that cached "no contracts
// dirs" as authoritative.
//
// Ordered LIST of contract dirs for a full build over the union: each member's own
// hand-written contracts dir(s), then this graph's out-of-source inferred/ dir.
// Order is own-root-first, then members, then inferred — a hand-written spec always
// precedes the auto-inferred one. Deduped. The inferred dir is written by
// link/unlink's infer-to-disk phase (fullBuild only MATCHES on-disk specs).
//
// Each entry is now `{ dir, scopeRoot }`. `scopeRoot` is the directory a contract
// GOVERNS: a file matches one of its tokens only when the file sits beneath it
// (src/extract/contracts.js#matchContracts). null means UNSCOPED — matches every file,
// which is today's behaviour and therefore what global mode always gets.
//
//   - recursive mode  -> scopeRoot = dirname(dir). `server/contracts/` governs the
//     siblings of its parent, i.e. everything under `server/`, and nothing else.
//   - global mode     -> scopeRoot = null. UNCHANGED, byte for byte.
//   - `--contracts <dir>` -> ALWAYS null. It is an explicit CLI/CI override with no
//     natural scope (it routinely points OUTSIDE the tree), and silently narrowing it
//     would change what a scripted caller's build means.
//   - `.wiregraph/inferred/` -> ALWAYS null. It sits outside every source subtree, so
//     dirname() would scope it to `.wiregraph/` and match nothing; and link-inferred
//     cross-member seams are union-wide by construction, so scoping them would take
//     every one of them dark.
//   - a root that is ITSELF a contracts home -> ALWAYS null (see rootContractsEntries in
//     src/contracts-dirs.js; dirname() there lands outside the project).
function resolveContractsDirs(opts, roots, project, ctx) {
  if (opts.contracts) return [{ dir: opts.contracts, scopeRoot: null }];
  const out = [];
  const seen = new Set();
  const add = (d, scopeRoot) => { if (!seen.has(d)) { seen.add(d); out.push({ dir: d, scopeRoot }); } };
  for (const root of roots) for (const e of ctx.entries(root)) add(e.dir, e.scopeRoot);
  const inferred = join(wiregraphDir(project), 'inferred');
  if (existsSync(inferred)) add(inferred, null);
  return out;
}

// The hand-written contracts dirs across the union, mode-aware — what fullBuild records
// as state.contractsDirs (plural, recursive mode) / state.contractsDir (singular, the
// pre-existing key). The out-of-source inferred/ dir is deliberately NOT here: it is our
// own synthesized output, not user-authored coverage, and must not silence the
// /wiregraph-contracts nudge.
function handWrittenContractsDirs(opts, roots, ctx) {
  if (opts.contracts) return [opts.contracts];
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    for (const e of ctx.entries(root)) if (!seen.has(e.dir)) { seen.add(e.dir); out.push(e.dir); }
  }
  return out;
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
  // ONE discovery context for THIS build (see discoveryContext): the dirs are resolved
  // once and reused by the contract load, the state stamp and the fingerprint.
  const ctx = discoveryContext();

  log(phaseBar(1, 4, 'extracting code symbols + calls...'));
  const calls = [];
  const candidates = [];
  // Comment ranges from the SAME parse, so matchContracts can tell a token USED in code
  // from one merely MENTIONED in prose. It scans raw text and has no parse of its own.
  const comments = new Map();
  for (const r of roots) {
    const res = extractCode(graph, r, log);
    calls.push(...res.calls);
    candidates.push(...res.candidates);
    for (const [k, v] of res.comments || []) comments.set(k, v);
  }

  log(phaseBar(2, 4, 'resolving calls...'));
  resolveCalls(graph, calls, log);

  // A full build ALWAYS walks live — and now genuinely does, because the only memo left
  // is this call's own context (the module-level one made "always walks live" a lie).
  const contractsDirs = resolveContractsDirs(opts, roots, project, ctx);
  if (contractsDirs.length) {
    log(phaseBar(3, 4, `loading + matching contracts from ${contractsDirs.map((e) => e.dir).join(', ')}...`));
    const contracts = loadAllContracts(graph, contractsDirs, log);
    // constDefIndex: where each named constant is DEFINED, so the definition site itself
    // never mints a REFERENCES edge (a declaration is not a use — see matchContracts).
    // The candidates are already in hand from phase 1, so this costs no extra parsing.
    const constDefs = constDefIndex(candidates);
    for (const r of roots) matchContracts(graph, r, contracts, log, null, constDefs, comments);
    buildWireEdges(graph, contracts, log);
    // Resource contracts (*.resource.yaml) derive their own writer->reader seam from
    // the SAME REFERENCES. No-op when no resource spec exists.
    buildResourceEdges(graph, contracts, log);
    // In-process contracts (*.inproc.yaml) derive their provider->consumer seam from the
    // SAME REFERENCES again. No-op when no inproc spec exists.
    buildInprocEdges(graph, contracts, log);
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
  // PLURAL, because recursive mode has genuinely several: one contracts dir per governed
  // subtree, none of which is "the" one. `contractsDir` (singular) stays the first entry
  // — it is what /wiregraph-contracts writes into and what every pre-existing consumer
  // reads — and `contractsDirs` carries the whole list so nothing has to guess. The
  // SessionStart nudge reads BOTH (scripts/hooks/session-start.mjs), which is harmless but
  // is NOT load-bearing: `handWritten` below is `handWrittenDirs[0]`, and detectContractsDirs
  // returns the WHOLE discovered list in recursive mode — nested dirs included, shallowest
  // first — so the singular is null exactly when the plural is empty. There is no
  // "recursive project with only nested contracts dirs" that the singular alone would miss.
  const handWrittenDirs = handWrittenContractsDirs(opts, roots, ctx);
  const handWritten = handWrittenDirs[0] || null;
  // Every token those hand-written specs ALREADY declare. inferredSeams is the count of
  // seams still worth INFERRING, so it must be computed with the same exclusion set
  // scripts/contracts.mjs uses — otherwise the SessionStart nudge and /wiregraph-status
  // count seams the user has already written down by hand, and quote a number the CLI
  // then contradicts (`scan` excludes them, so it reports fewer, or none at all).
  // Drafts are excluded from the exclusion set by handWrittenTokens itself, so a previous
  // `apply` cannot make inference forget what it proposed. Parse failures are already
  // logged by the contract load above, so this pass stays silent.
  const declaredTokens = handWrittenTokens(
    opts.contracts ? [{ dir: opts.contracts, scopeRoot: null }] : roots.flatMap((r) => ctx.entries(r)));
  // inferredSeams counts BOTH inferrable seam kinds — wire (routes/topics) and resource
  // (shared named constants). It is the nudge gate ("seams found AND no hand-written
  // contracts dir"), so a project whose only cross-compartment coupling is a shared file
  // would otherwise never be told that /wiregraph-contracts has something for it. ONE
  // key, because the existing consumers (SessionStart, /wiregraph-status) read exactly
  // one; a second key nothing reads is how `wireSeams` became dead weight.
  // COST — AND IT IS NOT SMALL ON A LARGE TREE. clusterResourceSeams returns immediately
  // when no module-scope string constant exists at all, and on a ~200-file project it is
  // the 5-11ms this comment used to quote as though it were the whole story. Once any
  // constant qualifies it re-READS every source file in the union (it does not re-parse
  // them), i.e. a SECOND full read pass of the tree, and that scales with the tree: 621ms
  // measured on a 7,200-file project. It runs on every full build, including every one an
  // incremental drift-escalates into. So: negligible for a small or constant-free tree,
  // a real fraction of a large build. Read the number as O(files), not as a constant.
  //
  // THIS HALF IS METADATA ABOUT THE SOURCE TREE — how many seams the walk found, and which
  // contracts dirs it discovered — so it is safe to record before the db is touched, and
  // it is deliberately kept SEPARATE from the two fingerprint stamps below. The stamps used
  // to ride along in this same updateState, inside this same bare `catch {}`, which coupled
  // them to the two inference passes: any throw out of clusterSeams / clusterResourceSeams
  // silently left the OLD stamp, so the next save saw drift, escalated to a full rebuild,
  // which threw here again, which escalated again — a full rebuild per file save, forever,
  // visible only as repeating lines in refresh.log. Two writes, two failure domains.
  try {
    updateState(project, {
      inferredSeams: clusterSeams(candidates, { exclude: declaredTokens }).length
        + clusterResourceSeams(candidates, roots, { comments, exclude: declaredTokens }).length,
      contractsDir: handWritten,
      contractsDirs: handWrittenDirs,
    });
  }
  catch (e) { log(`  seam/contracts-dir metadata not recorded (${e.message}) — the graph is unaffected`); }

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

  // --- THE PARTITION STAMPS, AFTER THE GRAPH IS ON DISK -----------------------
  // Both fingerprints assert ONE thing: "the graph in the db was built against THIS
  // partition". Only a full build may assert it — runBuild forces reset for every
  // non-`--files` build and reset deletes every row in every table, so a completed full
  // build really does re-derive the whole union under the partition it just resolved.
  //
  // THAT ENTITLEMENT IS EARNED BY COMPLETING, NOT BY STARTING. This used to be stamped
  // before the db was even opened, ~25 lines above, with a comment claiming a full build
  // "is the only operation that is safe by construction" — true of the operation, false of
  // the attempt. Any throw between the stamp and the write left state asserting the graph
  // matched the NEW partition over a db still holding the OLD one, which PERMANENTLY
  // disarms both guards: changedSince stops escalating and incrementalBuild stops refusing,
  // for every subsequent save, with no self-heal. Observed (1 -> 2 compartments, then a
  // full build failing at the db open): stamp moved to the new partition, compartmentsDrift
  // went null, and the next ordinary save produced a live WIRE seam pointing into a
  // compartment that no longer existed, which trace_contract reported as real.
  //
  // The reachable failure points between the two positions are not exotic: ENOSPC or EACCES
  // on the db path, a `<db>.lock` that cannot be taken (connect acquires it before reading),
  // loadGraph's newer-schema refusal, and — worst — loadGraph's member-losing-reset
  // backstop, a guard that exists to PREVENT corruption and whose firing used to corrupt the
  // baseline instead. It is also stamped nowhere on the `--no-load` path now, which is
  // correct for the same reason: --no-load writes no db, so nothing about the db changed.
  //
  // MERGED, not replaced (stampCompartmentsFingerprint / stampContractsFingerprint): a
  // member that is transiently unmounted, or deliberately excluded by unlink's reduced
  // union, keeps its baseline instead of dropping out and forging a partition change. Same
  // rule, same reason, as the reposLastSha merge in refresh.mjs.
  //
  // The two honesty flags are cleared HERE and not with the metadata above, for the same
  // reason: "no structural drift since the last full build" is a claim about the GRAPH.
  //
  // NOT FATAL, BUT NEVER SILENT. The graph on disk is correct and queryable; only the guard
  // baseline is stale, and a stale baseline fails SAFE (drift -> escalate -> full rebuild).
  // But that is also the M3 loop if it recurs, so it is logged rather than swallowed —
  // refresh.log then names the reason instead of showing an unexplained rebuild per save.
  try {
    updateState(project, {
      structuralDriftSinceFullBuild: false,
      seamStaleSinceInference: false,
      compartmentsFingerprint: stampCompartmentsFingerprint(project, roots, { partitionOf: (r) => ctx.compartments(r) }),
      contractsFingerprint: stampContractsFingerprint(project, roots, { contracts: opts.contracts || null, specsOf: (r) => ctx.specs(r) }),
    });
  } catch (e) {
    log(`wiregraph: WARNING — the graph was written but its partition fingerprints could NOT be stamped (${e.message}). `
      + 'The graph is correct; until this is fixed every incremental update will escalate to a full rebuild.');
  }
}

// The compartment names ALREADY in the db for this project — the last full build's
// complete set. Best-effort by construction: an unreadable/empty db just means the caller
// falls back to whatever its in-memory graph knows, which is the pre-existing behaviour.
function dbCompartmentNames(db, project) {
  try { return db.prepare('SELECT DISTINCT name FROM compartments WHERE project = ?').all(project).map((r) => r.name); }
  catch { return []; }
}

// --- incremental build ------------------------------------------------------
// Re-index only the given files: delete their prior nodes, extract just them,
// resolve their OUTGOING calls against the whole project (read from the db), then
// reload. Incoming name-based CALLS to a renamed symbol may dangle until a full
// rebuild — THAT is the one documented full-rebuild backstop here. The DERIVED seams
// (WIRE, RESOURCE and INPROC) are NOT in that category any more: pruneFile drops the
// seams touching a re-indexed symbol and rederiveWireEdges rebuilds every one of them
// from the now-fresh REFERENCES at the end of this function, so a seam survives an
// ordinary save.
function incrementalBuild(opts, root, project) {
  if (!opts.load) throw new Error('--files (incremental) requires a load; remove --no-load');

  // Attribute each changed path to the MEMBER root that owns it (longest-prefix
  // match over the union), then to its compartment within that owner — so a file
  // under a linked member is attributed with the member's own boundaries/basename,
  // matching that member's full build. Works for existing AND deleted files.
  const roots = memberRoots(project, opts);

  // BELT AND BRACES against a stale partition. The declared-compartment boundaries are
  // read fresh below (infoFor → the shared discoveryContext), but pruneFile deletes by
  // `(project, compartment, file)` — so if the declaration changed since the last full
  // build, the prune targets rows that no longer exist under that key, MISSES, and the
  // reload inserts the same symbols a second time under the NEW compartment: duplicate
  // symbols under two compartments plus orphaned CALLS edges, silently. changedSince
  // already escalates the auto-catch-up to a full rebuild for this; this refusal covers
  // every OTHER incremental entry point (post-edit --files, update_graph incremental,
  // the read-time self-heal). An ABSENT stamp means "no baseline recorded", never
  // "changed" - a project last built before this key existed must not be refused.
  //
  // AND IT COVERS THE DISK HALF, NOT JUST THE DECLARATION TEXT. Renaming or deleting a
  // declared source directory re-partitions the graph exactly as editing the declaration
  // does, and used to sail straight through here because nothing hashed disk state; the
  // fingerprint now derives from the partition the read path RESOLVES to, so a vanished
  // declared path moves it (see scripts/lib/state.mjs).
  // ONE discovery context for this incremental (see discoveryContext): the live partition
  // this refusal needs is the SAME partition infoFor then attributes against, and the live
  // contracts walk the refusal below needs is the same one resolveContractsDirs then uses.
  // `opts.ctx` widens that to ONE PER SAVE — the post-edit hook has already resolved both
  // to compare the fingerprints, and without sharing it this process resolves them twice,
  // one function call apart. Absent (every other entry point) it is one context per build
  // exactly as before; it is never a cross-CALL cache.
  const ctx = opts.ctx || discoveryContext();

  // Held, not just compared: armAbsentFingerprints stamps EXACTLY these values at the end
  // of a successful incremental, so the baseline it writes is the partition this update
  // actually attributed and pruned against, resolved once.
  const liveCompartments = compartmentsFingerprint(roots, { project, partitionOf: (r) => ctx.compartments(r) });
  const drift = compartmentsDrift(
    readState(project)?.compartmentsFingerprint,
    liveCompartments,
  );
  if (drift) {
    throw new Error(
      // "the compartment partition changed" is the ONE phrase all three sites use for this
      // condition — here, changedSince's escalation reason (scripts/lib/git.mjs) and the
      // refresh hook's greppable label (scripts/hooks/refresh.mjs#healPartitionDrift). It
      // deliberately does NOT say "declared": global mode is fingerprinted too, so this
      // branch is reachable on a project where NOTHING was ever declared and a manifest
      // merely appeared in a subdirectory. The parenthetical says which kind moved. If you
      // reword one site, reword all three — they are matched by grep, not by a constant.
      'wiregraph: the compartment partition changed since the last full build '
      + `(${drift}; the partition may be DECLARED in state.json or INFERRED from .git / build `
      + 'manifests — either one re-partitions every id). An incremental update would '
      + 'attribute files to the NEW compartments while pruning under the OLD ones, leaving '
      + 'duplicate symbols and orphaned edges. Run a full rebuild (/wiregraph-rebuild, or '
      + 'update_graph {full:true}) - it is safe by construction.',
    );
  }

  // BELT AND BRACES against a stale CONTRACT SCOPE — the same shape as the partition
  // refusal above, for the other thing a full build resolves and an incremental inherits.
  // Scope is applied at MATCH time and persisted nowhere (the design's schema bet), which
  // is sound only while every stored REFERENCES row was minted under the scope in force
  // NOW. pruneFile deletes rows for the EDITED file only, and rederiveWireEdges then groups
  // EVERY REFERENCES row in the db by contractId|token with no scope of its own — so a row
  // minted under a WIDER scope is indistinguishable from a fresh one and gets re-created.
  //
  // The subject is the resolved SPEC set, not the dir set (see contractsFingerprint): the
  // narrowing that fabricates the false seam is a SPEC moving inward, which two already
  // -existing contracts dirs hide completely, and a RETITLED spec orphans its old id's rows
  // the same way. Likewise a `--contracts` build followed by an ordinary incremental, a
  // spec added since the last full build, and — global mode included — one DELETED, which
  // otherwise left a ghost contract with live REFERENCES and a WIRE edge for a spec no
  // longer on disk. An ABSENT stamp is "no baseline", never "changed".
  const liveContracts = contractsFingerprint(roots, { project, contracts: opts.contracts || null, specsOf: (r) => ctx.specs(r) });
  const cDrift = contractsDrift(
    readState(project)?.contractsFingerprint,
    liveContracts,
  );
  if (cDrift) {
    throw new Error(
      'wiregraph: the contract specs in force changed since the last full build '
      + `(${cDrift}). Contract SCOPE is applied when REFERENCES are minted and is not stored, `
      + 'so an incremental update would re-derive seams over rows minted under the OLD scopes '
      + '- fabricating cross-scope WIRE edges a full rebuild does not produce, and leaving stale '
      + 'REFERENCES rows that trace_contract reports as real. Run a full rebuild '
      + '(/wiregraph-rebuild, or update_graph {full:true}) - it is safe by construction.',
    );
  }

  // Attribution reads the partition from the SAME context the refusal above compared, so
  // the boundaries this update attributes against are byte-for-byte the ones it just
  // certified as matching the graph — and the tree is resolved once per save, not twice.
  const infoFor = (r) => ({ compartmentRoots: ctx.compartments(r).roots, rootName: basename(r) });
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
    // Candidates are collected here for ONE reason: the constant-DEFINITION index the
    // re-match needs (see matchContracts). Without it the incremental path would re-mint
    // exactly the definition-site REFERENCES the full build excludes, so a save of the
    // constants module would resurrect a phantom seam half that a rebuild then removes.
    const candidates = [];
    // …and the comment ranges, for the same reason: a re-match that could not see
    // comments would re-mint exactly the prose "references" the full build excludes.
    const comments = new Map();

    // Contract wiring is resolved ONCE up front (not just inside the present branch)
    // so both the WIRE re-derive (Change 1) and the seam-staleness flag (Change 2) can
    // see it even on a deletion-only update. `contracts` is the merged set matchContracts
    // used, reused by the re-derive so orientation matches a full build.
    // Resolved from THIS call's context, so the walk the fingerprint check above already
    // paid for is reused rather than repeated. (Global-mode roots never walk at all — their
    // discovery is one readdir, so the legacy save loop is untouched.)
    const contractsDirs = resolveContractsDirs(opts, roots, project, ctx);
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
        candidates.push(...res.candidates);
        for (const [k, v] of res.comments || []) comments.set(k, v);
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
      // a changed file, mirroring fullBuild's per-root matchContracts. (This step restores
      // REFERENCES only; the derived WIRE/RESOURCE/INPROC seams are rebuilt from them by
      // rederiveWireEdges at the end of this function — see Change 1 below.)
      if (contractsDirs.length) {
        // The compartment set this graph really has, for validateResourceRoles: THIS
        // graph holds only the edited files' compartments, so validating against it made
        // every save warn that a real compartment "does not exist in this graph" and list
        // a "Known compartments" set of one. The db's compartments are the last full
        // build's complete set, and the fresh graph adds any this save just created.
        contracts = loadAllContracts(graph, contractsDirs, log, { knownCompartments: dbCompartmentNames(db, project) });
        const constDefs = constDefIndex(candidates);
        for (const r of owners) matchContracts(graph, r, contracts, log, fileFilter, constDefs, comments);
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
  if (ok) armAbsentFingerprints(project, liveCompartments, liveContracts);
}

// --- arming the guards on the INSTALLED BASE ---------------------------------
// `fingerprintDrift` reads an ABSENT stamp as "no baseline", never as "changed", and that
// is deliberate and correct (§14): it is what stops a wiregraph upgrade from force-
// rebuilding every project on its next catch-up. Its consequence, unnoticed, is that
// EVERY project whose graph was built by a release that predates a given key carries an
// UNGUARDED graph — and stays that way for as long as nobody runs a full rebuild by hand,
// which for the save loop is forever. All three corruptions the guards exist to stop
// reproduce verbatim on such a project: a manifest added to a subdirectory (duplicate
// symbols under two compartments, no self-heal); a declaration change waved through by an
// incremental (duplicate symbols plus stale CALLS edges); a deleted contracts dir leaving
// a ghost contract whose WIRE edge trace_contract reports as real.
//
// So: when the stamp for a root is ABSENT and an incremental has just COMPLETED against
// that root, stamp what THAT INCREMENTAL USED. The promise is kept exactly, because
// STAMPING IS NOT COMPARING:
//   - it runs AFTER both refusals, so it cannot make this save escalate — the very first
//     post-upgrade save is byte-for-byte what it was before, refusal included;
//   - it runs only when `ok` is set, i.e. the incremental really completed;
//   - it FILLS ABSENT KEYS ONLY. An existing baseline is never rewritten, so a stamp that
//     legitimately disagrees with the live tree keeps disagreeing and keeps escalating,
//     and the copy-poison value (a string under '.') is never papered over.
// From the SECOND save on, the guard is armed against the partition the graph was last
// indexed under. That is strictly better than the status quo ante, which was never.
//
// It cannot certify what it did not see: if the db was ALREADY built against a different
// partition before this upgrade, that corruption predates the stamp and no stamp can
// undo it — a full rebuild does. This closes the window going forward; it does not
// retroactively validate an unguarded graph.
function armAbsentFingerprints(project, liveCompartments, liveContracts) {
  try {
    const st = readState(project);
    if (!st) return; // no state file — not an initialized project; writing one here is not this function's job
    const patch = {};
    const fill = (key, live) => {
      const raw = st[key];
      const prior = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
      const add = {};
      for (const [k, v] of Object.entries(live || {})) if (!prior || prior[k] === undefined) add[k] = v;
      if (Object.keys(add).length) patch[key] = { ...(prior || {}), ...add };
    };
    fill('compartmentsFingerprint', liveCompartments);
    fill('contractsFingerprint', liveContracts);
    if (Object.keys(patch).length) updateState(project, patch);
  } catch { /* metadata only — an incremental must never fail over its baseline stamp */ }
}

// Programmatic entry point — used by the MCP update_graph tool and the hooks so
// they can refresh the graph in-process without shelling out. opts mirrors the
// CLI flags: { target, project?, files?, reset?, contracts?, db?, load?, dump? }, plus
// `ctx?` — a discoveryContext the CALLER already resolved contracts against, honoured only
// on the incremental path (see incrementalBuild). It rides through in `o` via the spread.
export async function runBuild(opts = {}) {
  // Before anything can warn (see installBuildWarningCapture). Idempotent, and transparent
  // to whatever else is writing to stderr.
  installBuildWarningCapture();
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
  // `kind` decides WHICH record this build may write, and `complete` decides whether it may
  // assert cleanliness (recordBuildWarnings). A build that throws part-way has usually
  // already emitted its content-dropping warnings and is entitled to record THOSE — losing
  // them to a later, unrelated failure is exactly the silence this fixes.
  const kind = (o.files && o.files.length) ? 'incremental' : 'full';
  let complete = false;
  try {
    if (o.files && o.files.length) {
      const r = incrementalBuild(o, root, project);
      complete = true;
      return r;
    }
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
    const r = fullBuild(o, roots, project);
    complete = true;
    return r;
  } finally {
    flushBuildWarnings(project, kind, complete);
  }
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
// `ctx` is an optional discoveryContext (see discoveryContext) the caller has ALREADY
// resolved contracts against — refresh.mjs passes the one healPartitionDrift used, so a
// save resolves the contracts dirs once instead of twice in the same process. Purely a
// cost knob: every value it carries is resolved live within this one hook invocation.
export async function reindexFiles(files, editingProject, { fanOut = false, ctx = null } = {}) {
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
      await runBuild({ target: m, project: G, files: filesForM, ctx });
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
