#!/usr/bin/env node
// codegraph regression test — locks the SQLite query layer's behavior so a future
// change can't silently diverge (there is no Neo4j to diff against anymore).
// Runs a committed synthetic fixture through build + every tool, then asserts
// golden results: symbol resolution, intra/cross-file traces, get_source, an
// in-repo path_between, query_sql guards, schema versioning + migration, and
// incremental idempotency. Self-contained — no external workspace needed.

import { mkdtempSync, cpSync, appendFileSync, rmSync, realpathSync, existsSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runBuild } from '../src/build.js';
import { connect, schemaVersion, SCHEMA_VERSION, loadGraph } from '../src/store/sqlite.js';
import { Graph } from '../src/model.js';
import * as Q from '../src/store/sqlite-query.js';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixture');
const FIXTURE_PY = join(HERE, 'fixture-py');
const FIXTURE_JAVA = join(HERE, 'fixture-java');
const FIXTURE_KOTLIN = join(HERE, 'fixture-kotlin');
const BUILD = join(HERE, '..', 'src', 'build.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function has(haystack, needle, msg) { ok(String(haystack).includes(needle), `${msg} — missing "${needle}" in:\n${haystack}`); }
function edgeCounts(db, project) {
  const r = {};
  for (const e of db.prepare('SELECT type, count(*) n FROM edges WHERE project=? GROUP BY type').all(project)) r[e.type] = e.n;
  return r;
}

async function fixtureTests() {
  const work = mkdtempSync(join(tmpdir(), 'cg-test-'));
  const src = join(work, 'src');
  cpSync(FIXTURE, src, { recursive: true });
  const project = realpathSync(src);
  const db = join(work, 'graph.db');

  await runBuild({ target: src, project, db, reset: true });
  let conn = connect(db, { readonly: true });

  // schema version stamped
  eq(schemaVersion(conn), SCHEMA_VERSION, 'schema_version stamped');

  // find_symbol: unique + ambiguous
  has(Q.findSymbol(conn, project, 'a_main'), 'a.c', 'find_symbol a_main locates a.c');
  has(Q.findSymbol(conn, project, 'dup'), '2 match', 'find_symbol dup is ambiguous (2)');

  // get_source returns the body, not the whole file
  has(Q.getSource(conn, project, 'a_helper'), 'return n + 1', 'get_source a_helper body');

  // trace_callees: intra-file + cross-file + transitive leaf
  const callees = Q.traceCallees(conn, project, 'a_main');
  has(callees, 'a_helper', 'callees include intra-file a_helper');
  has(callees, 'a_util', 'callees include cross-file a_util');
  has(callees, 'leaf', 'callees reach transitive leaf');

  // trace_callers: leaf <- a_util <- a_main
  const callers = Q.traceCallers(conn, project, 'leaf');
  has(callers, 'a_util', 'callers of leaf include a_util');
  has(callers, 'a_main', 'callers of leaf reach a_main');

  // path_between: a_main -> a_util -> leaf (cross-file CALLS chain), exercises the
  // BFS + node-label reconstruction.
  const path = Q.pathBetween(conn, project, 'a_main', 'leaf');
  has(path, 'a_util', 'path_between routes a_main -> leaf through a_util');
  has(path, 'leaf', 'path_between reaches the target');

  // query_sql: valid SELECT + guards
  has(Q.querySql(conn, "SELECT name FROM symbols WHERE name='a_main'"), 'a_main', 'query_sql SELECT works');
  has(Q.querySql(conn, 'DELETE FROM symbols'), 'Refused', 'query_sql rejects DELETE');
  has(Q.querySql(conn, 'SELECT 1; DROP TABLE symbols'), 'Refused', 'query_sql rejects multi-statement');

  const base = edgeCounts(conn, project);
  conn.close();

  // incremental idempotency: re-index an unchanged file → identical edge counts
  await runBuild({ target: src, project, db, files: ['util.c'] });
  conn = connect(db, { readonly: true });
  const after = edgeCounts(conn, project);
  eq(JSON.stringify(after), JSON.stringify(base), 'incremental re-index of unchanged file is idempotent');
  conn.close();

  // incremental reflects a real change: add a function that calls a_helper
  appendFileSync(join(src, 'a.c'), '\nint added_fn(int n) { return a_helper(n); }\n');
  await runBuild({ target: src, project, db, files: ['a.c'] });
  conn = connect(db, { readonly: true });
  has(Q.findSymbol(conn, project, 'added_fn'), 'a.c', 'incremental picks up a new symbol');
  has(Q.traceCallees(conn, project, 'added_fn'), 'a_helper', 'new symbol resolves its cross-file call');
  conn.close();

  // schema migration: tamper version, full rebuild must migrate (drop+recreate)
  const w = connect(db); // writable
  w.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('schema_version','0')").run();
  w.close(); // persists the tampered version

  await runBuild({ target: src, project, db, reset: true });
  conn = connect(db, { readonly: true });
  eq(schemaVersion(conn), SCHEMA_VERSION, 'reset migrates a stale-version db back to current');
  has(Q.findSymbol(conn, project, 'a_main'), 'a.c', 'queries work after migration');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// Freshness model (v2): staleness is "differs from what was indexed" (mtime/size),
// NOT "differs from the last committed git sha". The old git-only check flagged an
// uncommitted-but-already-reindexed file as stale forever, so update_graph could
// never converge and Claude treated the graph as perpetually out of date. Assert:
//   1. a full build records each file's mtime/size,
//   2. an unchanged file is not stale,
//   3. an edited file IS stale,
//   4. re-indexing it clears the staleness EVEN THOUGH it's never committed.
async function freshnessTests() {
  const work = mkdtempSync(join(tmpdir(), 'cg-fresh-'));
  const src = join(work, 'src');
  cpSync(FIXTURE, src, { recursive: true });
  const project = realpathSync(src);
  const db = join(work, 'graph.db');

  await runBuild({ target: src, project, db, reset: true });
  let conn = connect(db, { readonly: true });

  // (1) mtime/size recorded for indexed files.
  const indexed = Q.indexedFiles(conn, project);
  const aPath = join(project, 'a.c');
  ok(indexed.has(aPath), 'freshness: a.c is in the indexed file set');
  ok(indexed.get(aPath)?.mtime > 0 && indexed.get(aPath)?.size > 0, 'freshness: a.c has a recorded mtime + size');

  // (2) nothing changed on disk → nothing stale.
  eq(Q.staleAmong(conn, project, [aPath]).length, 0, 'freshness: unchanged file is not stale');
  conn.close();

  // (3) edit a.c and bump its mtime into the future → stale vs the indexed record.
  appendFileSync(aPath, '\nint fresh_fn(int n) { return a_helper(n); }\n');
  const future = Date.now() / 1000 + 5;
  utimesSync(aPath, future, future);
  conn = connect(db, { readonly: true });
  eq(Q.staleAmong(conn, project, [aPath]).length, 1, 'freshness: edited file is detected stale');
  conn.close();

  // (4) re-index (no commit happens here) → staleness clears, proving the signal
  // tracks the index, not git. This is the loop that used to never converge.
  await runBuild({ target: src, project, db, files: ['a.c'] });
  conn = connect(db, { readonly: true });
  eq(Q.staleAmong(conn, project, [aPath]).length, 0, 'freshness: re-indexed (uncommitted) file is no longer stale');
  has(Q.findSymbol(conn, project, 'fresh_fn'), 'a.c', 'freshness: the re-indexed edit is queryable');
  conn.close();

  // A deleted file (gone from disk) is stale until pruned.
  const utilPath = join(project, 'util.c');
  rmSync(utilPath);
  conn = connect(db, { readonly: true });
  eq(Q.staleAmong(conn, project, [utilPath]).length, 1, 'freshness: deleted file is detected stale');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// Two writers re-indexing different files concurrently (the PostToolUse worker
// firing for two quick edits) must not lose either update. Each writable session
// is read-file -> mutate -> rename; without the cross-process lock in sqlite.js
// the later rename would clobber the earlier writer's new symbol. Run them in
// separate processes (real parallelism) and assert BOTH new symbols survive.
async function concurrencyTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-conc-'));
  const src = join(work, 'src');
  cpSync(FIXTURE, src, { recursive: true });
  const project = realpathSync(src);
  const db = join(work, 'graph.db');

  await runBuild({ target: src, project, db, reset: true }); // baseline

  appendFileSync(join(src, 'a.c'), '\nint conc_a(int n) { return a_helper(n); }\n');
  appendFileSync(join(src, 'util.c'), '\nint conc_u(int n) { return leaf(n); }\n');

  const run = (file) => execFileP('node', [BUILD, src, '--project', project, '--db', db, '--files', file]);
  await Promise.all([run('a.c'), run('util.c')]);

  const conn = connect(db, { readonly: true });
  has(Q.findSymbol(conn, project, 'conc_a'), 'a.c', 'concurrent writers: a.c update survived');
  has(Q.findSymbol(conn, project, 'conc_u'), 'util.c', 'concurrent writers: util.c update survived');
  conn.close();

  // A lockfile left by a crashed writer (older than the staleness window) must be
  // stolen, not block forever / time out — else one dead process wedges all
  // future writes. Backdate a leftover lock and assert the next build succeeds.
  writeFileSync(db + '.lock', '999999');
  const longAgo = Date.now() / 1000 - 120; // 2 min old, well past LOCK_STALE_MS
  utimesSync(db + '.lock', longAgo, longAgo);
  appendFileSync(join(src, 'a.c'), '\nint after_crash(int n) { return a_helper(n); }\n');
  await runBuild({ target: src, project, db, files: ['a.c'] });
  const c2 = connect(db, { readonly: true });
  has(Q.findSymbol(c2, project, 'after_crash'), 'a.c', 'stale lock from a crashed writer is stolen, build proceeds');
  c2.close();
  ok(!existsSync(db + '.lock'), 'stale lock is cleaned up after the steal');

  rmSync(work, { recursive: true, force: true });
}

// A --reset rebuild wipes the project's rows before reloading. If the reload
// throws, that wipe must roll back — otherwise close() persists the emptied db
// and a transient failure during /codegraph-rebuild destroys the existing graph.
// Inject a symbol with an unbindable value to force the insert phase to throw,
// then assert the prior graph survived (mimicking build.js's connect/try/finally).
async function rebuildDurabilityTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-dur-'));
  const db = join(work, 'graph.db');
  const project = join(work, 'proj');

  const g1 = new Graph(project);
  g1.addRepo('r', project);
  g1.addFile('r', 'a.c', 'c');
  g1.addSymbol({ id: 'sym:r:a.c:keepme:1', repo: 'r', file: 'a.c', name: 'keepme', kind: 'function', lang: 'c', startLine: 1, endLine: 2 });
  let conn = connect(db);
  loadGraph(conn, g1);
  conn.close();

  conn = connect(db, { readonly: true });
  // NB: assert on 'match(es)', not 'keepme' — the not-found message echoes the
  // queried name ("No symbol named \"keepme\""), so a name needle would pass even
  // when the symbol is absent. 'match(es)' only appears on a hit.
  has(Q.findSymbol(conn, project, 'keepme'), 'match(es)', 'durability: baseline graph present');
  conn.close();

  const g2 = new Graph(project);
  g2.addRepo('r', project);
  // startLine is an object — sql.js can't bind it, so insSym.run throws mid-tx.
  g2.symbols.set('bad', { id: 'bad', repo: 'r', file: 'b.c', name: 'bad', kind: 'function', lang: 'c', startLine: {}, endLine: 0, project });

  conn = connect(db);
  let threw = false;
  try { loadGraph(conn, g2, { reset: true }); } catch { threw = true; } finally { conn.close(); }
  ok(threw, 'durability: a poisoned --reset load throws');

  conn = connect(db, { readonly: true });
  has(Q.findSymbol(conn, project, 'keepme'), 'match(es)', 'durability: failed --reset leaves the prior graph intact');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// Python language support: def/method/class extraction, identifier + attribute
// call resolution, and a cross-file CALLS chain (run -> handle -> util) reached
// through a class method.
async function pythonTests() {
  const work = mkdtempSync(join(tmpdir(), 'cg-py-'));
  const src = join(work, 'src');
  cpSync(FIXTURE_PY, src, { recursive: true });
  const project = realpathSync(src);
  const db = join(work, 'graph.db');

  await runBuild({ target: src, project, db, reset: true });
  const conn = connect(db, { readonly: true });

  has(Q.findSymbol(conn, project, 'run'), 'app.py', 'py: find_symbol run locates app.py');
  has(Q.findSymbol(conn, project, 'handle'), '(method)', 'py: handle is tagged a method');
  has(Q.findSymbol(conn, project, 'Service'), '(class)', 'py: Service is tagged a class');
  has(Q.getSource(conn, project, 'helper'), 'return n + 1', 'py: get_source returns the function body');

  const callees = Q.traceCallees(conn, project, 'run');
  has(callees, 'helper', 'py: callees include same-file helper');
  has(callees, 'handle', 'py: callees include cross-file method handle (attribute call)');
  has(callees, 'util', 'py: callees reach util transitively through handle');

  has(Q.traceCallers(conn, project, 'util'), 'run', 'py: callers of util reach run');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// Java and Kotlin share the same fixture shape as the Python one: run() reaches a
// cross-file class method (handle), a same-file helper, and a constructor; handle
// calls util, so callees(run) reaches util transitively. One parametrized harness.
async function jvmLangTests(label, fixtureDir, mainFile) {
  const work = mkdtempSync(join(tmpdir(), `cg-${label}-`));
  const src = join(work, 'src');
  cpSync(fixtureDir, src, { recursive: true });
  const project = realpathSync(src);
  const db = join(work, 'graph.db');

  await runBuild({ target: src, project, db, reset: true });
  const conn = connect(db, { readonly: true });

  has(Q.findSymbol(conn, project, 'run'), mainFile, `${label}: find_symbol run locates ${mainFile}`);
  has(Q.findSymbol(conn, project, 'handle'), '(method)', `${label}: handle is tagged a method`);
  has(Q.findSymbol(conn, project, 'Service'), '(class)', `${label}: Service is tagged a class`);
  has(Q.getSource(conn, project, 'helper'), 'n + 1', `${label}: get_source returns the function body`);

  const callees = Q.traceCallees(conn, project, 'run');
  has(callees, 'helper', `${label}: callees include same-file helper`);
  has(callees, 'handle', `${label}: callees include cross-file method handle`);
  has(callees, 'util', `${label}: callees reach util transitively through handle`);

  has(Q.traceCallers(conn, project, 'util'), 'run', `${label}: callers of util reach run`);
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// Impact metrics: estTokens, gated best-effort record(), and the summarize()
// rollup including the grep-gap classifier (which resolves grep patterns against
// a real built graph). Self-contained — builds the C fixture into a temp project.
async function metricsTests() {
  const M = await import('../scripts/lib/metrics.mjs');
  const S = await import('../scripts/lib/state.mjs');

  eq(M.estTokens(''), 0, 'metrics: estTokens("") is 0');
  ok(M.estTokens('abcdefgh') > 0, 'metrics: estTokens positive for non-empty');
  ok(M.estTokens('a'.repeat(100)) > M.estTokens('a'.repeat(10)), 'metrics: estTokens monotonic');

  const work = mkdtempSync(join(tmpdir(), 'cg-metrics-'));
  const src = join(work, 'src');
  cpSync(FIXTURE, src, { recursive: true });
  const project = realpathSync(src);
  const db = join(project, '.codegraph', 'graph.db');           // where summarize() looks
  await runBuild({ target: src, project, db, reset: true });
  S.writeState(project, S.defaultState(project));                // balanced posture ⇒ recording enabled

  // record() writes a parseable, timestamped line
  M.record(project, { kind: 'use', tool: 'get_source', returnedTokens: 7, fileTokens: 130, savedTokens: 123 });
  const lines = readFileSync(M.metricsPath(project), 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  eq(last.tool, 'get_source', 'metrics: recorded tool field');
  eq(last.savedTokens, 123, 'metrics: recorded savedTokens field');
  ok(typeof last.t === 'number', 'metrics: stamped a numeric timestamp');

  // gating: the env kill-switch and posture:off are both silent no-ops
  const before = readFileSync(M.metricsPath(project), 'utf8');
  process.env.CODEGRAPH_METRICS = '0';
  M.record(project, { kind: 'use', tool: 'get_source' });
  delete process.env.CODEGRAPH_METRICS;
  S.updateState(project, { autoUpdate: 'off' });
  M.record(project, { kind: 'use', tool: 'get_source' });
  S.updateState(project, { autoUpdate: 'balanced' });
  eq(readFileSync(M.metricsPath(project), 'utf8'), before, 'metrics: gating (env + posture off) silences record');

  // a trace + greps, then the rollup. "a_helper" is a real fixture symbol;
  // "no_such_symbol_xyz" is not; "foo.*bar" is a regex, not a bare identifier.
  M.record(project, { kind: 'use', tool: 'trace_callees', nodes: 4, returnedTokens: 50 });
  M.record(project, { kind: 'grep', pattern: 'a_helper' });
  M.record(project, { kind: 'grep', pattern: 'no_such_symbol_xyz' });
  M.record(project, { kind: 'grep', pattern: 'foo.*bar' });

  const agg = await M.summarize(project);
  eq(agg.getSourceCalls, 1, 'metrics: summarize counts get_source calls');
  eq(agg.savedTokens, 123, 'metrics: summarize sums savedTokens');
  eq(agg.traceCalls, 1, 'metrics: summarize counts trace calls');
  eq(agg.traceNodes, 4, 'metrics: summarize sums trace nodes');
  eq(agg.grepTotal, 3, 'metrics: summarize counts every grep');
  eq(agg.gapCount, 1, 'metrics: only the known-symbol grep counts as a gap');
  ok(agg.gapTokens > 0, 'metrics: gap tokens estimated from the symbol file');
  has(M.formatSummary(agg), 'Adoption gap', 'metrics: formatSummary renders the gap line');

  rmSync(work, { recursive: true, force: true });
}

console.log('codegraph regression test');
await fixtureTests();
await pythonTests();
await jvmLangTests('java', FIXTURE_JAVA, 'App.java');
await jvmLangTests('kotlin', FIXTURE_KOTLIN, 'App.kt');
await freshnessTests();
await concurrencyTest();
await rebuildDurabilityTest();
await metricsTests();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
