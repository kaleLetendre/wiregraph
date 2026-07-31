#!/usr/bin/env node
// wiregraph regression test — locks the SQLite query layer's behavior so a future
// change can't silently diverge (there is no Neo4j to diff against anymore).
// Runs a committed synthetic fixture through build + every tool, then asserts
// golden results: symbol resolution, intra/cross-file traces, get_source, an
// in-repo path_between, query_sql guards, schema versioning + migration, and
// incremental idempotency. Self-contained — no external workspace needed.

import { mkdtempSync, cpSync, appendFileSync, rmSync, realpathSync, existsSync, writeFileSync, utimesSync, readFileSync, mkdirSync, symlinkSync, renameSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runBuild } from '../src/build.js';
import { connect, schemaVersion, SCHEMA_VERSION, loadGraph, shouldStealLock } from '../src/store/sqlite.js';
import { Graph } from '../src/model.js';
import * as Q from '../src/store/sqlite-query.js';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixture');
const FIXTURE_PY = join(HERE, 'fixture-py');
const FIXTURE_JAVA = join(HERE, 'fixture-java');
const FIXTURE_KOTLIN = join(HERE, 'fixture-kotlin');
const FIXTURE_CONTRACTS = join(HERE, 'fixture-contracts');
const FIXTURE_EDGE = join(HERE, 'fixture-edge-app');
const FIXTURE_SERVER = join(HERE, 'fixture-log-server');
const BUILD = join(HERE, '..', 'src', 'build.js');
const REFRESH = join(HERE, '..', 'scripts', 'hooks', 'refresh.mjs');

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
  has(Q.querySql(conn, "UPDATE symbols SET name='x'"), 'Refused', 'query_sql rejects UPDATE (non-SELECT start)');
  has(Q.querySql(conn, 'SELECT 1; DROP TABLE symbols'), 'Refused', 'query_sql rejects multi-statement');
  has(Q.querySql(conn, "SELECT load_extension('/tmp/x')"), 'Refused', 'query_sql rejects load_extension');
  // read-only SELECTs that the old broad keyword blocklist wrongly refused: a keyword
  // inside a LIKE literal, and the scalar replace() function (not the REPLACE statement).
  ok(!String(Q.querySql(conn, "SELECT name FROM symbols WHERE name LIKE 'create%'")).includes('Refused'),
    'query_sql allows a keyword inside a LIKE literal');
  ok(!String(Q.querySql(conn, "SELECT replace(name,'x','y') AS r FROM symbols LIMIT 1")).includes('Refused'),
    'query_sql allows the scalar replace() function');

  // V2: a leading WITH clause CAN front a data-modifying statement in SQLite
  // (`WITH t AS (...) DELETE FROM ...`), which the SELECT/WITH-start guard does NOT
  // catch. `PRAGMA query_only=ON` makes every such write throw ("attempt to write a
  // readonly database"), surfaced as a "SQL error". Assert the write did NOT execute
  // by checking the symbols row count is UNCHANGED after each attempt.
  const symCount = () => conn.prepare('SELECT count(*) AS n FROM symbols').all()[0].n;
  {
    const before = symCount();
    const del = String(Q.querySql(conn, 'WITH t AS (SELECT 1) DELETE FROM symbols'));
    ok(!del.includes('(no rows)') && del.includes('error'), 'query_sql refuses WITH-prefixed DELETE (errors, not executes)');
    eq(symCount(), before, 'query_sql WITH-DELETE did not delete any rows');

    const ins = String(Q.querySql(conn, "WITH t AS (SELECT 1) INSERT INTO symbols(name,file,kind) VALUES('x','p','y')"));
    ok(ins.includes('error'), 'query_sql refuses WITH-prefixed INSERT (errors, not executes)');
    eq(symCount(), before, 'query_sql WITH-INSERT did not insert any rows');

    const upd = String(Q.querySql(conn, "WITH t AS (SELECT 1) UPDATE symbols SET name='z'"));
    ok(upd.includes('error'), 'query_sql refuses WITH-prefixed UPDATE (errors, not executes)');
    // a mass UPDATE would not change the row count, so also confirm no row was renamed to 'z'
    eq(conn.prepare("SELECT count(*) AS n FROM symbols WHERE name='z'").all()[0].n, 0,
      'query_sql WITH-UPDATE did not modify any rows');
    eq(symCount(), before, 'query_sql WITH-UPDATE left the row count unchanged');
  }
  // A plain read still works AFTER query_only=ON was set on this connection (the
  // pragma does not break the read path).
  has(Q.querySql(conn, "SELECT name FROM symbols WHERE name='a_main'"), 'a_main', 'query_sql SELECT still works after query_only pragma');

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

// Full-build idempotency (M7): loadGraph upserts nodes idempotently but INSERTs edges
// (deduped only within one batch), so a FULL (non-`files`) build must always reset —
// otherwise re-running `node src/build.js .` (no --reset) re-inserts every edge on top
// of the existing rows, doubling edge counts on the 2nd run. runBuild now forces
// reset:true on the full-build path regardless of the flag. Assert: two full builds
// with NO reset flag (opts default reset:false) leave edge + symbol counts unchanged,
// and a known edge (a_main -> a_helper CALLS) exists exactly once — not doubled.
async function fullBuildIdempotencyTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-idem-'));
  const src = join(work, 'src');
  cpSync(FIXTURE, src, { recursive: true });
  const project = realpathSync(src);
  const db = join(work, 'graph.db');

  const knownEdge = (conn) => conn.prepare(
    "SELECT count(*) n FROM edges e JOIN symbols s1 ON s1.id=e.src JOIN symbols s2 ON s2.id=e.dst " +
    "WHERE e.project=? AND e.type='CALLS' AND s1.name='a_main' AND s2.name='a_helper'",
  ).get(project).n;
  const totals = (conn) => ({
    edges: conn.prepare('SELECT count(*) n FROM edges WHERE project=?').get(project).n,
    symbols: conn.prepare('SELECT count(*) n FROM symbols WHERE project=?').get(project).n,
  });

  // First full build via the CLI-equivalent path — NO files, NO reset flag.
  await runBuild({ target: src, project, db });
  let conn = connect(db, { readonly: true });
  const first = totals(conn);
  eq(knownEdge(conn), 1, 'full-build idempotency: a_main->a_helper CALLS exists once after build 1');
  conn.close();

  // Second identical full build over the same tree — still NO reset flag.
  await runBuild({ target: src, project, db });
  conn = connect(db, { readonly: true });
  const second = totals(conn);
  eq(second.edges, first.edges, 'full-build idempotency: edge count unchanged after a 2nd non-reset full build');
  eq(second.symbols, first.symbols, 'full-build idempotency: symbol count unchanged after a 2nd non-reset full build');
  eq(knownEdge(conn), 1, 'full-build idempotency: a_main->a_helper CALLS still exists exactly once (not doubled)');
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

  // A lockfile left by a crashed writer must be stolen, not block forever / time out
  // — else one dead process wedges all future writes. Use a guaranteed-dead PID
  // (above Linux pid_max → process.kill throws ESRCH → the M9 liveness-steal fires
  // immediately); 999999 could be a LIVE pid on a busy machine and would wait the
  // full LOCK_TIMEOUT_MS. The mtime backdate below is now irrelevant under
  // liveness-steal but left as a harmless belt-and-suspenders.
  writeFileSync(db + '.lock', '2147483647');
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

// L16: ensureFresh single-flight + advance-on-success. Reads that arrive while a
// refresh is in flight must COALESCE onto that one reindex (no stampede, no stale
// serve), and lastFreshAt must advance only on SUCCESS so a failed best-effort
// reindex is retried on the very next read instead of being suppressed for a full
// TTL. Drives the real ensureFresh with injected staleNow/reindexFiles — no db or
// git needed. (Importing server.js is safe: its isCli guard keeps the transport
// from starting on import, so this does not hang the suite.)
async function ensureFreshTests() {
  const { ensureFresh, __setTestHooks, __resetFresh, __getLastFreshAt } = await import('../src/mcp/server.js');

  // 1) Coalescing + no-stale-serve: two calls, the second dispatched while the
  //    first's reindex is still in flight, share a SINGLE reindex and BOTH stay
  //    pending until it settles (the second caller must NOT return early serving
  //    stale data). We assert both are still unresolved while the gate is held, then
  //    release and confirm a single reindex ran.
  {
    __resetFresh();
    let calls = 0, release;
    const gate = new Promise((r) => { release = r; });
    __setTestHooks({ staleNow: () => ['a.c'], reindexFiles: async () => { calls++; await gate; } });
    const p1 = ensureFresh();
    const p2 = ensureFresh();   // in-flight → must coalesce, not start a second reindex
    // Neither ensureFresh may resolve while the reindex is gated: race each against a
    // short timer sentinel and assert the sentinel wins (both still pending).
    const sentinel = Symbol('pending');
    const timer = () => new Promise((r) => setTimeout(() => r(sentinel), 25));
    const w1 = await Promise.race([p1.then(() => 'resolved'), timer()]);
    const w2 = await Promise.race([p2.then(() => 'resolved'), timer()]);
    eq(w1, sentinel, 'ensureFresh: first caller stays pending until the in-flight reindex settles');
    eq(w2, sentinel, 'ensureFresh: second caller coalesces and waits (no stale early-return)');
    release();
    await Promise.all([p1, p2]);
    eq(calls, 1, 'ensureFresh: concurrent reads coalesce onto a single reindex');
  }

  // 2) Advance-on-success: after a successful reindex the window is claimed, so an
  //    immediate follow-up takes the fast path and does NOT re-index.
  {
    __resetFresh();
    let calls = 0;
    __setTestHooks({ staleNow: () => ['a.c'], reindexFiles: async () => { calls++; } });
    await ensureFresh();
    ok(__getLastFreshAt() > 0, 'ensureFresh: lastFreshAt advances after a successful reindex');
    await ensureFresh();
    eq(calls, 1, 'ensureFresh: a fresh window skips re-indexing (advance-on-success)');
  }

  // 3) No-advance-on-failure: a rejecting reindex is swallowed (best-effort), the
  //    window stays unclaimed, and the next read RE-attempts the reindex.
  {
    __resetFresh();
    let calls = 0;
    __setTestHooks({ staleNow: () => ['a.c'], reindexFiles: async () => { calls++; throw new Error('boom'); } });
    let threw = false;
    try { await ensureFresh(); } catch { threw = true; }
    ok(!threw, 'ensureFresh: a failed reindex does not throw (best-effort)');
    eq(__getLastFreshAt(), 0, 'ensureFresh: lastFreshAt NOT advanced after a failed reindex');
    await ensureFresh();
    eq(calls, 2, 'ensureFresh: a failed reindex is retried on the next read');
  }

  __resetFresh(); // leave module state clean
}

// The db lock steals based on the holder's PID LIVENESS, not a wall-clock timer
// (bug M9): a LIVE writer — incrementalBuild holds the lock through the whole
// parse/walk, which can outlast any fixed 30s window — must keep its lock, while
// a DEAD (crashed) holder is stolen immediately. Exercise the pure predicate with
// an injected liveness fn so the logic is deterministic and never waits for real.
function lockStealDecisionTest() {
  const dead = () => false;   // holder pid resolves to no live process (ESRCH)
  const alive = () => true;   // holder pid is a live process

  const HARD_MAX = 5 * 60_000; // LOCK_HARD_MAX_MS
  const STALE = 30_000;        // LOCK_STALE_MS

  // Dead holder, fresh lock -> steal (immediate crash recovery).
  eq(shouldStealLock({ pid: 999999, ageMs: 10, aliveFn: dead }), 'steal', 'lock: dead holder is stolen');

  // Live holder below the hard-max -> wait. This is the M9 regression: a slow but
  // live incremental build keeps its lock instead of being robbed.
  eq(shouldStealLock({ pid: 4242, ageMs: 90_000, aliveFn: alive }), 'wait', 'lock: live slow holder is NOT stolen');
  eq(shouldStealLock({ pid: 4242, ageMs: HARD_MAX - 1, aliveFn: alive }), 'wait', 'lock: live holder just under hard-max still waits');

  // Live holder past the hard-max backstop -> steal (PID reuse / wedged holder).
  eq(shouldStealLock({ pid: 4242, ageMs: HARD_MAX + 1, aliveFn: alive }), 'steal', 'lock: live holder past hard-max is stolen (backstop)');

  // No readable PID yet (the openSync-'wx'-won-but-PID-not-written race) -> fall
  // back to the old mtime staleness check.
  eq(shouldStealLock({ pid: null, ageMs: STALE - 1, aliveFn: alive }), 'wait', 'lock: unparseable PID below stale window waits');
  eq(shouldStealLock({ pid: null, ageMs: STALE + 1, aliveFn: alive }), 'steal', 'lock: unparseable PID past stale window is stolen (mtime fallback)');

  // A definitely-dead PID drives the real default liveness probe to steal, and a
  // live one (this very process) to wait — no aliveFn injected, no real blocking.
  eq(shouldStealLock({ pid: 2147483647, ageMs: 10 }), 'steal', 'lock: real probe steals a non-existent PID');
  eq(shouldStealLock({ pid: process.pid, ageMs: 90_000 }), 'wait', 'lock: real probe keeps this live process\' lock');
}

// A --reset rebuild wipes the project's rows before reloading. If the reload
// throws, that wipe must roll back — otherwise close() persists the emptied db
// and a transient failure during /wiregraph-rebuild destroys the existing graph.
// Inject a symbol with an unbindable value to force the insert phase to throw,
// then assert the prior graph survived (mimicking build.js's connect/try/finally).
async function rebuildDurabilityTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-dur-'));
  const db = join(work, 'graph.db');
  const project = join(work, 'proj');

  const g1 = new Graph(project);
  g1.addCompartment('r', project);
  g1.addFile('r', 'a.c', 'c');
  g1.addSymbol({ id: 'sym:r:a.c:keepme:1', compartment: 'r', file: 'a.c', name: 'keepme', kind: 'function', lang: 'c', startLine: 1, endLine: 2 });
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
  g2.addCompartment('r', project);
  // startLine is an object — sql.js can't bind it, so insSym.run throws mid-tx.
  g2.symbols.set('bad', { id: 'bad', compartment: 'r', file: 'b.c', name: 'bad', kind: 'function', lang: 'c', startLine: {}, endLine: 0, project });

  conn = connect(db);
  let threw = false;
  try { loadGraph(conn, g2, { reset: true }); } catch { threw = true; } finally { conn.close(); }
  ok(threw, 'durability: a poisoned --reset load throws');

  conn = connect(db, { readonly: true });
  has(Q.findSymbol(conn, project, 'keepme'), 'match(es)', 'durability: failed --reset leaves the prior graph intact');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// M6 — incremental durability. incrementalBuild prunes each changed file (each prune
// COMMITS in the in-memory db) BEFORE reloading the fresh symbols. If the reload
// throws, close() must DISCARD the in-memory mutations rather than persist the
// pruned-but-not-reloaded db over the good file (which would erase the edited file's
// symbols until a full rebuild). Also assert a NORMAL incremental still persists, so
// the fix isn't "never persist".
async function incrementalDurabilityTest() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-incr-dur-')));
  const project = join(work, 'proj');
  mkdirSync(project);
  const db = join(project, '.wiregraph', 'graph.db');
  const aFile = join(project, 'a.js');
  writeFileSync(join(project, 'package.json'), '{"name":"proj","type":"module"}');
  writeFileSync(aFile, 'export function foo(){ return 1; }\n');
  await runBuild({ target: project, project, db, reset: true });

  let conn = connect(db, { readonly: true });
  has(Q.findSymbol(conn, project, 'foo'), 'match(es)', 'incr-dur: baseline symbol foo present');
  conn.close();

  // Positive regression: a normal incremental (no forced error) still persists.
  writeFileSync(aFile, 'export function bar(){ return 1; }\n');
  await runBuild({ target: project, project, db, files: [aFile] });
  conn = connect(db, { readonly: true });
  has(Q.findSymbol(conn, project, 'bar'), 'match(es)', 'incr-dur: normal incremental persists the rename (bar present)');
  ok(!String(Q.findSymbol(conn, project, 'foo')).includes('match(es)'), 'incr-dur: normal incremental drops the old symbol (foo gone)');
  conn.close();

  // Force the reload to fail: stamp a schema version NEWER than this build. incrementalBuild
  // prunes the changed file, THEN loadGraph's newer-schema guard throws — the exact M6
  // scenario. On disk the graph currently holds `bar`.
  const w = connect(db);
  w.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('schema_version',?)").run(String(SCHEMA_VERSION + 1));
  w.close();

  writeFileSync(aFile, 'export function baz(){ return 1; }\n');
  let threw = false;
  try { await runBuild({ target: project, project, db, files: [aFile] }); }
  catch { threw = true; }
  ok(threw, 'incr-dur: incremental against a newer-schema db throws (reload guard)');

  conn = connect(db, { readonly: true });
  has(Q.findSymbol(conn, project, 'bar'), 'match(es)', 'incr-dur: failed incremental preserves the prior symbol (bar NOT pruned to empty)');
  ok(!String(Q.findSymbol(conn, project, 'baz')).includes('match(es)'), 'incr-dur: failed incremental did not persist the half-applied reload (baz absent)');
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
  const db = join(project, '.wiregraph', 'graph.db');           // where summarize() looks
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
  process.env.WIREGRAPH_METRICS = '0';
  M.record(project, { kind: 'use', tool: 'get_source' });
  delete process.env.WIREGRAPH_METRICS;
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

// Measured recurring context: summarize() must turn logged turn/boundary events
// into a REAL residency per get_source read (turns living between the read and the
// next context boundary) instead of the old assumed window — and degrade cleanly to
// the assumption range when no turn data exists. Drives summarize() over a synthetic
// .wiregraph/metrics.jsonl written straight to disk (summarize reads the file; it
// does not gate on posture, and with no grep events it never opens the db).
async function measuredRecurringTests() {
  const M = await import('../scripts/lib/metrics.mjs');
  const roundN = (n) => Math.round(n);
  // Write raw event lines (each already carrying its own `t`, as record() would) to
  // a fresh temp project's metrics.jsonl, then summarize with no session filter.
  const runCase = async (events) => {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-recur-')));
    const p = M.metricsPath(proj);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const agg = await M.summarize(proj);
    rmSync(proj, { recursive: true, force: true });
    return agg;
  };
  const S = 'sess-1';
  const use = (t, saved) => ({ t, sessionId: S, kind: 'use', tool: 'get_source', savedTokens: saved, fileTokens: saved + 100, returnedTokens: 100 });
  const turn = (t) => ({ t, sessionId: S, kind: 'turn' });
  const bound = (t, reason) => ({ t, sessionId: S, kind: 'boundary', reason });

  // (1) a read then 5 turns, no boundary → residency 5 → 1000·(1+0.1·5)=1500.
  let agg = await runCase([use(100, 1000), turn(101), turn(102), turn(103), turn(104), turn(105)]);
  ok(agg.measuredCoverage, 'recur(1): turn data present ⇒ measured coverage');
  eq(agg.turns, 5, 'recur(1): counts all 5 turns');
  eq(agg.boundaries, 0, 'recur(1): no boundaries');
  eq(roundN(agg.recurringMeasured), 1500, 'recur(1): residency 5 ⇒ 1000·(1+0.1·5)=1500');

  // (2) a read, 3 turns, a compact boundary, 4 more turns → the boundary STOPS the
  // count at 3 → 1000·(1+0.1·3)=1300 (the 4 post-boundary turns don't ride the read).
  agg = await runCase([use(100, 1000), turn(101), turn(102), turn(103), bound(104, 'compact'), turn(105), turn(106), turn(107), turn(108)]);
  eq(agg.turns, 7, 'recur(2): counts every turn event');
  eq(agg.boundaries, 1, 'recur(2): one compaction boundary');
  eq(roundN(agg.recurringMeasured), 1300, 'recur(2): compaction caps residency at 3 ⇒ 1300');

  // (3) a /clear boundary resets: read A (before the clear) counts only its 2 turns,
  // read B (after) counts its 3 → 1000·1.2 + 1000·1.3 = 2500. The clear prevents
  // read A from counting the later turns.
  agg = await runCase([use(100, 1000), turn(101), turn(102), bound(103, 'clear'), use(104, 1000), turn(105), turn(106), turn(107)]);
  eq(agg.boundaries, 1, 'recur(3): one clear boundary');
  eq(agg.getSourceCalls, 2, 'recur(3): two reads');
  eq(roundN(agg.recurringMeasured), 2500, 'recur(3): /clear resets residency ⇒ 1200 + 1300 = 2500');

  // (4) no turn events at all (pre-upgrade log) → no measured coverage, no crash, and
  // formatReport falls back to the assumption RANGE, clearly labeled an estimate.
  agg = await runCase([use(100, 1000)]);
  ok(!agg.measuredCoverage, 'recur(4): no turns ⇒ measured coverage is false (fallback)');
  eq(agg.recurringMeasured, 0, 'recur(4): nothing measured without turn data');
  const rep = M.formatReport(agg, '/tmp/x', {});
  has(rep, 'residency', 'recur(4): fallback report still renders the SESSION CONTEXT residency line');
  has(rep, '(estimated)', 'recur(4): fallback recurring figure is labeled an estimate');
  ok(!rep.includes('(measured)'), 'recur(4): fallback must NOT claim a measured figure');

  // (5) interleaved sessions must NOT cross-contaminate. Two sessions log into the
  // SAME file, reads + turns interleaved by time. Per-session correlation makes each
  // read count only ITS OWN session's turns: read A rides A's 2 turns (⇒1200), read B
  // rides B's 3 turns (⇒1300); total 2500. A single global timeline would let each
  // read ride all 5 turns (⇒3000) — the contamination this guards against.
  const uS = (t, sid, saved) => ({ t, sessionId: sid, kind: 'use', tool: 'get_source', savedTokens: saved, fileTokens: saved + 100, returnedTokens: 100 });
  const tS = (t, sid) => ({ t, sessionId: sid, kind: 'turn' });
  const bS = (t, sid, reason) => ({ t, sessionId: sid, kind: 'boundary', reason });
  agg = await runCase([
    uS(100, 'A', 1000), uS(101, 'B', 1000),
    tS(102, 'A'), tS(103, 'B'), tS(104, 'A'), tS(105, 'B'), tS(107, 'B'),
  ]);
  eq(agg.turns, 5, 'recur(5): counts turns across both interleaved sessions');
  eq(agg.getSourceCalls, 2, 'recur(5): one read per session');
  eq(roundN(agg.recurringMeasured), 2500, 'recur(5): per-session residency A=2,B=3 ⇒ 1200+1300, no cross-contamination');

  // (5b) a boundary in ONE session must cap only that session's read, not the other's.
  // Both sessions log their own turns (so both self-correlate). Session B compacts at
  // t=103, capping read B to its 1 pre-boundary turn (⇒1100); read A has no boundary
  // and rides its 3 turns (⇒1300); total 2400. A shared timeline would let B's
  // boundary truncate read A too (⇒2200).
  agg = await runCase([
    uS(100, 'A', 1000), uS(101, 'B', 1000),
    tS(102, 'B'), bS(103, 'B', 'compact'), tS(104, 'A'), tS(105, 'B'), tS(106, 'A'), tS(108, 'A'),
  ]);
  eq(agg.turns, 5, 'recur(5b): every turn across both sessions counted');
  eq(agg.boundaries, 1, 'recur(5b): the single (session-B) boundary counted');
  eq(roundN(agg.recurringMeasured), 2400, 'recur(5b): B-boundary caps only read B (1100); read A rides its 3 turns (1300)');

  // measured report labels itself honestly
  agg = await runCase([use(100, 1000), turn(101), turn(102)]);
  const measuredRep = M.formatReport(agg, '/tmp/x', {});
  has(measuredRep, 'measured', 'recur: measured report labels the recurring figure measured');
  has(measuredRep, 'boundaries', 'recur: measured report states the turn/boundary counts');
}

// Per-session report filter (L14): 'use' events logged by the long-lived MCP server
// usually carry a null sessionId (it rarely sees the hook's CLAUDE_SESSION_ID) while
// turn events carry the real hook id. summarize(project, {sessionId}) must therefore
// KEEP null-session reads in a per-session view (else the report zeroes out), while
// still filtering events that carry a DIFFERENT real session id. Drives summarize over
// a synthetic metrics.jsonl written straight to disk, exactly like runCase above.
async function sessionFilterTests() {
  const M = await import('../scripts/lib/metrics.mjs');
  const runCase = async (events, opts) => {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-sessfilter-')));
    const p = M.metricsPath(proj);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const agg = await M.summarize(proj, opts);
    rmSync(proj, { recursive: true, force: true });
    return agg;
  };
  // MCP reads with null sessionId (the common case) + turns carrying the real hook id.
  const nullRead = (t, saved) => ({ t, sessionId: null, kind: 'use', tool: 'get_source', savedTokens: saved, fileTokens: saved + 100, returnedTokens: 100 });
  const s1Turn = (t) => ({ t, sessionId: 'S1', kind: 'turn' });
  const s2Read = (t, saved) => ({ t, sessionId: 'S2', kind: 'use', tool: 'get_source', savedTokens: saved, fileTokens: saved + 100, returnedTokens: 100 });

  const events = [nullRead(100, 500), nullRead(101, 300), s1Turn(102), s1Turn(103), s2Read(104, 999)];

  // (1) Filtering --session S1: the null-session reads are KEPT (unattributable MCP
  // reads still count toward the session view), while S2's read is excluded.
  let agg = await runCase(events, { sessionId: 'S1' });
  eq(agg.getSourceCalls, 2, 'sessionFilter(1): null-session reads counted under --session S1');
  eq(agg.savedTokens, 800, 'sessionFilter(1): null-session savedTokens summed (500+300), NOT zeroed');
  ok(agg.savedTokens > 0, 'sessionFilter(1): per-session savedTokens is non-zero (the L14 bug)');

  // (2) Regression: an event with a DIFFERENT real session id stays excluded under
  // --session S1 — real-id attribution still works; we did not just disable filtering.
  ok(agg.savedTokens !== 800 + 999, 'sessionFilter(2): S2 read is excluded from the S1 view (real-id filtering intact)');
  agg = await runCase(events, { sessionId: 'S2' });
  eq(agg.getSourceCalls, 3, 'sessionFilter(2): under --session S2, S2 read + both null reads count');
  eq(agg.savedTokens, 500 + 300 + 999, 'sessionFilter(2): S2 view sums S2 read + null reads');

  // (3) Global path (no sessionId) counts every read regardless of session.
  agg = await runCase(events, {});
  eq(agg.getSourceCalls, 3, 'sessionFilter(3): global view counts all reads');
  eq(agg.savedTokens, 500 + 300 + 999, 'sessionFilter(3): global savedTokens sums every read');
}

// The turn/boundary HOOKS are pure "read stdin JSON → append one event via record()"
// scripts. Drive each as a real subprocess (the way Claude Code invokes it): pipe a
// synthetic UserPromptSubmit / PreCompact payload on stdin against an INDEXED temp
// project, then assert the exact event line landed in metrics.jsonl. This is the seam
// summarize() reads, so it closes the loop from hook write → measured residency.
const PROMPT_HOOK = join(HERE, '..', 'scripts', 'hooks', 'prompt-turn.mjs');
const COMPACT_HOOK = join(HERE, '..', 'scripts', 'hooks', 'pre-compact.mjs');
async function hookAppendTests() {
  const S = await import('../scripts/lib/state.mjs');
  const M = await import('../scripts/lib/metrics.mjs');
  const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-hook-')));
  S.writeState(proj, S.defaultState(proj)); // balanced posture ⇒ record() writes

  // Run a hook as Claude Code does: stdin = the event payload, CLAUDE_PROJECT_DIR set.
  const runHook = (hookPath, payload) => new Promise((resolve, reject) => {
    const child = execFile('node', [hookPath], { env: { ...process.env, CLAUDE_PROJECT_DIR: proj } },
      (err) => (err ? reject(err) : resolve()));
    child.stdin.end(JSON.stringify(payload));
  });

  await runHook(PROMPT_HOOK, { session_id: 'hook-sess', cwd: proj });   // UserPromptSubmit
  await runHook(COMPACT_HOOK, { session_id: 'hook-sess', cwd: proj });  // PreCompact

  const lines = readFileSync(M.metricsPath(proj), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  eq(lines.length, 2, 'hooks: two events appended, one per hook invocation');
  const turnEv = lines.find((e) => e.kind === 'turn');
  ok(turnEv && turnEv.sessionId === 'hook-sess', 'hooks: UserPromptSubmit appends a turn event carrying the session id');
  const boundEv = lines.find((e) => e.kind === 'boundary');
  ok(boundEv && boundEv.reason === 'compact' && boundEv.sessionId === 'hook-sess', 'hooks: PreCompact appends a compact boundary event with the session id');
  ok(lines.every((e) => typeof e.t === 'number'), 'hooks: each appended event is stamped with a numeric timestamp');

  // A summarize() over exactly what the hooks wrote sees the turn + boundary — proving
  // the hook payloads flow end-to-end into the measured-residency counters.
  const agg = await M.summarize(proj);
  eq(agg.turns, 1, 'hooks: summarize counts the hook-written turn');
  eq(agg.boundaries, 1, 'hooks: summarize counts the hook-written boundary');

  rmSync(proj, { recursive: true, force: true });
}

// Soft metrics migration (CHANGE B) + per-session segmentation (CHANGE A). The
// migration ARCHIVES a project's pre-v2 metrics.jsonl to metrics.v1.jsonl and stamps
// state.metricsVersion, exactly ONCE, version-gated + idempotent + best-effort +
// non-clobbering. It self-applies from every post-update entry point (SessionStart,
// runBuild, summarize). These tests drive migrateMetrics directly and through two of
// those entry points as real integrations, and check that a SessionStart boundary
// segments the residency timeline so a read cannot accrue a later session's turns.
const SESSION_START_HOOK = join(HERE, '..', 'scripts', 'hooks', 'session-start.mjs');
async function metricsMigrationTests() {
  const M = await import('../scripts/lib/metrics.mjs');
  const S = await import('../scripts/lib/state.mjs');
  const V = S.METRICS_VERSION;

  // A state.json as an OLDER version wrote it: identical to defaultState but WITHOUT the
  // metricsVersion field (normalizeState never backfills it), which is the signal to migrate.
  const oldStyleState = (proj) => { const s = S.defaultState(proj); delete s.metricsVersion; return s; };
  const wgDir = (proj) => S.wiregraphDir(proj);
  const archive = (proj, n = 1) => join(wgDir(proj), n === 1 ? 'metrics.v1.jsonl' : `metrics.v1.${n}.jsonl`);
  const writeLog = (proj, body) => { const p = M.metricsPath(proj); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };

  // (a) archives an existing log to metrics.v1.jsonl exactly once + bumps the version;
  //     a second call is a pure no-op (version now current).
  {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-mig-a-')));
    S.writeState(proj, oldStyleState(proj));
    writeLog(proj, JSON.stringify({ t: 1, kind: 'use', tool: 'get_source', savedTokens: 5 }) + '\n');
    ok(S.readState(proj).metricsVersion === undefined, 'migrate(a): pre-v2 state lacks metricsVersion');

    M.migrateMetrics(proj);
    ok(!existsSync(M.metricsPath(proj)), 'migrate(a): live metrics.jsonl was moved away');
    ok(existsSync(archive(proj)), 'migrate(a): archived to metrics.v1.jsonl');
    has(readFileSync(archive(proj), 'utf8'), '"savedTokens":5', 'migrate(a): archive holds the pre-v2 content verbatim');
    eq(S.readState(proj).metricsVersion, V, 'migrate(a): metricsVersion stamped to current');

    M.migrateMetrics(proj); // idempotent second call
    ok(!existsSync(archive(proj, 2)), 'migrate(a): second call creates NO further archive (no-op)');
    ok(!existsSync(M.metricsPath(proj)), 'migrate(a): second call does not resurrect a live log');
    eq(S.readState(proj).metricsVersion, V, 'migrate(a): version unchanged after the no-op');
    rmSync(proj, { recursive: true, force: true });
  }

  // (b) a fresh defaultState project (metricsVersion already current) does NOT migrate.
  {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-mig-b-')));
    S.writeState(proj, S.defaultState(proj)); // stamps metricsVersion = current
    writeLog(proj, JSON.stringify({ t: 1, kind: 'use', tool: 'get_source', savedTokens: 9 }) + '\n');
    M.migrateMetrics(proj);
    ok(existsSync(M.metricsPath(proj)), 'migrate(b): fresh install keeps its live log (no archive)');
    ok(!existsSync(archive(proj)), 'migrate(b): fresh install never creates a v1 archive');
    rmSync(proj, { recursive: true, force: true });
  }

  // (c) non-clobbering: a pre-existing metrics.v1.jsonl is never overwritten — the new
  //     archive takes a unique suffix instead.
  {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-mig-c-')));
    S.writeState(proj, oldStyleState(proj));
    writeLog(proj, 'NEW-LIVE\n');
    writeFileSync(archive(proj), 'OLD-ARCHIVE\n'); // a prior archive already sitting there
    M.migrateMetrics(proj);
    eq(readFileSync(archive(proj), 'utf8'), 'OLD-ARCHIVE\n', 'migrate(c): existing metrics.v1.jsonl left untouched');
    ok(existsSync(archive(proj, 2)), 'migrate(c): new archive chose a unique suffix (metrics.v1.2.jsonl)');
    eq(readFileSync(archive(proj, 2), 'utf8'), 'NEW-LIVE\n', 'migrate(c): the pre-v2 log went to the unique-suffixed archive');
    eq(S.readState(proj).metricsVersion, V, 'migrate(c): version stamped');
    rmSync(proj, { recursive: true, force: true });
  }

  // (d) after migration, summarize() reads ONLY the fresh live log — the archive's
  //     numbers are never counted — and flags preV2Archived for the dashboard footer.
  {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-mig-d-')));
    S.writeState(proj, oldStyleState(proj));
    writeLog(proj, JSON.stringify({ t: 1, kind: 'use', tool: 'get_source', savedTokens: 111, fileTokens: 211, returnedTokens: 100 }) + '\n');
    M.migrateMetrics(proj); // archives the saved:111 log
    writeLog(proj, JSON.stringify({ t: 2, kind: 'use', tool: 'get_source', savedTokens: 999, fileTokens: 1099, returnedTokens: 100 }) + '\n');
    const agg = await M.summarize(proj);
    eq(agg.getSourceCalls, 1, 'migrate(d): summarize counts only the fresh log read');
    eq(agg.savedTokens, 999, 'migrate(d): archived 111 is ignored; only the fresh 999 counts');
    ok(agg.preV2Archived, 'migrate(d): preV2Archived flag set when an archive exists');
    has(M.formatReport(agg, proj, {}), 'pre-v2 archived', 'migrate(d): dashboard footer notes the archive');
    rmSync(proj, { recursive: true, force: true });
  }

  // (e) SEGMENTATION (CHANGE A): a read in session A, then a SessionStart boundary, then
  //     session B's turns. The boundary caps read A's residency, so it accrues ZERO of
  //     B's turns — recurring = saved·(1+0.1·0) = saved. Without the boundary the read
  //     would ride all 3 later turns (saved·1.3). Written with no state.json so
  //     summarize's own migrate no-ops (null state) and the raw log is read as-is.
  {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-seg-')));
    const events = [
      { t: 100, kind: 'use', tool: 'get_source', savedTokens: 1000, fileTokens: 1100, returnedTokens: 100 }, // sessionId absent → MCP null
      { t: 101, sessionId: 'B', kind: 'boundary', reason: 'startup' },  // session B starts → segments the timeline
      { t: 102, sessionId: 'B', kind: 'turn' }, { t: 103, sessionId: 'B', kind: 'turn' }, { t: 104, sessionId: 'B', kind: 'turn' },
    ];
    writeLog(proj, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const agg = await M.summarize(proj);
    eq(agg.turns, 3, 'segment(e): all 3 session-B turns counted globally');
    eq(agg.boundaries, 1, 'segment(e): the SessionStart boundary counted');
    eq(Math.round(agg.recurringMeasured), 1000, "segment(e): SessionStart boundary caps read A ⇒ 0 recurring turns from session B (not 1300)");
    ok(!existsSync(archive(proj)), 'segment(e): no state ⇒ summarize did not archive the raw log');
    rmSync(proj, { recursive: true, force: true });
  }

  // (f1) AUTO-ON-UPDATE via the real SessionStart hook subprocess: an old-style state
  //      (no metricsVersion) is migrated once, and this session's boundary lands in the
  //      FRESH log (proving migrate ran BEFORE the boundary record).
  {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-mig-f1-')));
    S.writeState(proj, oldStyleState(proj)); // balanced posture ⇒ record() writes
    writeLog(proj, JSON.stringify({ t: 1, kind: 'use', tool: 'get_source', savedTokens: 42 }) + '\n');
    await new Promise((resolve, reject) => {
      const child = execFile('node', [SESSION_START_HOOK], { env: { ...process.env, CLAUDE_PROJECT_DIR: proj } },
        (err) => (err ? reject(err) : resolve()));
      child.stdin.end(JSON.stringify({ session_id: 'sess-f1', source: 'startup', cwd: proj }));
    });
    ok(existsSync(archive(proj)), 'migrate(f1): SessionStart hook archived the pre-v2 log');
    has(readFileSync(archive(proj), 'utf8'), '"savedTokens":42', 'migrate(f1): archive holds the pre-v2 content');
    eq(S.readState(proj).metricsVersion, V, 'migrate(f1): SessionStart hook stamped metricsVersion');
    const fresh = readFileSync(M.metricsPath(proj), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok(fresh.every((e) => e.savedTokens !== 42), 'migrate(f1): the pre-v2 read is NOT in the fresh log');
    const b = fresh.find((e) => e.kind === 'boundary');
    ok(b && b.reason === 'startup' && b.sessionId === 'sess-f1', 'migrate(f1): this session boundary landed in the FRESH log with reason=source');
    rmSync(proj, { recursive: true, force: true });
  }

  // (f2) AUTO-ON-UPDATE via runBuild: an old-style state present before a build is
  //      migrated once as the build funnels through runBuild.
  {
    const work = mkdtempSync(join(tmpdir(), 'cg-mig-f2-'));
    const src = join(work, 'src');
    cpSync(FIXTURE, src, { recursive: true });
    const project = realpathSync(src);
    const db = join(project, '.wiregraph', 'graph.db');
    S.writeState(project, oldStyleState(project));
    writeLog(project, JSON.stringify({ t: 1, kind: 'use', tool: 'get_source', savedTokens: 7 }) + '\n');
    await runBuild({ target: src, project, db, reset: true });
    ok(existsSync(archive(project)), 'migrate(f2): runBuild archived the pre-v2 log');
    has(readFileSync(archive(project), 'utf8'), '"savedTokens":7', 'migrate(f2): archive holds the pre-v2 content');
    eq(S.readState(project).metricsVersion, V, 'migrate(f2): runBuild stamped metricsVersion');
    ok(!existsSync(M.metricsPath(project)), 'migrate(f2): build writes no live metrics, so the fresh log starts empty');
    rmSync(work, { recursive: true, force: true });
  }
}

// Subdirectory resolution: findIndexedRoot walks up to the indexed workspace root
// so wiregraph works when invoked from inside a sub-repo.
async function resolutionTests() {
  const S = await import('../scripts/lib/state.mjs');
  const ws = mkdtempSync(join(tmpdir(), 'cg-res-'));
  const deep = join(ws, 'repo-a', 'src', 'deep');
  mkdirSync(deep, { recursive: true });
  mkdirSync(join(ws, '.wiregraph'), { recursive: true });
  writeFileSync(join(ws, '.wiregraph', 'state.json'), '{}');
  eq(S.findIndexedRoot(deep), realpathSync(ws), 'findIndexedRoot: walks up to the workspace root from a sub-repo');
  const orphan = mkdtempSync(join(tmpdir(), 'cg-orph-'));
  eq(S.findIndexedRoot(orphan), null, 'findIndexedRoot: null for an uninitialized tree');

  // `state.mjs check` is the /wiregraph-init reroute detector: it must report an
  // already-indexed project (from a sub-repo too) so init can steer to rebuild.
  const STATE = join(HERE, '..', 'scripts', 'lib', 'state.mjs');
  const fromSub = (await execFileP('node', [STATE, 'check', deep])).stdout;
  ok(/^indexed: yes$/m.test(fromSub) && /sameDir: no/.test(fromSub), 'check: reports indexed from a sub-repo (sameDir:no)');
  const fromNone = (await execFileP('node', [STATE, 'check', orphan])).stdout;
  eq(fromNone.trim(), 'indexed: no', 'check: reports not-indexed for an uninitialized tree');

  // $HOME handling: a deliberately-indexed workspace AT $HOME must be honored when
  // the caller IS $HOME, but a $HOME index must NOT hijack a nested project reached
  // by walking up. (homeDir is injectable so we can test without touching real $HOME.)
  const fakeHome = mkdtempSync(join(tmpdir(), 'cg-home-'));
  mkdirSync(join(fakeHome, '.wiregraph'), { recursive: true });
  writeFileSync(join(fakeHome, '.wiregraph', 'state.json'), '{}');
  eq(S.findIndexedRoot(fakeHome, fakeHome), realpathSync(fakeHome), 'findIndexedRoot: honors an index AT $HOME when the caller is $HOME');
  const nested = join(fakeHome, 'proj', 'sub');
  mkdirSync(nested, { recursive: true });
  eq(S.findIndexedRoot(nested, fakeHome), null, 'findIndexedRoot: a $HOME index does NOT hijack a nested unindexed project');
  const belowWs = join(fakeHome, 'ws');
  const belowDeep = join(belowWs, 'a', 'b');
  mkdirSync(belowDeep, { recursive: true });
  mkdirSync(join(belowWs, '.wiregraph'), { recursive: true });
  writeFileSync(join(belowWs, '.wiregraph', 'state.json'), '{}');
  eq(S.findIndexedRoot(belowDeep, fakeHome), realpathSync(belowWs), 'findIndexedRoot: an index BELOW $HOME is honored from a sub-dir');

  rmSync(ws, { recursive: true, force: true });
  rmSync(orphan, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
}

// Contract inference: HTTP routes -> cross-repo seams -> draft AsyncAPI that the
// EXISTING pipeline turns back into cross-repo REFERENCES edges (the end-to-end
// thesis). Two repos side-by-side, each its own git repo, no hand-written specs.
async function contractsTests() {
  const I = await import('../src/contracts/infer.js');
  const work = mkdtempSync(join(tmpdir(), 'cg-contracts-'));
  const svc = join(work, 'svc-api'), app = join(work, 'mobile-app');
  cpSync(join(FIXTURE_CONTRACTS, 'svc-api'), svc, { recursive: true });
  cpSync(join(FIXTURE_CONTRACTS, 'mobile-app'), app, { recursive: true });
  mkdirSync(join(svc, '.git'), { recursive: true });   // distinct git repos => cross-repo attribution
  mkdirSync(join(app, '.git'), { recursive: true });
  const project = realpathSync(work);

  const candidates = I.extractCandidates(project);
  ok(candidates.some((c) => c.kind === 'wire' && c.role === 'in' && c.token === '/api/register'), 'contracts: server route detected (role in)');
  ok(candidates.some((c) => c.kind === 'wire' && c.role === 'out' && c.token === '/api/register'), 'contracts: client call detected (role out)');

  eq(I.toAsyncApiPath('/api/users/:id'), '/api/users/{id}', 'contracts: path normalized to AsyncAPI {param} form');

  const seams = I.clusterSeams(candidates);
  eq(seams.length, 1, 'contracts: exactly one cross-repo seam (server-only /api/users/:id excluded)');
  eq(seams[0].token, '/api/register', 'contracts: seam token is /api/register');
  eq(seams[0].compartments.length, 2, 'contracts: seam spans both compartments');
  ok(seams[0].inCompartments.includes('svc-api'), 'contracts: server side learned (svc-api defines the route)');

  // round-trip: generated YAML must re-extract through loadContracts/matchContracts
  const yaml = I.synthesizeAsyncApi(seams);
  has(yaml, 'address: /api/register', 'contracts: generated spec emits the channel address key');
  const cdir = join(project, 'contracts');
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 'wiregraph-inferred.asyncapi.yaml'), yaml);
  const db = join(project, '.wiregraph', 'graph.db');
  await runBuild({ target: project, project, db, reset: true });
  const conn = connect(db, { readonly: true });
  const repos = new Set(
    conn.prepare("SELECT DISTINCT s.compartment repo FROM edges e JOIN symbols s ON s.id=e.src WHERE e.project=? AND e.type='REFERENCES'")
      .all(project).map((r) => r.repo),
  );
  ok(repos.has('svc-api') && repos.has('mobile-app'),
    `contracts: round-trip yields cross-repo REFERENCES from both repos (got ${[...repos].join(', ') || 'none'})`);

  // Axis 1: the inferred spec encodes producer/consumer compartments, so directional
  // WIRE edges are derived WITHOUT setting WIREGRAPH_SERVER_REPO — oriented from the
  // caller (out = mobile-app) to the definer (in = svc-api).
  const wires = conn.prepare(
    `SELECT sp.compartment src, dp.compartment dst FROM edges e
       JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
      WHERE e.project=? AND e.type='WIRE'`).all(project);
  ok(wires.length >= 1, `contracts: inferred spec yields WIRE edges with no WIREGRAPH_SERVER_REPO (got ${wires.length})`);
  ok(wires.some((w) => w.src === 'mobile-app' && w.dst === 'svc-api'),
    `contracts: WIRE oriented producer(mobile-app) -> consumer(svc-api) (got ${wires.map((w) => w.src + '->' + w.dst).join(', ') || 'none'})`);
  conn.close();
  rmSync(work, { recursive: true, force: true });
}

// M11 word-boundary attribution: a contract identifier token gets a REFERENCES edge
// attributed to the ENCLOSING symbol of its first WORD-BOUNDED occurrence — not the
// first raw substring hit. When the token appears earlier embedded inside a larger
// identifier (superuser_id_map contains user_id, no \b there) and only later as a
// genuine boundary-delimited token, the edge must attach to the LATER function. The
// old code took `at = text.indexOf(tok)` (the embedded position) and merely validated
// existence with a whole-file \b regex, so the later match kept the edge alive while
// `at` still pointed at the earlier, non-matching site — mis-attributing the edge.
async function wordBoundaryAttributionTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-wb-'));
  mkdirSync(join(work, '.git'), { recursive: true });
  // earlyOne: user_id ONLY as a substring of superuser_id_map (no \b match here).
  // realOne (LATER): a genuine \b-delimited user_id — the correct owner of the edge.
  writeFileSync(join(work, 'app.js'),
    'function earlyOne() { const superuser_id_map = {}; return superuser_id_map; }\n' +
    "function realOne()  { return fetch('/x', { headers: { user_id: 1 } }); }\n");
  // Hand-written contract defining the field token user_id (underscore + len>=6 =>
  // isDistinctive). Single compartment: we only care WHICH symbol owns the edge.
  const cdir = join(work, 'contracts'); mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 'ids.asyncapi.yaml'),
    'asyncapi: 3.0.0\n' +
    'info: { title: Ids, version: 1.0.0 }\n' +
    'channels:\n' +
    '  ids:\n' +
    '    address: /x\n' +
    '    messages:\n' +
    '      m:\n' +
    '        payload:\n' +
    '          type: object\n' +
    '          properties:\n' +
    '            user_id: { type: integer }\n' +
    'operations:\n' +
    '  recv:\n' +
    '    action: receive\n' +
    '    channel: { $ref: "#/channels/ids" }\n' +
    '    messages: [{ $ref: "#/channels/ids/messages/m" }]\n');
  const project = realpathSync(work);
  const db = join(work, '.wiregraph', 'graph.db');
  await runBuild({ target: project, project, db, reset: true });
  const conn = connect(db, { readonly: true });
  const owners = conn.prepare(
    "SELECT s.name name FROM edges e JOIN symbols s ON s.id=e.src WHERE e.project=? AND e.type='REFERENCES' AND e.token=?")
    .all(project, 'user_id').map((r) => r.name);
  // The edge must be owned by realOne — the later \b-delimited occurrence — NOT by
  // earlyOne (the embedded substring's enclosing symbol) nor <module>.
  ok(owners.includes('realOne'),
    `m11: user_id REFERENCES attributed to realOne (the \\b-delimited site) — got [${owners.join(', ') || 'none'}]`);
  ok(!owners.includes('earlyOne') && !owners.includes('<module>'),
    `m11: user_id NOT mis-attributed to the embedded substring's symbol — got [${owners.join(', ') || 'none'}]`);
  conn.close();
  rmSync(work, { recursive: true, force: true });
}

// Messaging detector: a topic published in one repo and subscribed in another is a
// cross-repo seam that round-trips to REFERENCES edges, just like an HTTP path.
async function messagingTest() {
  const I = await import('../src/contracts/infer.js');
  const work = mkdtempSync(join(tmpdir(), 'cg-msg-'));
  const pub = join(work, 'producer'), sub = join(work, 'consumer');
  mkdirSync(join(pub, '.git'), { recursive: true });
  mkdirSync(join(sub, '.git'), { recursive: true });
  writeFileSync(join(pub, 'emit.js'), "function ping(ch) { ch.publish('device.heartbeat', JSON.stringify({ ok: 1 })); }\n");
  writeFileSync(join(sub, 'recv.js'), "function listen(ch) { ch.subscribe('device.heartbeat', (m) => handle(m)); }\n");
  const project = realpathSync(work);

  const seams = I.clusterSeams(I.extractCandidates(project));
  const msg = seams.find((s) => s.kind === 'message' && s.token === 'device.heartbeat');
  ok(msg, `messaging: cross-repo topic seam detected (got ${seams.map((s) => s.kind + ':' + s.token).join(', ') || 'none'})`);
  ok(msg && msg.compartments.length === 2, 'messaging: topic seam spans producer + consumer compartments');

  const yaml = I.synthesizeAsyncApi(seams);
  has(yaml, 'address: device.heartbeat', 'messaging: generated channel address is the topic');
  const cdir = join(project, 'contracts'); mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 'wiregraph-inferred.asyncapi.yaml'), yaml);
  const db = join(project, '.wiregraph', 'graph.db');
  await runBuild({ target: project, project, db, reset: true });
  const conn = connect(db, { readonly: true });
  const repos = new Set(
    conn.prepare("SELECT DISTINCT s.compartment repo FROM edges e JOIN symbols s ON s.id=e.src WHERE e.project=? AND e.type='REFERENCES'")
      .all(project).map((r) => r.repo),
  );
  ok(repos.has('producer') && repos.has('consumer'),
    `messaging: round-trip links producer<->consumer via the topic (got ${[...repos].join(', ') || 'none'})`);
  conn.close();
  rmSync(work, { recursive: true, force: true });
}

// Contract DRIFT: with a HAND-WRITTEN AsyncAPI spec (no x-wiregraph-* roles, like
// log-server's canonical contracts), trace_contract must diff the contract's FULL
// defined-token set against the code and SAY when code has drifted off it — the
// exact failure that made this whole feature necessary. Fixture: a spec defining
// four tokens, where the code satisfies two, half-wires one, and abandons one.
async function contractDriftTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-drift2-'));
  const agent = join(work, 'agent'), server = join(work, 'server');
  mkdirSync(join(agent, '.git'), { recursive: true }); // distinct repos => compartments
  mkdirSync(join(server, '.git'), { recursive: true });
  // agent produces: touches device_id, firmware_version, battery_pct + the route.
  writeFileSync(join(agent, 'hb.js'),
    'function sendHeartbeat(client) {\n' +
    '  const body = { device_id: readId(), firmware_version: fw(), battery_pct: batt() };\n' +
    "  return client.post('/api/heartbeat', body);\n" +
    '}\n');
  // server consumes: touches device_id, firmware_version + the route. NOT battery_pct.
  writeFileSync(join(server, 'hb.js'),
    'function handleHeartbeat(req, res) {\n' +
    '  const { device_id, firmware_version } = req.body;\n' +
    '  store(device_id, firmware_version); res.end();\n' +
    '}\n' +
    "function routes(app) { app.post('/api/heartbeat', handleHeartbeat); }\n");
  // Hand-written contract (no x-wiregraph-* producers/consumers) defining a token
  // — legacy_slot_id — that NO code references any more: the drift.
  const cdir = join(work, 'contracts'); mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 'heartbeat.asyncapi.yaml'),
    'asyncapi: 3.0.0\n' +
    'info: { title: Heartbeat, version: 1.0.0 }\n' +
    'channels:\n' +
    '  heartbeat:\n' +
    '    address: /api/heartbeat\n' +
    '    messages:\n' +
    '      beat:\n' +
    '        payload:\n' +
    '          type: object\n' +
    '          properties:\n' +
    '            device_id: { type: string }\n' +
    '            firmware_version: { type: string }\n' +
    '            battery_pct: { type: integer }\n' +
    '            legacy_slot_id: { type: string }\n' +
    'operations:\n' +
    '  receiveBeat:\n' +
    '    action: receive\n' +
    '    channel: { $ref: "#/channels/heartbeat" }\n' +
    '    messages: [{ $ref: "#/channels/heartbeat/messages/beat" }]\n');
  const project = realpathSync(work);
  const db = join(work, '.wiregraph', 'graph.db');
  await runBuild({ target: project, project, db, reset: true });

  // The defined-token set is persisted (schema v4) so a fully-drifted contract is
  // detectable even though it produced no edge for the drifted token.
  const conn = connect(db, { readonly: true });
  const nTok = conn.prepare('SELECT count(*) n FROM contract_tokens WHERE project=?').get(project).n;
  ok(nTok >= 4, `drift: contract tokens persisted (got ${nTok}, want >=4 incl. the unreferenced one)`);

  const out = Q.traceContract(conn, project, 'Heartbeat', undefined, false);
  has(out, 'DRIFT', 'drift: report flags DRIFT for a contract the code no longer fully implements');
  has(out, 'legacy_slot_id', 'drift: the unreferenced token is named (not silently absent)');
  has(out, 'unreferenced', 'drift: unreferenced bucket present');
  // battery_pct is referenced by only the agent -> one-sided, not satisfied.
  has(out, 'battery_pct', 'drift: the one-sided token is named');
  has(out, 'one-sided', 'drift: one-sided bucket present');
  // 3 of 5 tokens have both sides: device_id, firmware_version, /api/heartbeat
  // (the other two being battery_pct=one-sided and legacy_slot_id=unreferenced).
  has(out, '3/5 tokens satisfied', 'drift: headline counts satisfied vs total correctly');
  // A satisfied token must NOT show up as drift — it's only in "referenced by".
  ok(!out.includes('device_id — only ['), 'drift: a both-sides token is not mislabeled one-sided');
  conn.close();
  rmSync(work, { recursive: true, force: true });
}

// H2 wildcard route-match: a parameterized route with a STATIC segment after the
// param (/orders/{id}/items) must light REFERENCES on BOTH sides and a WIRE seam.
// Before the fix normalizeAddress dropped every {param} segment (-> /orders/items)
// and the substring matcher never found it, so every such route was a silently-empty
// seam. pathTokenRegex now matches the route however source writes the param (:id /
// ${id} / {id} / a concrete value). A sibling route (/orders/{id}/shipments) proves
// the two routes are NOT conflated into one prefix. Hand-written spec (like
// contractDriftTest) with x-wiregraph-* roles so WIRE orients without an env var —
// the inference stage normalizes ${id} and :id differently, so this targets the
// matcher directly.
async function paramRouteMatchTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-param-'));
  const svc = join(work, 'svc'), app = join(work, 'app');
  mkdirSync(join(svc, '.git'), { recursive: true }); // distinct repos => compartments
  mkdirSync(join(app, '.git'), { recursive: true });
  // Server defines both routes with :id params; a static segment FOLLOWS the param.
  writeFileSync(join(svc, 'routes.js'),
    'function mount(app) {\n' +
    "  app.get('/orders/:id/items', (req, res) => res.json(items(req.params.id)));\n" +
    "  app.get('/orders/:id/shipments', (req, res) => res.json(ships(req.params.id)));\n" +
    '}\n');
  // Client calls both — one via a template literal ${id}, one via a concrete id.
  writeFileSync(join(app, 'client.js'),
    'async function loadItems(id) { return fetch(`/orders/${id}/items`).then((r) => r.json()); }\n' +
    'async function loadShipments() { return fetch(`/orders/42/shipments`).then((r) => r.json()); }\n');
  // Hand-written spec: the {param} addresses + x-wiregraph roles so WIRE orients
  // producer(app) -> consumer(svc) without WIREGRAPH_SERVER_REPO.
  const cdir = join(work, 'contracts'); mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 'orders.asyncapi.yaml'),
    'asyncapi: 3.0.0\n' +
    'info: { title: Orders, version: 1.0.0 }\n' +
    'channels:\n' +
    '  items:\n' +
    '    address: /orders/{id}/items\n' +
    '    x-wiregraph-producers: [app]\n' +
    '    x-wiregraph-consumers: [svc]\n' +
    '    messages: { req: { payload: { type: object, properties: {} } } }\n' +
    '  shipments:\n' +
    '    address: /orders/{id}/shipments\n' +
    '    x-wiregraph-producers: [app]\n' +
    '    x-wiregraph-consumers: [svc]\n' +
    '    messages: { req: { payload: { type: object, properties: {} } } }\n' +
    'operations:\n' +
    '  recvItems: { action: receive, channel: { $ref: "#/channels/items" }, messages: [{ $ref: "#/channels/items/messages/req" }] }\n' +
    '  recvShip: { action: receive, channel: { $ref: "#/channels/shipments" }, messages: [{ $ref: "#/channels/shipments/messages/req" }] }\n');
  const project = realpathSync(work);
  const db = join(work, '.wiregraph', 'graph.db');
  await runBuild({ target: project, project, db, reset: true });
  const conn = connect(db, { readonly: true });

  const refRepos = (token) => new Set(conn.prepare(
    "SELECT DISTINCT s.compartment repo FROM edges e JOIN symbols s ON s.id=e.src WHERE e.project=? AND e.type='REFERENCES' AND e.token=?")
    .all(project, token).map((r) => r.repo));

  // REFERENCES for the parameterized route come from BOTH compartments (before the
  // fix: zero, because /orders/{id}/items never matched /orders/:id/items).
  const itemsRepos = refRepos('/orders/{id}/items');
  ok(itemsRepos.has('svc') && itemsRepos.has('app'),
    `param-route: /orders/{id}/items REFERENCES from BOTH sides (got ${[...itemsRepos].join(', ') || 'none'})`);

  // WIRE seam exists and is oriented producer(app) -> consumer(svc).
  const wires = conn.prepare(
    `SELECT sp.compartment src, dp.compartment dst, e.token token FROM edges e
       JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
      WHERE e.project=? AND e.type='WIRE'`).all(project);
  ok(wires.some((w) => w.src === 'app' && w.dst === 'svc' && w.token === '/orders/{id}/items'),
    `param-route: WIRE oriented app -> svc for /orders/{id}/items (got ${wires.map((w) => `${w.src}->${w.dst}:${w.token}`).join(', ') || 'none'})`);

  // Sibling NOT conflated: /orders/{id}/shipments is its OWN both-sided token, and
  // there are EXACTLY the two distinct WIRE tokens (a merged /orders prefix — the old
  // bug's shape — would collapse them into one or zero).
  const shipRepos = refRepos('/orders/{id}/shipments');
  ok(shipRepos.has('svc') && shipRepos.has('app'),
    `param-route: sibling /orders/{id}/shipments also seams both sides (got ${[...shipRepos].join(', ') || 'none'})`);
  const wireTokens = new Set(wires.map((w) => w.token));
  eq(wireTokens.size, 2, `param-route: two distinct, un-conflated WIRE tokens (got ${[...wireTokens].join(', ') || 'none'})`);

  conn.close();
  rmSync(work, { recursive: true, force: true });
}

// V1 prefix-nesting: a bare route token (/orders/{id}) that is a PREFIX of a longer
// nested route (/orders/{id}/items) must NOT over-match it. The code only ever calls
// /orders/:id/items and only registers /orders/:id/items — nothing calls the bare
// /orders/:id. Before the V1 fix the /orders/{id} regex ended in (?![A-Za-z0-9_]) and
// happily matched /orders/:id/items, minting a phantom REFERENCES edge on both sides
// and a fabricated WIRE seam for a route nothing calls. With the trailing lookahead
// now forbidding a following slash, /orders/{id} matches only an exact end-of-route
// occurrence — here there is none, so it must have ZERO references and NO seam.
async function prefixNestingMatchTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-prefix-'));
  const svc = join(work, 'svc'), app = join(work, 'app');
  mkdirSync(join(svc, '.git'), { recursive: true }); // distinct repos => compartments
  mkdirSync(join(app, '.git'), { recursive: true });
  // Server registers ONLY the deep route; nothing mounts the bare /orders/:id.
  writeFileSync(join(svc, 'routes.js'),
    'function mount(app) {\n' +
    "  app.get('/orders/:id/items', (req, res) => res.json(items(req.params.id)));\n" +
    '}\n');
  // Client calls ONLY the deep route.
  writeFileSync(join(app, 'client.js'),
    'async function loadItems(id) { return fetch(`/orders/${id}/items`).then((r) => r.json()); }\n');
  // Spec declares BOTH the bare route AND the nested route as channels.
  const cdir = join(work, 'contracts'); mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 'orders.asyncapi.yaml'),
    'asyncapi: 3.0.0\n' +
    'info: { title: Orders, version: 1.0.0 }\n' +
    'channels:\n' +
    '  order:\n' +
    '    address: /orders/{id}\n' +
    '    x-wiregraph-producers: [app]\n' +
    '    x-wiregraph-consumers: [svc]\n' +
    '    messages: { req: { payload: { type: object, properties: {} } } }\n' +
    '  items:\n' +
    '    address: /orders/{id}/items\n' +
    '    x-wiregraph-producers: [app]\n' +
    '    x-wiregraph-consumers: [svc]\n' +
    '    messages: { req: { payload: { type: object, properties: {} } } }\n' +
    'operations:\n' +
    '  recvOrder: { action: receive, channel: { $ref: "#/channels/order" }, messages: [{ $ref: "#/channels/order/messages/req" }] }\n' +
    '  recvItems: { action: receive, channel: { $ref: "#/channels/items" }, messages: [{ $ref: "#/channels/items/messages/req" }] }\n');
  const project = realpathSync(work);
  const db = join(work, '.wiregraph', 'graph.db');
  await runBuild({ target: project, project, db, reset: true });
  const conn = connect(db, { readonly: true });

  // The bare /orders/{id} token has ZERO REFERENCES (nothing calls the bare route).
  const bareRefs = conn.prepare(
    "SELECT count(*) AS n FROM edges WHERE project=? AND type='REFERENCES' AND token=?")
    .all(project, '/orders/{id}')[0].n;
  eq(bareRefs, 0, 'prefix-nesting: /orders/{id} has NO REFERENCES (the prefix does not over-match the nested route)');

  // The deep /orders/{id}/items token IS referenced from both sides (sanity: the
  // route that actually exists still seams).
  const deepRefs = new Set(conn.prepare(
    "SELECT DISTINCT s.compartment repo FROM edges e JOIN symbols s ON s.id=e.src WHERE e.project=? AND e.type='REFERENCES' AND e.token=?")
    .all(project, '/orders/{id}/items').map((r) => r.repo));
  ok(deepRefs.has('svc') && deepRefs.has('app'), 'prefix-nesting: the real nested route /orders/{id}/items still seams both sides');

  // WIRE seams: exactly one token, and it is the nested route — NOT the bare prefix.
  const wireTokens = new Set(conn.prepare(
    "SELECT DISTINCT token FROM edges WHERE project=? AND type='WIRE'").all(project).map((r) => r.token));
  ok(!wireTokens.has('/orders/{id}'), 'prefix-nesting: NO phantom WIRE seam for the bare /orders/{id}');
  ok(wireTokens.has('/orders/{id}/items'), 'prefix-nesting: the nested /orders/{id}/items still has a WIRE seam');
  eq(wireTokens.size, 1, `prefix-nesting: exactly one WIRE token (the nested route), got ${[...wireTokens].join(', ') || 'none'}`);

  conn.close();
  rmSync(work, { recursive: true, force: true });
}

// M10 role-aware drift: contract drift must be classified the way buildWireEdges
// orients a WIRE — a token needs BOTH a producer AND a consumer in DIFFERENT
// compartments. The old count heuristic called a token "satisfied" whenever 2+
// compartments referenced it, so a token touched by TWO PRODUCERS (server unindexed)
// looked healthy while buildWireEdges produced zero wire. classifyContractToken and
// both drift reporters must now call that same-role case one-sided, not satisfied.
async function roleAwareDriftTest() {
  // --- direct unit coverage of the classifier -------------------------------
  const same = Q.classifyContractToken(new Set(['app1', 'app2']), { producers: ['app1', 'app2'], consumers: ['svc'] });
  eq(same, 'one-sided', `m10: two producers, no consumer -> one-sided (not satisfied); got ${same}`);
  eq(Q.classifyContractToken(['app1', 'app2'], { producers: ['app1', 'app2'], consumers: ['svc'] }), 'one-sided',
    'm10: classifier accepts an array of referencing compartments');
  eq(Q.classifyContractToken(new Set(['app1', 'svc']), { producers: ['app1'], consumers: ['svc'] }), 'satisfied',
    'm10: one producer + one consumer, distinct compartments -> satisfied');
  eq(Q.classifyContractToken(new Set(['app1']), { producers: ['app1'], consumers: ['app1'] }), 'one-sided',
    'm10: lone dual-role compartment -> one-sided (no cross-compartment pair, mirrors buildWireEdges intra-compartment skip)');
  eq(Q.classifyContractToken(new Set(), { producers: ['app1'], consumers: ['svc'] }), 'unreferenced',
    'm10: no referencing compartment -> unreferenced');
  // role-less fallback (hand-written spec, roles not stored): count heuristic preserved
  eq(Q.classifyContractToken(new Set(['x']), { producers: [], consumers: [] }), 'one-sided',
    'm10: role-less fallback, 1 compartment -> one-sided');
  eq(Q.classifyContractToken(new Set(['x', 'y']), {}), 'satisfied',
    'm10: role-less fallback, 2 compartments -> satisfied');
  eq(Q.classifyContractToken([], undefined), 'unreferenced',
    'm10: role-less fallback, no referencer -> unreferenced');

  // --- end-to-end through traceContract + contractDriftByName ---------------
  const work = mkdtempSync(join(tmpdir(), 'cg-m10-'));
  const app1 = join(work, 'app1'), app2 = join(work, 'app2'), svc = join(work, 'svc');
  for (const d of [app1, app2, svc]) mkdirSync(join(d, '.git'), { recursive: true }); // distinct repos => compartments
  // TWO producer clients both call /api/telemetry; NO consumer references it (svc
  // handles only /api/config) -> same-role token: 2 compartments but no wire.
  writeFileSync(join(app1, 'client.js'),
    "function sendTelemetry() { return fetch('/api/telemetry', { method: 'POST' }); }\n" +
    "function loadConfig() { return fetch('/api/config'); }\n");
  writeFileSync(join(app2, 'client.js'),
    "function alsoTelemetry() { return fetch('/api/telemetry', { method: 'POST' }); }\n");
  writeFileSync(join(svc, 'server.js'),
    "function routes(app) { app.get('/api/config', (req, res) => res.json(cfg())); }\n");
  const cdir = join(work, 'contracts'); mkdirSync(cdir, { recursive: true });
  // Hand-written spec WITH x-wiregraph roles: telemetry is produced by both clients
  // and (nominally) consumed by svc; config is produced by app1, consumed by svc.
  writeFileSync(join(cdir, 'fleet.asyncapi.yaml'),
    'asyncapi: 3.0.0\n' +
    'info: { title: Fleet, version: 1.0.0 }\n' +
    'channels:\n' +
    '  telemetry:\n' +
    '    address: /api/telemetry\n' +
    '    x-wiregraph-producers: [app1, app2]\n' +
    '    x-wiregraph-consumers: [svc]\n' +
    '    messages: { m: { payload: { type: object, properties: {} } } }\n' +
    '  config:\n' +
    '    address: /api/config\n' +
    '    x-wiregraph-producers: [app1]\n' +
    '    x-wiregraph-consumers: [svc]\n' +
    '    messages: { m: { payload: { type: object, properties: {} } } }\n' +
    'operations:\n' +
    '  recvTel: { action: receive, channel: { $ref: "#/channels/telemetry" }, messages: [{ $ref: "#/channels/telemetry/messages/m" }] }\n' +
    '  recvCfg: { action: receive, channel: { $ref: "#/channels/config" }, messages: [{ $ref: "#/channels/config/messages/m" }] }\n');
  const project = realpathSync(work);
  const db = join(work, '.wiregraph', 'graph.db');
  await runBuild({ target: project, project, db, reset: true });
  const conn = connect(db, { readonly: true });

  const out = Q.traceContract(conn, project, 'Fleet', undefined, false);
  // Same-role token is one-sided, NOT satisfied: config is the only satisfied token.
  has(out, '1/2 tokens satisfied', 'm10: same-role token not counted satisfied (config is the lone satisfied token)');
  ok(!out.includes('2/2 tokens satisfied'), 'm10: two producers do NOT make the seam satisfied');
  has(out, 'one-sided', 'm10: one-sided bucket present');
  has(out, '/api/telemetry', 'm10: the same-role token is named');
  // Improved message names the present side and the missing half.
  has(out, 'producer side', 'm10: one-sided detail names the producer side that is present');
  has(out, 'consumer half missing', 'm10: one-sided detail names the consumer half that is missing');

  const drift = Q.contractDriftByName(conn, project, false);
  const fleet = drift.get('Fleet');
  ok(fleet, 'm10: contractDriftByName has a Fleet entry');
  eq(fleet.status, 'one-sided', `m10: contract status is one-sided, NOT ok (same-role token is a gap); got ${fleet?.status}`);
  eq(fleet.satisfied, 1, `m10: exactly one satisfied token (config); got ${fleet?.satisfied}`);
  eq(fleet.oneSided, 1, `m10: exactly one one-sided token (telemetry); got ${fleet?.oneSided}`);

  conn.close();
  rmSync(work, { recursive: true, force: true });
}

// Pure-unit coverage of the H2 matcher: pathTokenRegex matches a parameterized token
// however source writes the param, respects segment boundaries, and normalizeAddress
// keeps the FULL parameterized address as a stable token (only collapsing // and a
// trailing slash). Positive + negative cases from the design's "behavior to preserve".
async function pathTokenMatchUnitTest() {
  const { pathTokenRegex, normalizeAddress } = await import('../src/extract/contracts.js');
  const items = pathTokenRegex('/orders/{id}/items');
  // .source is V8's source-escaped form (each `/` shown as `\/`, except inside a
  // char class); the documented pattern is
  // /orders/(?::?\$?\{?[A-Za-z0-9_]+\}?)/items(?![A-Za-z0-9_/}]). The trailing
  // lookahead forbids a following `/` OR `}` so a bare route never over-matches a
  // LONGER nested route — including the client `${id}/…` form where the `}` would
  // otherwise be a false terminator (V1).
  eq(items.source, '\\/orders\\/(?::?\\$?\\{?[A-Za-z0-9_]+\\}?)\\/items(?![A-Za-z0-9_/}])',
    'pathTokenRegex: /orders/{id}/items compiles to the documented wildcard regex');
  for (const s of ['/orders/:id/items', '/orders/${id}/items', '/orders/{id}/items', '/orders/42/items']) {
    ok(items.test(s), `pathTokenRegex: matches source form ${s}`);
  }
  ok(!items.test('/orders/:id'), 'pathTokenRegex: does NOT match the param-only sibling /orders/:id');
  ok(!items.test('/orderstatus/x/items'), 'pathTokenRegex: does NOT match /orderstatus/x/items (static-segment boundary)');
  ok(!items.test('/orders/:id/itemsExtra'), 'pathTokenRegex: does NOT match /orders/:id/itemsExtra (trailing boundary)');

  // V1: a bare route token must not over-match a LONGER nested sibling route. The
  // trailing `(?![A-Za-z0-9_/])` forbids a following slash, so `/orders/{id}` matches
  // an exact end-of-route occurrence but NOT `/orders/:id/items` (a deeper route).
  const bareId = pathTokenRegex('/orders/{id}');
  ok(bareId.test('/orders/:id'), 'pathTokenRegex: /orders/{id} still matches the exact route /orders/:id');
  ok(!bareId.test('/orders/:id/items'), 'pathTokenRegex: /orders/{id} does NOT match the longer route /orders/:id/items');
  // The client template-literal form: `${id}` ends in `}`, which the lookahead must
  // also treat as a non-terminator so the bare route does not false-match `/orders/${id`.
  ok(!bareId.test('/orders/${id}/items'), 'pathTokenRegex: /orders/{id} does NOT match the longer template-literal route /orders/${id}/items');
  ok(bareId.test('/orders/${id}'), 'pathTokenRegex: /orders/{id} STILL matches an exact template-literal route /orders/${id}');
  ok(items.test('/orders/:id/items'), 'pathTokenRegex: the deeper /orders/{id}/items still matches its own route');
  ok(items.test('/orders/${id}/items'), 'pathTokenRegex: the deeper /orders/{id}/items still matches the template-literal client form');
  const bareOrders = pathTokenRegex('/orders');
  ok(bareOrders.test("'/orders'"), 'pathTokenRegex: /orders matches a quoted end-of-route literal');
  ok(!bareOrders.test('/orders/42'), 'pathTokenRegex: /orders does NOT match the longer route /orders/42');
  // A route ending in a STATIC segment: a trailing `?query` (or nothing) is fine, but
  // a deeper `/segment` is now excluded.
  const health = pathTokenRegex('/health');
  ok(health.test("'/health'"), 'pathTokenRegex: /health matches a bare occurrence');
  ok(health.test("'/health?x=1'"), 'pathTokenRegex: /health still matches when followed by a query string');
  ok(!health.test('/healthcheck'), 'pathTokenRegex: /health does not bleed into /healthcheck');
  ok(!health.test('/health/live'), 'pathTokenRegex: /health does NOT match the longer route /health/live');

  const list = pathTokenRegex('/users/list');
  ok(list.test('/users/list'), 'pathTokenRegex: plain path /users/list still matches');
  ok(!list.test('/users/listings'), 'pathTokenRegex: /users/list does not bleed into /users/listings');

  // Mid-segment param: the literal suffix stays literal/escaped.
  const file = pathTokenRegex('/files/{name}.json');
  ok(file.test('/files/:name.json'), 'pathTokenRegex: mid-segment param /files/{name}.json matches /files/:name.json');
  ok(!file.test('/files/reportxjson'), 'pathTokenRegex: the escaped dot in /files/{name}.json is literal');

  // normalizeAddress keeps the full parameterized form (stable token identity),
  // collapses // and strips a trailing slash, keeps the root, matches topics literally.
  eq(normalizeAddress('/orders/{id}/items'), '/orders/{id}/items', 'normalizeAddress: keeps the full parameterized path');
  eq(normalizeAddress('/orders//{id}/items/'), '/orders/{id}/items', 'normalizeAddress: collapses // and strips a trailing slash');
  eq(normalizeAddress('/'), '/', 'normalizeAddress: the root path is preserved');
  eq(normalizeAddress('order.created'), 'order.created', 'normalizeAddress: a topic is matched literally');
  eq(normalizeAddress(''), null, 'normalizeAddress: empty input -> null');
}

// Shared-state detector: an env var read in 2+ repos is a seam; ubiquitous env
// vars (NODE_ENV) are filtered so they don't become bogus contracts.
async function stateTest() {
  const I = await import('../src/contracts/infer.js');
  const work = mkdtempSync(join(tmpdir(), 'cg-state-'));
  const a = join(work, 'svc-a'), b = join(work, 'svc-b');
  mkdirSync(join(a, '.git'), { recursive: true });
  mkdirSync(join(b, '.git'), { recursive: true });
  writeFileSync(join(a, 'cfg.js'), "export const url = process.env.FEIG_TMS_ENDPOINT;\nconst e = process.env.NODE_ENV;\n");
  writeFileSync(join(b, 'cfg.js'), "function load() { return process.env.FEIG_TMS_ENDPOINT; }\nconst e2 = process.env.NODE_ENV;\n");
  const project = realpathSync(work);

  const seams = I.clusterSeams(I.extractCandidates(project));
  const st = seams.find((s) => s.kind === 'state' && s.token === 'FEIG_TMS_ENDPOINT');
  ok(st, `state: shared env-var seam detected (got ${seams.map((s) => s.kind + ':' + s.token).join(', ') || 'none'})`);
  ok(!seams.some((s) => s.token === 'NODE_ENV'), 'state: ubiquitous env var NODE_ENV is filtered out even when cross-repo');

  const yaml = I.synthesizeAsyncApi(seams);
  const cdir = join(project, 'contracts'); mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 'wiregraph-inferred.asyncapi.yaml'), yaml);
  const db = join(project, '.wiregraph', 'graph.db');
  await runBuild({ target: project, project, db, reset: true });
  const conn = connect(db, { readonly: true });
  const repos = new Set(
    conn.prepare("SELECT DISTINCT s.compartment repo FROM edges e JOIN symbols s ON s.id=e.src WHERE e.project=? AND e.type='REFERENCES'")
      .all(project).map((r) => r.repo),
  );
  ok(repos.has('svc-a') && repos.has('svc-b'), `state: round-trip links both env readers (got ${[...repos].join(', ') || 'none'})`);
  conn.close();
  rmSync(work, { recursive: true, force: true });
}

// M8: TS env-var state detection recognizes both `process.env` and
// `import.meta.env`. `import.meta` parses as a `meta_property` node (not a
// member_expression), so the object-type branch in isTsEnvObject must handle it
// or every import.meta.env.* read is silently dropped.
async function tsEnvStateTest() {
  const { parseSource } = await import('../src/extract/parse.js');
  const tokens = (src) =>
    parseSource(src, 'typescript', 'typescript').candidates.filter((c) => c.kind === 'state').map((c) => c.token);

  ok(tokens('const x = import.meta.env.API_URL;').includes('API_URL'),
    `state(ts): import.meta.env.NAME yields a candidate (got ${tokens('const x = import.meta.env.API_URL;').join(', ') || 'none'})`);
  ok(tokens("const y = import.meta.env['SOME_KEY'];").includes('SOME_KEY'),
    `state(ts): import.meta.env['KEY'] yields a candidate (got ${tokens("const y = import.meta.env['SOME_KEY'];").join(', ') || 'none'})`);
  ok(tokens('const z = process.env.MYVAR;').includes('MYVAR'),
    `state(ts): process.env.NAME still yields a candidate (got ${tokens('const z = process.env.MYVAR;').join(', ') || 'none'})`);
}

// H1 data-loss guard: writeState is atomic (temp + rename, no torn reads), and
// updateState distinguishes an ABSENT state.json from a CORRUPT one so a partial/torn
// read can never be papered over with defaults (which would silently drop links,
// posture, and the reposLastSha baseline). loadState is the seam that classifies the
// three cases; these drive state.mjs directly against temp project dirs.
async function atomicStateTest() {
  const S = await import('../scripts/lib/state.mjs');

  // atomic write: writeState leaves the FINAL file whole and parseable, and its own
  // unique temp file is renamed away (no residue from THIS write). We can't cheaply
  // fault-inject a torn write in this harness (no fs interposition), so this asserts
  // the observable post-conditions of temp+rename rather than the rename's atomicity
  // mid-flight — an honest limit noted here rather than a tautological check.
  {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-atomic-')));
    S.writeState(proj, S.defaultState(proj));
    const p = S.stateFilePath(proj);
    const d = dirname(p);
    ok(!existsSync(p + '.tmp'), 'atomic: no legacy state.json.tmp remains after writeState');
    // V3: the temp name is now unique per writer+write; assert this write left no
    // <pid>.<n>.tmp residue of its own (it was renamed onto state.json, not left).
    ok(!readdirSync(d).some((f) => f.startsWith('state.json.') && f.endsWith('.tmp')),
      'atomic: writeState leaves no unique .tmp residue of its own after the rename');
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    eq(parsed.project, proj, 'atomic: state.json parses and holds the project root');
    rmSync(proj, { recursive: true, force: true });
  }

  // V5: a pre-existing STALE unique .tmp residue (e.g. from a crashed prior writer of a
  // DIFFERENT pid) must neither corrupt nor block a subsequent writeState — the unique
  // naming means the new write never touches that residue, and the final state.json is
  // still whole and correct. (This exercises the V3 unique-temp-name change: a shared
  // hardcoded `state.json.tmp` could be clobbered/raced; a foreign unique name cannot.)
  {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-atomic-stale-')));
    const p = S.stateFilePath(proj);
    mkdirSync(dirname(p), { recursive: true });
    // A junk residue matching the unique-temp shape but from a foreign pid/seq.
    const stale = p + '.999999.7.tmp';
    writeFileSync(stale, 'torn junk {{{ not json');
    S.writeState(proj, { ...S.defaultState(proj), autoUpdate: 'balanced' });
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    eq(parsed.project, proj, 'atomic-stale: state.json is whole and parses despite a stale foreign .tmp residue');
    eq(parsed.autoUpdate, 'balanced', 'atomic-stale: the written state is correct, not the stale bytes');
    ok(existsSync(stale) && readFileSync(stale, 'utf8').startsWith('torn junk'),
      'atomic-stale: the foreign residue is left untouched (unique naming never reuses it)');
    eq(S.loadState(proj).status, 'ok', 'atomic-stale: the resulting state.json loads cleanly (not corrupt)');
    rmSync(proj, { recursive: true, force: true });
  }

  // absent → updateState on a fresh dir yields defaults + patch (unchanged behavior)
  {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-absent-')));
    eq(S.loadState(proj).status, 'absent', 'absent: loadState reports absent for a fresh dir');
    const next = S.updateState(proj, { autoUpdate: 'aggressive' });
    eq(next.autoUpdate, 'aggressive', 'absent: patch applied');
    eq(next.metricsVersion, S.METRICS_VERSION, 'absent: defaults filled in (metricsVersion from defaultState)');
    rmSync(proj, { recursive: true, force: true });
  }

  // ok round-trip: updateState preserves existing fields while applying the patch
  {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-ok-')));
    const link = { root: '/some/peer', peer: '/some/peer', initiator: null, autoCreated: false, linkedAt: null };
    S.writeState(proj, { ...S.defaultState(proj), links: [link], autoUpdate: 'conservative' });
    eq(S.loadState(proj).status, 'ok', 'ok: loadState reports ok for a valid file');
    const next = S.updateState(proj, { inferredSeams: 3 });
    eq(next.inferredSeams, 3, 'ok: patch applied');
    eq(next.autoUpdate, 'conservative', 'ok: existing posture preserved through the merge');
    eq(next.links.length, 1, 'ok: existing links array preserved through the merge');
    eq(next.links[0].root, '/some/peer', 'ok: link record preserved verbatim');
    rmSync(proj, { recursive: true, force: true });
  }

  // corrupt → updateState THROWS, preserves the original bytes in a .corrupt* backup,
  // and does NOT replace state.json with defaults
  {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-corrupt-')));
    const p = S.stateFilePath(proj);
    mkdirSync(dirname(p), { recursive: true });
    const garbage = '{ this is not valid json ]]';
    writeFileSync(p, garbage);
    eq(S.loadState(proj).status, 'corrupt', 'corrupt: loadState reports corrupt for garbage bytes');

    let threw = false;
    try { S.updateState(proj, { autoUpdate: 'off' }); } catch { threw = true; }
    ok(threw, 'corrupt: updateState throws rather than overwriting');
    ok(!existsSync(p), 'corrupt: the corrupt state.json was moved aside (not left in place)');
    const backup = p + '.corrupt';
    ok(existsSync(backup), 'corrupt: original bytes preserved in a state.json.corrupt backup');
    eq(readFileSync(backup, 'utf8'), garbage, 'corrupt: backup holds the original bytes verbatim');

    // corrupt non-clobber: a SECOND corrupt update must not overwrite the first backup
    writeFileSync(p, 'more garbage {{{');
    let threw2 = false;
    try { S.updateState(proj, { autoUpdate: 'off' }); } catch { threw2 = true; }
    ok(threw2, 'corrupt: second corrupt updateState also throws');
    eq(readFileSync(backup, 'utf8'), garbage, 'corrupt: first .corrupt backup left untouched by the second corrupt write');
    ok(existsSync(p + '.corrupt.2'), 'corrupt: second corrupt file quarantined to a unique .corrupt.2 suffix');
    eq(readFileSync(p + '.corrupt.2', 'utf8'), 'more garbage {{{', 'corrupt: .corrupt.2 holds the second corrupt bytes');
    rmSync(proj, { recursive: true, force: true });
  }
}

// Recognize-potential: a full build persists the cross-repo seam count + contracts
// dir to state, which is what gates the SessionStart/status nudge.
async function potentialTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = mkdtempSync(join(tmpdir(), 'cg-pot-'));
  const a = join(work, 'producer'), b = join(work, 'consumer');
  mkdirSync(join(a, '.git'), { recursive: true });
  mkdirSync(join(b, '.git'), { recursive: true });
  writeFileSync(join(a, 'p.js'), "function go(ch){ ch.publish('jobs.created', '{}'); }\n");
  writeFileSync(join(b, 'c.js'), "function on(ch){ ch.subscribe('jobs.created', (m) => m); }\n");
  const project = realpathSync(work);
  await runBuild({ target: project, project, db: join(project, '.wiregraph', 'graph.db'), reset: true });
  const st = S.readState(project);
  eq(st && st.inferredSeams, 1, 'potential: full build persists the cross-repo seam count');
  ok(st && !st.contractsDir, 'potential: no contracts dir → nudge gate (seams>0 && !contractsDir) would fire');
  rmSync(work, { recursive: true, force: true });
}

// Library/SDK imports: a package-name import of a sibling repo becomes a cross-repo
// IMPORTS edge (module -> module), which path_between can traverse.
async function importsTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-imp-'));
  const lib = join(work, 'shared-lib'), app = join(work, 'app');
  mkdirSync(join(lib, '.git'), { recursive: true });
  mkdirSync(join(app, '.git'), { recursive: true });
  writeFileSync(join(lib, 'package.json'), JSON.stringify({ name: '@acme/shared', main: 'index.js' }));
  writeFileSync(join(lib, 'index.js'), "export function sharedUtil(x) { return x + 1; }\n");
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', main: 'main.js' }));
  writeFileSync(join(app, 'main.js'), "import { sharedUtil } from '@acme/shared';\nfunction run() { return sharedUtil(1); }\n");
  const project = realpathSync(work);
  const db = join(project, '.wiregraph', 'graph.db');
  await runBuild({ target: project, project, db, reset: true });

  const conn = connect(db, { readonly: true });
  const imps = conn.prepare("SELECT src, dst FROM edges WHERE project=? AND type='IMPORTS'").all(project);
  ok(imps.length >= 1, `imports: a cross-repo IMPORTS edge was created (got ${imps.length})`);
  const hit = imps.find((e) => e.src.includes(':app:main.js:') && e.dst.includes(':shared-lib:index.js:'));
  ok(hit, `imports: edge links app/main.js -> shared-lib/index.js (got ${imps.map((e) => e.src + '->' + e.dst).join('; ') || 'none'})`);
  conn.close();
  rmSync(work, { recursive: true, force: true });
}

// HTML visualization export must be a self-contained, offline file: d3 inlined
// (no CDN), with the graph data + force sim embedded. This is what /wiregraph-visualize
// generates and opens — a network fetch here would break the 100%-local promise.
async function exportHtmlTests() {
  const proj = mkdtempSync(join(tmpdir(), 'cg-html-'));
  cpSync(FIXTURE, join(proj, 'repo'), { recursive: true });
  mkdirSync(join(proj, 'repo', '.git'), { recursive: true });
  await runBuild({ target: proj, project: proj, db: join(proj, '.wiregraph', 'graph.db'), reset: true });
  const out = join(proj, 'graph.html');
  const EXPORT = join(HERE, '..', 'src', 'export-html.js');
  await execFileP('node', [EXPORT, '--all', '--project', proj, out]);
  const html = readFileSync(out, 'utf8');
  ok(!html.includes('cdn.jsdelivr'), 'export-html: d3 is inlined, no CDN reference (offline)');
  ok(html.includes('forceSimulation') && html.includes('const DATA ='), 'export-html: embeds a d3 force graph with data');

  // Missing d3 bundle must FAIL LOUD, not silently swap in a CDN <script> (that
  // would break "100% local"). --allow-cdn is the explicit opt-out.
  const { d3ScriptTag } = await import('../src/export-html.js');
  let threw = false, missingMsg = '';
  try { d3ScriptTag(false, '/no/such/d3.min.js'); } catch (e) { threw = true; missingMsg = e.message; }
  ok(threw, 'export-html: missing d3 bundle throws without --allow-cdn');
  // L27: the error must name the path actually tried, not the default D3_BUNDLE.
  ok(missingMsg.includes('/no/such/d3.min.js'), `export-html: error names the bundlePath actually tried (got "${missingMsg}")`);
  ok(d3ScriptTag(true, '/no/such/d3.min.js').includes('cdn.jsdelivr'), 'export-html: --allow-cdn falls back to CDN explicitly');

  rmSync(proj, { recursive: true, force: true });
}

// Default visualization view: a contract is an EDGE (type CONTRACT), colored by
// drift, NOT a hub node with arrows pointing into it. A contract nothing (or only
// one side) references still surfaces — as a dangling node — so drift never
// vanishes from the picture.
async function exportContractEdgesTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-viz-'));
  const agent = join(work, 'agent'), server = join(work, 'server');
  mkdirSync(join(agent, '.git'), { recursive: true });
  mkdirSync(join(server, '.git'), { recursive: true });
  writeFileSync(join(agent, 'hb.js'), "function send(c){ return c.post('/api/heartbeat', { device_id: id(), battery_pct: b() }); }\n");
  writeFileSync(join(server, 'hb.js'), "function handle(req){ const { device_id } = req.body; return device_id; }\nfunction routes(a){ a.post('/api/heartbeat', handle); }\n");
  const cdir = join(work, 'contracts'); mkdirSync(cdir, { recursive: true });
  // device_id + /api/heartbeat = satisfied; battery_pct = one-sided; ghost_field = unreferenced.
  writeFileSync(join(cdir, 'hb.asyncapi.yaml'),
    'asyncapi: 3.0.0\ninfo: { title: HB, version: 1.0.0 }\nchannels:\n  hb:\n    address: /api/heartbeat\n    messages:\n      m:\n        payload:\n          type: object\n          properties:\n            device_id: { type: string }\n            battery_pct: { type: integer }\n            ghost_field: { type: string }\noperations:\n  r: { action: receive, channel: { $ref: "#/channels/hb" }, messages: [{ $ref: "#/channels/hb/messages/m" }] }\n');
  const project = realpathSync(work);
  const db = join(work, '.wiregraph', 'graph.db');
  await runBuild({ target: project, project, db, reset: true });
  const out = join(work, 'graph.html');
  const EXPORT = join(HERE, '..', 'src', 'export-html.js');
  await execFileP('node', [EXPORT, '--project', project, '--db', db, out]); // default (compartment) mode
  const html = readFileSync(out, 'utf8');
  has(html, '"type":"CONTRACT"', 'viz: contracts are rendered as CONTRACT edges, not nodes');
  has(html, '"status":"drift"', 'viz: the edge carries the contract drift status for coloring');
  has(html, '"contract":"HB"', 'viz: the edge is labeled with the contract name');
  rmSync(work, { recursive: true, force: true });
}

// Injection safety: renderHtml embeds fully authored strings (node/contract names,
// file paths, REFERENCES tokens, the CLI search string as data.title) into a
// self-contained page. None of those are trusted, so all three escaping seams must
// hold: the DATA <script> blob, the tooltip innerHTML path, and the server-side
// <title>/<h1>. We drive renderHtml directly with hostile data.
async function exportHtmlEscapingTest() {
  const { renderHtml } = await import('../src/export-html.js');
  const evil = '</script><script>alert(1)</script>';
  const data = {
    title: '<img src=x onerror=alert(1)>',
    nodes: [
      { id: 'compartment::a', kind: 'compartment', compartment: 'a', name: 'a', file: null, line: null },
      { id: 'sym1', kind: 'symbol', compartment: 'a', name: evil, file: evil, line: 3 },
      { id: 'contract::c', kind: 'contract', dangling: true, compartment: null, name: evil, file: null, line: null, status: 'drift', drift: null },
    ],
    links: [
      { source: 'compartment::a', target: 'contract::c', type: 'CONTRACT', contract: evil, tokens: [evil], count: 1, status: 'drift', drift: null, toDangler: true },
    ],
    compartments: ['a'],
    compartmentColor: { a: '#E15554' },
    contractColor: '#F2C94C',
    driftColors: { ok: '#3BB273', 'one-sided': '#E6A23C', drift: '#E15554' },
    aggregated: true,
  };
  // allowCdn so a missing d3 bundle can't make renderHtml throw; irrelevant to escaping.
  const html = renderHtml(data, { allowCdn: true });

  // M12: the </script> in a node/contract name must be neutralized in the DATA blob
  // by escaping '<' to \u003c (JSON stays valid, the tag can't form). The raw
  // breakout sequence from the data must never appear verbatim in the output.
  has(html, '\\u003c/script', 'export-html M12: </script> in data is escaped to \\u003c in the DATA blob');
  ok(!html.includes('</script><script>alert(1)'), 'export-html M12: raw </script> breakout from data is absent');

  // L26: data.title lands in <title> and <h1> outside the script — must be escaped.
  has(html, '&lt;img src=x onerror=alert(1)&gt;', 'export-html L26: data.title is HTML-escaped in the head/body');
  ok(!html.includes('<img src=x onerror'), 'export-html L26: raw <img onerror from data.title is absent');

  // M13: the tooltip innerHTML path must route dynamic fields through the in-page
  // esc() helper (the tooltip runs client-side, so this is a source-level check that
  // the escaping is wired — bare d.name/d.contract interpolations would be XSS).
  has(html, 'const esc =', 'export-html M13: page defines an in-page esc() helper');
  has(html, 'esc(d.name)', 'export-html M13: node tooltip wraps d.name in esc()');
  has(html, 'esc(d.contract)', 'export-html M13: link tooltip wraps d.contract in esc()');
  ok(!html.includes("'<b>'+d.name+'</b>'"), 'export-html M13: no bare d.name interpolation remains in the tooltip');
}

// Schema safety: a db written by a NEWER wiregraph must never be silently
// downgraded by a reset rebuild (it would drop the newer tables and lose data).
async function schemaGuardTest() {
  const proj = mkdtempSync(join(tmpdir(), 'cg-schema-'));
  cpSync(FIXTURE, join(proj, 'repo'), { recursive: true });
  const db = join(proj, '.wiregraph', 'graph.db');
  await runBuild({ target: proj, project: proj, db, reset: true });
  const conn = connect(db, {});
  conn.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION + 1));
  conn.close();
  let threw = false;
  try { await runBuild({ target: proj, project: proj, db, reset: true }); } catch { threw = true; }
  ok(threw, 'schema: refuses to rebuild over a NEWER-schema db (no silent downgrade)');
  rmSync(proj, { recursive: true, force: true });
}

// Structural-drift honesty: an incremental update that renames a symbol must flag
// structuralDriftSinceFullBuild so graph_status stops certifying a flat "fresh";
// a full rebuild clears it; a body-only edit does not set it.
async function structuralDriftTest() {
  const S = await import('../scripts/lib/state.mjs');
  const proj = mkdtempSync(join(tmpdir(), 'cg-drift-'));
  const src = join(proj, 'repo');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'a.js'), 'export function foo(){ return 1; }\nexport function bar(){ return foo(); }\n');
  const db = join(proj, '.wiregraph', 'graph.db');
  await runBuild({ target: proj, project: proj, db, reset: true });
  S.updateState(proj, {}); // ensure state file exists with defaults
  eq(!!S.readState(proj)?.structuralDriftSinceFullBuild, false, 'drift: clear after full build');

  // pure body edit (no symbol added/removed/renamed) must NOT set drift — else the
  // <module> symbol makes every incremental look like drift and the nag is useless.
  writeFileSync(join(src, 'a.js'), 'export function foo(){ return 1 + 1; }\nexport function bar(){ return foo(); }\n');
  await runBuild({ target: proj, project: proj, db, files: [join(src, 'a.js')] });
  eq(!!S.readState(proj)?.structuralDriftSinceFullBuild, false, 'drift: NOT set by a pure body edit');

  // rename foo -> qux (a name-set change) via incremental
  writeFileSync(join(src, 'a.js'), 'export function qux(){ return 1; }\nexport function bar(){ return qux(); }\n');
  await runBuild({ target: proj, project: proj, db, files: [join(src, 'a.js')] });
  eq(S.readState(proj)?.structuralDriftSinceFullBuild, true, 'drift: set after an incremental rename');

  // full rebuild clears it
  await runBuild({ target: proj, project: proj, db, reset: true });
  eq(!!S.readState(proj)?.structuralDriftSinceFullBuild, false, 'drift: cleared by a full rebuild');
  rmSync(proj, { recursive: true, force: true });
}

// Distinctiveness STOP lists: generic endpoints / infra env vars must NOT count as
// cross-repo contract tokens (they'd mint false seams), while real ones still do.
async function distinctivenessTest() {
  const { isDistinctive } = await import('../src/extract/contracts.js');
  for (const t of ['/health', '/metrics', '/status', '/api/v1', '/', 'DATABASE_URL', 'NODE_ENV', 'REDIS_URL'])
    ok(!isDistinctive(t), `distinctive: '${t}' is generic, must be rejected`);
  for (const t of ['/api/register', '/orders/{id}/ship', 'STRIPE_WEBHOOK_URL', 'order.created', 'device_heartbeat'])
    ok(isDistinctive(t), `distinctive: '${t}' is specific, must be kept`);
}

// Compartments: a MONOREPO (one .git at the root, two packages) must still produce
// a cross-compartment seam — the packages are distinct compartments (detected by
// package.json), so a shared route between them is a contract even without two
// separate git repos. This is the case the old .git-only model was blind to.
const FIXTURE_MONOREPO = join(HERE, 'fixture-monorepo');
async function monorepoCompartmentTest() {
  const I = await import('../src/contracts/infer.js');
  const work = mkdtempSync(join(tmpdir(), 'cg-mono-'));
  cpSync(FIXTURE_MONOREPO, work, { recursive: true });
  mkdirSync(join(work, '.git'), { recursive: true }); // ONE git repo for the whole monorepo
  const project = realpathSync(work);
  const seams = I.clusterSeams(I.extractCandidates(project));
  eq(seams.length, 1, 'compartments: one seam inside a single-git monorepo');
  eq(seams[0].token, '/internal/sync', 'compartments: seam token is the shared route');
  const parts = [...seams[0].compartments].sort();
  ok(parts.includes('api') && parts.includes('worker'), `compartments: seam spans the api + worker packages (got ${parts.join(', ')})`);
  rmSync(work, { recursive: true, force: true });
}

// WIRE edges are cross-compartment only: a compartment that both PRODUCES and
// CONSUMES a token (defines a route it also calls) must not yield a WIRE edge
// between two of its own symbols — that's intra-compartment, not a wire seam.
async function wireCrossCompartmentOnlyTest() {
  const { buildWireEdges } = await import('../src/extract/contracts.js');
  const g = new Graph('p');
  g.addSymbol({ id: 'X:a.js:def:1', compartment: 'X', file: 'a.js', name: 'def', kind: 'function', startLine: 1 });
  g.addSymbol({ id: 'X:a.js:call:5', compartment: 'X', file: 'a.js', name: 'call', kind: 'function', startLine: 5 });
  g.addSymbol({ id: 'Y:b.js:call:1', compartment: 'Y', file: 'b.js', name: 'call', kind: 'function', startLine: 1 });
  const C = 'contract:t';
  g.addContract({ id: C, name: 'T', kind: 'asyncapi', file: 't.asyncapi.yaml' });
  for (const s of ['X:a.js:def:1', 'X:a.js:call:5', 'Y:b.js:call:1']) g.addEdge('REFERENCES', s, C, { token: '/t/x' });
  // X is BOTH a producer and a consumer of the token; Y only produces.
  const contracts = [{ id: C, name: 'T', tokens: ['/t/x'], direction: {}, wireRoles: new Map([['/t/x', { producers: new Set(['X', 'Y']), consumers: new Set(['X']) }]]) }];
  buildWireEdges(g, contracts);
  const wires = g.edges.filter((e) => e.type === 'WIRE');
  const comp = (id) => g.symbols.get(id).compartment;
  ok(wires.length >= 1, `wire: at least one cross-compartment edge (got ${wires.length})`);
  ok(wires.every((e) => comp(e.from) !== comp(e.to)), 'wire: no intra-compartment WIRE edges (X-producer to X-consumer suppressed)');
  ok(wires.some((e) => comp(e.from) === 'Y' && comp(e.to) === 'X'), 'wire: real cross-compartment edge Y -> X kept');
}

// git.mjs must import cleanly and enumerate GIT repos only — NOT compartments. A
// package inside a repo is a compartment but has no HEAD of its own, so projectRepos
// (git SHAs / freshness) must return just the git repo. This also guards the import:
// git.mjs is used only by hooks/seed, so a broken import (e.g. a stale walk.js export
// name) sails past the rest of the suite — this test is what catches it.
async function gitReposTest() {
  const G = await import('../scripts/lib/git.mjs');
  const work = mkdtempSync(join(tmpdir(), 'cg-git-'));
  mkdirSync(join(work, '.git'), { recursive: true });
  mkdirSync(join(work, 'packages', 'pkg'), { recursive: true });
  writeFileSync(join(work, 'packages', 'pkg', 'package.json'), '{"name":"pkg"}'); // a compartment, not a git repo
  const repos = G.projectRepos(realpathSync(work));
  eq(repos.length, 1, `git: projectRepos returns only the git repo, not the package compartment (got ${repos.length})`);
  rmSync(work, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// LINK FEATURE — foundation unit tests (state model, multi-root walk, union
// inference, project-free ids). These lock the scope-A primitives the link/unlink
// commands build on.
// ---------------------------------------------------------------------------

// State normalization + back-compat: object-form and legacy string-form link
// entries yield identical memberRoots; a pre-links state.json reads back with
// links:[] and a correct DERIVED indexedRoots WITHOUT rewriting the file on disk;
// realpath/symlink duplicates collapse; a vanished member is dropped.
async function linkStateTests() {
  const S = await import('../scripts/lib/state.mjs');
  const ws = mkdtempSync(join(tmpdir(), 'cg-lstate-'));
  const P = realpathSync(mkdtempSync(join(ws, 'proj-')));
  const M = realpathSync(mkdtempSync(join(ws, 'mem-')));

  // object-form == string-form (legacy) -> identical memberRoots
  const objForm = { project: P, links: [{ root: M, peer: M, initiator: P, autoCreated: false, linkedAt: 't' }] };
  const strForm = { project: P, links: [M] };
  eq(JSON.stringify(S.memberRoots(objForm)), JSON.stringify([P, M]), 'link-state: object-form memberRoots = [own, member]');
  eq(JSON.stringify(S.memberRoots(objForm)), JSON.stringify(S.memberRoots(strForm)), 'link-state: string-form normalizes to the same memberRoots');
  eq(S.members(objForm).length, 1, 'link-state: members() returns the normalized entry');
  eq(S.members(strForm)[0].root, M, 'link-state: legacy string entry normalizes to { root }');

  // pre-links state.json: reads back links:[] + derived indexedRoots, file NOT rewritten
  const preLinks = JSON.stringify({ project: P, reposLastSha: {}, autoUpdate: 'balanced' });
  mkdirSync(join(P, '.wiregraph'), { recursive: true });
  writeFileSync(join(P, '.wiregraph', 'state.json'), preLinks);
  const read = S.readState(P);
  eq(JSON.stringify(read.links), '[]', 'link-state: pre-links state backfills links:[]');
  eq(JSON.stringify(read.indexedRoots), JSON.stringify([P]), 'link-state: indexedRoots derived = [own root]');
  eq(readFileSync(join(P, '.wiregraph', 'state.json'), 'utf8'), preLinks, 'link-state: readState does NOT rewrite the file (lazy upgrade)');

  // symlink/realpath dedup: a link to a symlink-of-own-root collapses to one root
  const Plink = join(ws, 'proj-symlink');
  symlinkSync(P, Plink);
  eq(JSON.stringify(S.memberRoots({ project: P, links: [Plink] })), JSON.stringify([P]), 'link-state: a symlinked member dedups against the realpath');

  // vanished member is dropped from memberRoots
  const gone = join(ws, 'ghost-member');
  eq(JSON.stringify(S.memberRoots({ project: P, links: [gone] })), JSON.stringify([P]), 'link-state: a non-existent member root is dropped');

  // addLink / findLink / removeLink round-trip on disk (idempotent)
  S.addLink(P, { root: M, peer: M, initiator: P });
  S.addLink(P, { root: M, peer: M, initiator: P }); // re-link is a no-op replace
  const afterAdd = S.readState(P);
  eq(afterAdd.links.length, 1, 'link-state: addLink is idempotent (one record after re-link)');
  ok(S.findLink(P, M), 'link-state: findLink locates the added member');
  eq(JSON.stringify(afterAdd.indexedRoots), JSON.stringify([P, M]), 'link-state: addLink re-derives indexedRoots');
  // reposLastSha keys under the member are pruned on removeLink
  S.updateState(P, { reposLastSha: { [P]: 'a', [M]: 'b', [join(M, 'sub')]: 'c' } });
  S.removeLink(P, M);
  const afterRemove = S.readState(P);
  eq(afterRemove.links.length, 0, 'link-state: removeLink drops the record');
  eq(afterRemove.reposLastSha[M], undefined, 'link-state: removeLink prunes the member repo key');
  eq(afterRemove.reposLastSha[P], 'a', 'link-state: removeLink keeps own-root repo keys');

  // owningMember: longest-prefix over the union; null for a disjoint path
  S.addLink(P, { root: M, peer: M, initiator: P });
  eq(S.owningMember(join(M, 'a', 'b.js'), P), M, 'link-state: owningMember attributes a member file to the member');
  eq(S.owningMember(join(P, 'x.js'), P), P, 'link-state: owningMember attributes an own-root file to the own root');
  eq(S.owningMember(join(ws, 'elsewhere', 'z.js'), P), null, 'link-state: owningMember returns null for a disjoint path');

  // graphsListing: symmetric reverse index (M links back to P => listing = [M, P])
  mkdirSync(join(M, '.wiregraph'), { recursive: true });
  S.writeState(M, { ...S.defaultState(M), links: [{ root: P, peer: P, initiator: P }] });
  eq(JSON.stringify(S.graphsListing(M)), JSON.stringify([M, P]), 'link-state: graphsListing(M) is the symmetric reverse index');

  rmSync(ws, { recursive: true, force: true });
}

// canLink guard truth table (§overlap guard): self / ancestor / descendant reject
// (overlap); a disjoint already-indexed peer is accepted (the mutual-link case); a
// compartment basename collision rejects; a candidate nested inside another indexed
// workspace, or containing a nested foreign index, rejects.
async function linkGuardTests() {
  const S = await import('../scripts/lib/state.mjs');
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-guard-')));
  const H = join(ws, 'home');
  mkdirSync(join(H, 'shared', '.git'), { recursive: true }); // H gets a compartment named 'shared'
  writeFileSync(join(H, 'shared', 'x.js'), 'export function s(){}\n');
  const state = { ...S.defaultState(H) };

  eq(S.canLink(state, H).ok, false, 'guard: linking self is rejected (overlap)');
  eq(S.canLink(state, ws).ok, false, 'guard: an ancestor of self is rejected (overlap)');
  eq(S.canLink(state, join(H, 'shared')).ok, false, 'guard: a descendant of self is rejected (overlap)');

  // disjoint, already-indexed peer -> accepted (mutual-link case must not self-reject)
  const peer = join(ws, 'peer');
  mkdirSync(join(peer, '.wiregraph'), { recursive: true });
  writeFileSync(join(peer, '.wiregraph', 'state.json'), '{}');
  writeFileSync(join(peer, 'p.js'), 'export function p(){}\n');
  eq(S.canLink(state, peer).ok, true, 'guard: a disjoint, already-indexed peer is accepted');

  // basename collision: a candidate whose compartment set intersects H's ('shared')
  const clash = join(ws, 'clash');
  mkdirSync(join(clash, 'shared', '.git'), { recursive: true });
  writeFileSync(join(clash, 'shared', 'y.js'), 'export function c(){}\n');
  eq(S.canLink(state, clash).ok, false, 'guard: a compartment basename collision is rejected');

  // candidate nested INSIDE another indexed workspace
  const otherWs = join(ws, 'otherws');
  mkdirSync(join(otherWs, '.wiregraph'), { recursive: true });
  writeFileSync(join(otherWs, '.wiregraph', 'state.json'), '{}');
  const child = join(otherWs, 'child');
  mkdirSync(child, { recursive: true });
  eq(S.canLink(state, child).ok, false, 'guard: a candidate nested inside another indexed workspace is rejected');

  // candidate CONTAINING a nested foreign index
  const hasNested = join(ws, 'hasnested');
  mkdirSync(join(hasNested, 'inner', '.wiregraph'), { recursive: true });
  writeFileSync(join(hasNested, 'inner', '.wiregraph', 'state.json'), '{}');
  eq(S.canLink(state, hasNested).ok, false, 'guard: a candidate containing a nested foreign index is rejected');

  rmSync(ws, { recursive: true, force: true });
}

// previewLink return shape (L20): check-overlap documents itself as "just run the
// link-time guard", so previewLink must expose the guard verdict (guardOk/guardReason)
// SEPARATELY from `ok`, which also folds in target writability. A target that passes
// every guard but is read-only must read guardOk:true / ok:false — the decoupling that
// keeps check-overlap from reporting a writability problem as a guard REJECTION.
async function previewLinkShapeTest() {
  const L = await import('../scripts/lib/links.mjs');
  const { ws, client, server } = linkFixture('cg-previewshape-');
  await initGraph(client); // client is the indexed SELF

  // (1) guard-passing disjoint target: guard verdict is a clean pass.
  const pass = L.previewLink(client, server);
  eq(pass.guardOk, true, 'previewLink: disjoint target passes the guard (guardOk)');
  eq(pass.guardReason, null, 'previewLink: a passing guard carries a null guardReason');

  // Read-only decoupling: a guard-passing target that is not writable must still read
  // guardOk:true while ok:false. chmod is only meaningful if the harness honors mode
  // bits (root ignores them) — probe previewLink's own `writable`, and only assert the
  // decoupling when the environment actually made the dir unwritable. Never flaky.
  chmodSync(server, 0o555);
  const ro = L.previewLink(client, server);
  if (ro.writable === false) {
    eq(ro.guardOk, true, 'previewLink: read-only but guard-passing target still guardOk:true');
    eq(ro.ok, false, 'previewLink: ok folds in writability (false) — DECOUPLED from guardOk');
  } // else: running as root / mode bits ignored — skip, cannot make a read-only dir here.
  chmodSync(server, 0o755); // restore before cleanup

  // (2) guard-FAILING target: an ancestor of self overlaps, a real canLink rejection.
  const fail = L.previewLink(client, ws);
  eq(fail.guardOk, false, 'previewLink: an overlapping (ancestor) target fails the guard');
  ok(typeof fail.guardReason === 'string' && fail.guardReason.length > 0, 'previewLink: a failing guard carries a non-null guardReason');

  rmSync(ws, { recursive: true, force: true });
}

// Multi-root walk: walkSources(A) is byte-identical to the old single-root form;
// walkSources([A,B]) attributes each file to its OWN boundary; [A, symlink-to-A]
// yields each file exactly once (shared realpath dedup).
async function walkSourcesTests() {
  const W = await import('../src/extract/walk.js');
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-walk-')));
  const A = join(ws, 'A'); const B = join(ws, 'B');
  mkdirSync(join(A, '.git'), { recursive: true });
  mkdirSync(join(B, '.git'), { recursive: true });
  writeFileSync(join(A, 'a.js'), 'export function fa(){}\n');
  writeFileSync(join(B, 'b.js'), 'export function fb(){}\n');

  const single = [...W.walkSources(A)];
  const singleArr = [...W.walkSources([A])];
  eq(JSON.stringify(singleArr), JSON.stringify(single), 'walk: string root and single-element array are identical');
  eq(single.length, 1, 'walk: single root yields its one source file');
  eq(single[0].compartment, 'A', 'walk: attribution is the root basename');

  const both = [...W.walkSources([A, B])];
  eq(both.length, 2, 'walk: union walks both roots');
  const byComp = Object.fromEntries(both.map((f) => [f.compartment, f.relPath]));
  eq(byComp.A, 'a.js', 'walk: A file attributed to compartment A');
  eq(byComp.B, 'b.js', 'walk: B file attributed to compartment B (local boundary)');

  const Asym = join(ws, 'A-symlink');
  symlinkSync(A, Asym);
  const dedup = [...W.walkSources([A, Asym])];
  eq(dedup.length, 1, 'walk: [A, symlink-to-A] yields each file exactly once (realpath dedup)');

  rmSync(ws, { recursive: true, force: true });
}

// Nested git worktrees (bug: a `git worktree add` inside an indexed project). A linked
// worktree's `.git` is a FILE reading `gitdir: .../.git/worktrees/<name>`, so the old
// repo-discovery accepted it as a brand-new repo — polluting the graph with a duplicate
// branch's symbols AND forcing a spurious "new repo" full rebuild on every worktree add.
// isLinkedWorktree must detect it (and NOT a submodule, whose `.git` file reads
// `.../.git/modules/<name>`); findGitRepos/walkSources must skip it when nested but keep
// it when it IS the scan root; and changedSince must not see it as a "new repo".
async function nestedWorktreeTests() {
  const W = await import('../src/extract/walk.js');
  const GIT = await import('../scripts/lib/git.mjs');
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-wt-')));

  // A real repo with a REAL nested worktree via `git worktree add`.
  const main = join(ws, 'main');
  mkdirSync(join(main, 'src'), { recursive: true });
  await execFileP('git', ['-C', main, 'init', '-q']);
  await execFileP('git', ['-C', main, 'config', 'user.email', 't@t']);
  await execFileP('git', ['-C', main, 'config', 'user.name', 't']);
  writeFileSync(join(main, 'src', 'a.js'), 'export function fa(){}\n');
  await execFileP('git', ['-C', main, 'add', '-A']);
  await execFileP('git', ['-C', main, 'commit', '-q', '-m', 'init']);
  // A linked worktree nested INSIDE the project tree, on a new branch, with its own file.
  await execFileP('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'feature', join(main, 'wt', 'feature')]);
  writeFileSync(join(main, 'wt', 'feature', 'src', 'b.js'), 'export function fb(){}\n');
  const worktree = join(main, 'wt', 'feature');

  // --- isLinkedWorktree discriminator ---
  ok(W.isLinkedWorktree(worktree), 'worktree: isLinkedWorktree is true for a nested `git worktree add` dir');
  ok(!W.isLinkedWorktree(main), 'worktree: isLinkedWorktree is false for a normal repo (.git is a directory)');

  // A SUBMODULE has a `.git` FILE too, but pointing at `.../.git/modules/<name>` — must
  // read false, else we would wrongly skip legitimately-separate submodule repos.
  const sub = join(ws, 'submod');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, '.git'), 'gitdir: /somewhere/.git/modules/submod\n');
  ok(!W.isLinkedWorktree(sub), 'worktree: isLinkedWorktree is false for a submodule (.git file → /modules/, not /worktrees/)');

  // --- findGitRepos skips the nested worktree, keeps the root ---
  const repos = W.findGitRepos(main).map((r) => r.dir);
  eq(repos.length, 1, 'worktree: findGitRepos(root) returns exactly one repo — the root, not the nested worktree');
  ok(repos.includes(main), 'worktree: findGitRepos(root) includes the root repo');
  ok(!repos.includes(worktree), 'worktree: findGitRepos(root) excludes the nested linked worktree');

  // Index-a-worktree-as-project: when the worktree IS the scan root, it must be kept.
  const asRoot = W.findGitRepos(worktree).map((r) => r.dir);
  ok(asRoot.includes(worktree), 'worktree: findGitRepos(worktree) keeps the worktree when it IS the scan root');

  // --- the walk does not yield the worktree's files, but does yield the root's ---
  const walked = [...W.walkSources(main)].map((f) => f.abs);
  ok(walked.includes(join(main, 'src', 'a.js')), 'worktree: walk yields the root repo file');
  ok(!walked.some((p) => p.startsWith(worktree + '/')), 'worktree: walk yields NO files from the nested worktree');

  // --- regression guard: the worktree must not surface as a "new repo" in changedSince,
  // which is exactly what forced the full-rebuild escalation on every worktree add.
  await runBuild({ target: main, project: main, reset: true });
  const baseShas = {};
  for (const r of GIT.projectRepos(main)) if (r.head) baseShas[r.root] = r.head;
  ok(!(worktree in baseShas), 'worktree: projectRepos does not key the nested worktree as its own repo');
  const c = GIT.changedSince(main, baseShas);
  ok(!c.fullBuildReasons.some((r) => r.includes('new repo')), `worktree: no "new repo" escalation for the nested worktree (got ${JSON.stringify(c.fullBuildReasons)})`);

  rmSync(ws, { recursive: true, force: true });
}

// Union inference: inferSeamsAcross over two DISJOINT roots (a client that calls a
// literal route, a server that defines it) produces exactly one wire seam with the
// correct in/out roles — the clusterSeams-over-two-roots case link/unlink relies on.
async function inferAcrossTest() {
  const I = await import('../src/contracts/infer.js');
  const ws = mkdtempSync(join(tmpdir(), 'cg-infer-'));
  const client = realpathSync(mkdtempSync(join(ws, 'client-')));
  const server = realpathSync(mkdtempSync(join(ws, 'server-')));
  mkdirSync(join(client, '.git'), { recursive: true });
  mkdirSync(join(server, '.git'), { recursive: true });
  writeFileSync(join(client, 'up.js'), "async function up(){ await fetch('/api/logs', { method: 'POST', body }); }\n");
  writeFileSync(join(server, 'routes.js'), "function routes(app){ app.post('/api/logs', handle); }\n");

  const seams = I.inferSeamsAcross([client, server]);
  const wire = seams.filter((s) => s.kind === 'wire' && s.token === '/api/logs');
  eq(wire.length, 1, 'infer-across: exactly one wire seam on the shared literal route');
  eq(wire[0].compartments.length, 2, 'infer-across: the seam spans both disjoint roots');
  ok(wire[0].outCompartments.includes(basenameOf(client)), 'infer-across: the client is the out (producer) side');
  ok(wire[0].inCompartments.includes(basenameOf(server)), 'infer-across: the server is the in (consumer) side');

  // Equivalent to walking a shared parent AND to extractCandidatesAcross concat.
  const acrossCount = I.extractCandidatesAcross([client, server]).length;
  ok(acrossCount >= 2, 'infer-across: extractCandidatesAcross collects candidates from every root');

  rmSync(ws, { recursive: true, force: true });
}
function basenameOf(p) { return p.split('/').filter(Boolean).pop(); }

// Node ids are PROJECT-FREE: compartmentId/fileId/symbolId embed no project tag, so
// the same source produces byte-identical ids under any project tag — the invariant
// that lets a member's rows merge across graphs on a project-column rewrite.
async function idIndependenceTest() {
  const M = await import('../src/model.js');
  eq(M.compartmentId('api'), 'compartment:api', 'id: compartmentId is project-free');
  eq(M.fileId('api', 'src/x.js'), 'file:api:src/x.js', 'id: fileId is project-free');
  eq(M.symbolId('api', 'src/x.js', 'f', 3), 'sym:api:src/x.js:f:3', 'id: symbolId is project-free');

  // build-level proof: same source under two project tags -> identical symbol ids
  const work = mkdtempSync(join(tmpdir(), 'cg-idind-'));
  const src = join(work, 'src');
  cpSync(FIXTURE, src, { recursive: true });
  // Two DISTINCT (real) project tags over the SAME source (a --root override points
  // both walks at `src`): ids must not vary with the project tag.
  const P1 = realpathSync(mkdtempSync(join(work, 'tag1-')));
  const P2 = realpathSync(mkdtempSync(join(work, 'tag2-')));
  const db1 = join(work, 'one.db'), db2 = join(work, 'two.db');
  await runBuild({ target: P1, project: P1, db: db1, reset: true, roots: [src] });
  await runBuild({ target: P2, project: P2, db: db2, reset: true, roots: [src] });
  const c1 = connect(db1, { readonly: true }); const c2 = connect(db2, { readonly: true });
  const ids1 = c1.prepare('SELECT id FROM symbols WHERE project=? ORDER BY id').all(P1).map((r) => r.id);
  const ids2 = c2.prepare('SELECT id FROM symbols WHERE project=? ORDER BY id').all(P2).map((r) => r.id);
  eq(JSON.stringify(ids1), JSON.stringify(ids2), 'id: symbol ids are identical across two project tags');
  c1.close(); c2.close();
  rmSync(work, { recursive: true, force: true });
}

// Union build + member-losing-reset backstop: a full --reset over a graph with a
// linked member walks BOTH roots (member compartments survive); a stray single-root
// reset (roots override excluding the member) is REFUSED by loadGraph's backstop.
async function unionBuildTest() {
  const S = await import('../scripts/lib/state.mjs');
  const ws = mkdtempSync(join(tmpdir(), 'cg-union-'));
  const G = realpathSync(mkdtempSync(join(ws, 'home-')));
  const Mm = realpathSync(mkdtempSync(join(ws, 'member-')));
  mkdirSync(join(G, '.git'), { recursive: true });
  mkdirSync(join(Mm, '.git'), { recursive: true });
  writeFileSync(join(G, 'g.js'), 'export function g(){ return 1; }\n');
  writeFileSync(join(Mm, 'm.js'), 'export function m(){ return 2; }\n');
  const db = join(G, '.wiregraph', 'graph.db');

  await runBuild({ target: G, project: G, db, reset: true }); // index home alone
  S.addLink(G, { root: Mm, peer: Mm, initiator: G });         // link the member

  // full reset over the union: both compartments present
  await runBuild({ target: G, project: G, db, reset: true });
  let conn = connect(db, { readonly: true });
  const comps = conn.prepare('SELECT name FROM compartments WHERE project=?').all(G).map((r) => r.name);
  ok(comps.includes(basenameOf(G)), 'union-build: own compartment present after a union reset');
  ok(comps.includes(basenameOf(Mm)), 'union-build: linked member compartment present after a union reset');
  conn.close();

  // stray single-root reset (roots override drops the member) -> refused by backstop
  let threw = false;
  try { await runBuild({ target: G, project: G, db, reset: true, roots: [G] }); }
  catch (e) { threw = /refusing to --reset/.test(e.message); }
  ok(threw, 'union-build: a member-losing --reset is refused by the loadGraph backstop');

  // the member survived the refused reset (the wipe rolled back)
  conn = connect(db, { readonly: true });
  const still = conn.prepare('SELECT name FROM compartments WHERE project=?').all(G).map((r) => r.name);
  ok(still.includes(basenameOf(Mm)), 'union-build: the refused reset left the member intact');
  conn.close();

  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// LINK FEATURE — surface + sync integration tests (scope B). Exercise the
// links.mjs CLI functions, the reindexFiles fan-out primitive, and the
// graph_stats Own/Linked grouping end-to-end over real fixture dirs.
// ---------------------------------------------------------------------------

// A disjoint client (calls a literal route) + server (defines it), each a git repo.
function linkFixture(prefix) {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  const client = realpathSync(mkdtempSync(join(ws, 'client-')));
  const server = realpathSync(mkdtempSync(join(ws, 'server-')));
  mkdirSync(join(client, '.git'), { recursive: true });
  mkdirSync(join(server, '.git'), { recursive: true });
  writeFileSync(join(client, 'up.js'), "async function up(){ await fetch('/api/logs', { method: 'POST', body }); }\n");
  writeFileSync(join(server, 'routes.js'), "function routes(app){ app.post('/api/logs', handle); }\n");
  return { ws, client, server };
}
function compNamesOf(root, project) {
  const c = connect(join(root, '.wiregraph', 'graph.db'), { readonly: true });
  try { return c.prepare('SELECT name FROM compartments WHERE project=?').all(project).map((r) => r.name); }
  finally { c.close(); }
}
function edgeCount(root, project, type) {
  const c = connect(join(root, '.wiregraph', 'graph.db'), { readonly: true });
  try { return c.prepare('SELECT count(*) n FROM edges WHERE project=? AND type=?').get(project, type).n; }
  finally { c.close(); }
}
// The project's WIRE edges as a canonical Set of `src|dst|token` keys, so a re-derived
// set can be compared for equality against a from-scratch full rebuild's set.
function wireSet(root, project) {
  const c = connect(join(root, '.wiregraph', 'graph.db'), { readonly: true });
  try {
    return new Set(
      c.prepare("SELECT src, dst, token FROM edges WHERE project=? AND type='WIRE'")
        .all(project).map((r) => `${r.src}|${r.dst}|${r.token}`),
    );
  } finally { c.close(); }
}
function setEq(a, b) { return a.size === b.size && [...a].every((x) => b.has(x)); }
// Seed a graph as if /wiregraph-init had run it (build + a state.json so SELF resolves).
async function initGraph(root) {
  const S = await import('../scripts/lib/state.mjs');
  await runBuild({ target: root, project: root, reset: true });
  S.updateState(root, { lastFullBuild: new Date().toISOString() });
}

// Mutual write + auto-init: linking a target with no .wiregraph creates its
// state.json + db; both graphs get reciprocal records with IDENTICAL initiator and
// autoCreated:true; both dbs hold the full union; the cross-member seam is minted.
async function linkMutualAutoInitTest() {
  const L = await import('../scripts/lib/links.mjs');
  const S = await import('../scripts/lib/state.mjs');
  const { ws, client, server } = linkFixture('cg-linkauto-');
  await initGraph(client);

  await L.doLink(client, server); // server has no .wiregraph -> auto-init

  ok(existsSync(join(server, '.wiregraph', 'state.json')), 'link: peer graph auto-created (state.json)');
  ok(existsSync(join(server, '.wiregraph', 'graph.db')), 'link: peer graph auto-created (graph.db)');

  const cs = S.readState(client), ss = S.readState(server);
  eq(cs.links.length, 1, 'link: client has one member record');
  eq(ss.links.length, 1, 'link: server has the reciprocal mirror record');
  eq(cs.links[0].root, server, 'link: client member root = server');
  eq(ss.links[0].root, client, 'link: server member root = client');
  eq(cs.links[0].initiator, ss.links[0].initiator, 'link: initiator IDENTICAL on both sides');
  eq(cs.links[0].initiator, client, 'link: initiator = the linking graph');
  eq(cs.links[0].autoCreated, true, 'link: autoCreated true (peer conjured)');
  eq(ss.links[0].autoCreated, true, 'link: autoCreated true on the mirror too');

  const cComps = compNamesOf(client, client), sComps = compNamesOf(server, server);
  ok(cComps.includes(basenameOf(client)) && cComps.includes(basenameOf(server)), 'link: client db holds BOTH compartments (union under client tag)');
  ok(sComps.includes(basenameOf(client)) && sComps.includes(basenameOf(server)), 'link: server db holds BOTH compartments (union under server tag)');

  // The inferred seam mints REFERENCES from both sides and a directional WIRE edge.
  ok(edgeCount(client, client, 'REFERENCES') >= 2, 'link: both sides REFERENCES the inferred contract');
  ok(edgeCount(client, client, 'WIRE') >= 1, 'link: a cross-member WIRE edge exists in the client db');

  // Cross-member get_source (§8 task-7): reading a symbol that lives in the LINKED
  // member from the CLIENT's own db must resolve the file via compartments.root to
  // the member's REAL external path and return the member's body — the exact
  // resolution a silent basename collision would corrupt.
  const cdb = connect(join(client, '.wiregraph', 'graph.db'), { readonly: true });
  const memberSrc = Q.getSource(cdb, client, 'routes');
  cdb.close();
  has(memberSrc, `${basenameOf(server)}:routes.js`, 'link: get_source header attributes the symbol to the member compartment/file');
  has(memberSrc, "app.post('/api/logs'", 'link: get_source reads the member\'s external file body (external root resolved, not a collided own file)');

  rmSync(ws, { recursive: true, force: true });
}

// Unlink: full-reset rebuild purges the member's compartment + the seam edges from
// both dbs; an auto-created, now-linkless peer is flagged cleanup-eligible; a
// PRE-EXISTING peer is not eligible and its folder is left intact.
async function unlinkPurgeCleanupTest() {
  const L = await import('../scripts/lib/links.mjs');
  const S = await import('../scripts/lib/state.mjs');
  const { ws, client, server } = linkFixture('cg-unlink-');
  await initGraph(client);
  await L.doLink(client, server); // auto-creates server

  const r = await L.doUnlink(client, server);
  eq(r.cleanupEligible, true, 'unlink: auto-created linkless peer is cleanup-eligible');
  eq(S.readState(client).links.length, 0, 'unlink: client member record removed');
  eq(S.readState(server).links.length, 0, 'unlink: server mirror record removed');

  const cComps = compNamesOf(client, client);
  ok(!cComps.includes(basenameOf(server)), 'unlink: server compartment PURGED from client db');
  ok(cComps.includes(basenameOf(client)), 'unlink: client own compartment survives');
  eq(edgeCount(client, client, 'WIRE'), 0, 'unlink: cross-member WIRE edge is gone');
  ok(existsSync(join(server, '.wiregraph', 'state.json')), 'unlink: auto-created peer NOT deleted by unlink itself (cleanup is a separate offered step)');

  // Pre-existing peer: link then unlink -> not eligible, folder untouched.
  const peer = realpathSync(mkdtempSync(join(ws, 'peer-')));
  mkdirSync(join(peer, '.git'), { recursive: true });
  writeFileSync(join(peer, 'r.js'), "function r(app){ app.post('/api/logs', h); }\n");
  await initGraph(peer);
  await L.doLink(client, peer);
  const r2 = await L.doUnlink(client, peer);
  eq(r2.cleanupEligible, false, 'unlink: a PRE-EXISTING peer is NOT cleanup-eligible');
  ok(existsSync(join(peer, '.wiregraph', 'state.json')), 'unlink: pre-existing peer folder untouched');

  rmSync(ws, { recursive: true, force: true });
}

// Fan-out attribution: an edit under a linked member re-indexes into BOTH dbs with
// byte-identical ids (project-free), and reindexFiles reports both graphs rebuilt.
async function fanOutAttributionTest() {
  const B = await import('../src/build.js');
  const L = await import('../scripts/lib/links.mjs');
  const { ws, client, server } = linkFixture('cg-fanout-');
  await initGraph(client);
  await L.doLink(client, server);

  writeFileSync(join(server, 'routes.js'), "function routes(app){ app.post('/api/logs', handle); }\nfunction extra(){ return 42; }\n");
  const rebuilt = await B.reindexFiles([join(server, 'routes.js')], client, { fanOut: true });
  ok(rebuilt.includes(client) && rebuilt.includes(server), 'fan-out: an edit under the member rebuilt BOTH graphs');

  const idsFor = (root, project) => {
    const c = connect(join(root, '.wiregraph', 'graph.db'), { readonly: true });
    try { return c.prepare("SELECT id FROM symbols WHERE project=? AND file='routes.js' AND kind<>'module' ORDER BY id").all(project).map((r) => r.id); }
    finally { c.close(); }
  };
  const cIds = idsFor(client, client), sIds = idsFor(server, server);
  ok(cIds.some((id) => id.includes(':extra:')), 'fan-out: the newly added symbol was indexed');
  eq(JSON.stringify(cIds), JSON.stringify(sIds), 'fan-out: symbol ids identical across both dbs (differ only by project column)');

  rmSync(ws, { recursive: true, force: true });
}

// reindexFiles single-graph regression: with no members, it targets ONLY the
// editing graph (== the old direct runBuild files path) and indexes the new symbol.
async function reindexRegressionTest() {
  const B = await import('../src/build.js');
  const ws = mkdtempSync(join(tmpdir(), 'cg-reidx-'));
  const A = realpathSync(mkdtempSync(join(ws, 'solo-')));
  mkdirSync(join(A, '.git'), { recursive: true });
  writeFileSync(join(A, 'm.js'), 'export function a(){ return 1; }\n');
  await initGraph(A);
  writeFileSync(join(A, 'm.js'), 'export function a(){ return 1; }\nexport function b(){ return 2; }\n');
  const rebuilt = await B.reindexFiles([join(A, 'm.js')], A, {});
  eq(JSON.stringify(rebuilt), JSON.stringify([A]), 'reindex: single-graph fan targets only the editing graph');
  const c = connect(join(A, '.wiregraph', 'graph.db'), { readonly: true });
  has(Q.findSymbol(c, A, 'b'), 'match(es)', 'reindex: the new symbol is indexed (== old runBuild files path)');
  c.close();
  rmSync(ws, { recursive: true, force: true });
}

// --files parsing: each following argv element is ONE path (never comma-split), so a
// path that itself contains a comma survives intact — the post-edit hook passes a
// single absolute path as one argv element, and under the old split-on-comma parser
// `/a/foo,bar.js` was shredded into two bogus fragments and silently dropped.
async function filesArgParseTest() {
  const R = await import('../scripts/hooks/refresh.mjs');
  const B = await import('../src/build.js');

  // Regression: a comma inside the path is preserved as ONE token (both parsers).
  eq(JSON.stringify(R.parseArgs(['--files', '/a/foo,bar.js']).files), JSON.stringify(['/a/foo,bar.js']),
     'refresh --files keeps a comma path as one entry');
  eq(JSON.stringify(B.parseArgs(['--files', '/a/foo,bar.js']).files), JSON.stringify(['/a/foo,bar.js']),
     'build --files keeps a comma path as one entry');

  // Multiple files: passed as separate argv elements.
  eq(JSON.stringify(B.parseArgs(['--files', '/a/x.js', '/a/y.js']).files), JSON.stringify(['/a/x.js', '/a/y.js']),
     'build --files consumes multiple path args');
  eq(JSON.stringify(R.parseArgs(['--files', '/a/x.js', '/a/y.js']).files), JSON.stringify(['/a/x.js', '/a/y.js']),
     'refresh --files consumes multiple path args');

  // A flag after the --files list ends consumption and still parses.
  const o = B.parseArgs(['/some/dir', '--files', '/a/x.js', '--reset']);
  eq(JSON.stringify(o.files), JSON.stringify(['/a/x.js']), 'build --files stops at the next --flag');
  eq(o.reset, true, 'build --reset after a --files list still parses');
}

// Integration: a real source file whose path contains a comma re-indexes cleanly —
// its symbol is queryable afterward, proving the comma path was NOT shredded/dropped.
async function commaPathReindexTest() {
  const B = await import('../src/build.js');
  const ws = mkdtempSync(join(tmpdir(), 'cg-comma-'));
  const A = realpathSync(mkdtempSync(join(ws, 'proj-')));
  mkdirSync(join(A, '.git'), { recursive: true });
  writeFileSync(join(A, 'plain.js'), 'export function plain(){ return 0; }\n');
  await initGraph(A);
  const commaPath = join(A, 'foo,bar.js');
  writeFileSync(commaPath, 'export function commaSym(){ return 42; }\n');
  await B.reindexFiles([commaPath], A, {});
  const c = connect(join(A, '.wiregraph', 'graph.db'), { readonly: true });
  has(Q.findSymbol(c, A, 'commaSym'), 'match(es)', 'comma-path file re-indexed (path not shredded)');
  c.close();
  rmSync(ws, { recursive: true, force: true });
}

// findIndexedRoot invariance / sub-repo cwd: with two disjoint indexed graphs A and
// B, a cwd nested inside B resolves to B, never A — so a refresh fired from a
// sub-repo targets the right graph (refresh.mjs resolveProject uses this).
async function findIndexedRootInvarianceTest() {
  const S = await import('../scripts/lib/state.mjs');
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-fir-')));
  const A = join(ws, 'A'), B = join(ws, 'B');
  mkdirSync(join(A, '.wiregraph'), { recursive: true });
  writeFileSync(join(A, '.wiregraph', 'state.json'), JSON.stringify({ project: A }));
  const deep = join(B, 'sub', 'deep');
  mkdirSync(deep, { recursive: true });
  mkdirSync(join(B, '.wiregraph'), { recursive: true });
  writeFileSync(join(B, '.wiregraph', 'state.json'), JSON.stringify({ project: B }));
  eq(S.findIndexedRoot(B), B, 'findIndexedRoot: B resolves to itself');
  eq(S.findIndexedRoot(deep), B, 'findIndexedRoot: a nested cwd in B resolves to B, never A');
  rmSync(ws, { recursive: true, force: true });
}

// Link atomicity: a crash after the FIRST record write (client record present,
// mirror missing, peer graph built) re-runs to convergence — mirror written, no
// duplicate record, no orphan graph.
async function linkAtomicityTest() {
  const L = await import('../scripts/lib/links.mjs');
  const S = await import('../scripts/lib/state.mjs');
  const { ws, client, server } = linkFixture('cg-atomic-');
  await initGraph(client);
  // Simulate the crash state: peer graph built + client record written, mirror not.
  await initGraph(server);
  S.addLink(client, { root: server, peer: server, initiator: client, autoCreated: true });

  await L.doLink(client, server); // re-run reconciles
  const cs = S.readState(client), ss = S.readState(server);
  eq(cs.links.length, 1, 'atomicity: client record not duplicated on re-run');
  eq(ss.links.length, 1, 'atomicity: mirror record created on re-run (converged)');
  eq(cs.links[0].initiator, client, 'atomicity: initiator preserved through reconcile');
  ok(compNamesOf(server, server).includes(basenameOf(client)), 'atomicity: server db now holds the union (no orphan)');

  rmSync(ws, { recursive: true, force: true });
}

// Initiator is preserved (not flipped) when the pair is re-linked from the OPPOSITE
// graph. initiator is an immutable fact about the ORIGINAL link ("who conjured whom"),
// like autoCreated — flipping it makes unlink offer to HARD-REMOVE the real graph and
// never clean the genuine orphan. Here B conjures A (initiator=B); re-linking from A
// must keep initiator=B on both records, so cleanup stays targeted at the orphan A.
async function linkInitiatorPreservedTest() {
  const L = await import('../scripts/lib/links.mjs');
  const S = await import('../scripts/lib/state.mjs');
  const { ws, client: B, server: A } = linkFixture('cg-initflip-');
  await initGraph(B);

  await L.doLink(B, A); // A has no .wiregraph -> auto-created, initiator = B
  eq(S.findLink(B, A).initiator, B, 'initflip: original link stamps initiator = B (the conjurer)');
  eq(S.findLink(A, B).initiator, B, 'initflip: mirror on the auto-created A also names B');
  eq(S.findLink(A, B).autoCreated, true, 'initflip: A is marked auto-created');

  await L.doLink(A, B); // reconcile from the OPPOSITE side (documented repair path)
  eq(S.findLink(A, B).initiator, B, 'initflip: reconcile from A must NOT flip initiator — still B');
  eq(S.findLink(B, A).initiator, B, 'initflip: B-side record still names B after the opposite-side re-link');

  eq(L.previewUnlink(A, B).cleanupEligible, false, 'initflip: unlink from A never offers to remove the real graph B');
  eq(L.previewUnlink(B, A).cleanupEligible, true, 'initflip: the genuine orphan A is still offered for cleanup');

  rmSync(ws, { recursive: true, force: true });
}

// graph_stats grouping: a graph with a linked member groups compartments under
// Own root vs Linked headings and prints a Members block; a member-free graph keeps
// the flat "Symbols per compartment" shape.
async function graphStatsGroupingTest() {
  const L = await import('../scripts/lib/links.mjs');
  const { ws, client, server } = linkFixture('cg-gstats-');
  await initGraph(client);

  const solo = connect(join(client, '.wiregraph', 'graph.db'), { readonly: true });
  has(Q.graphStats(solo, client), 'Symbols per compartment:', 'graph_stats: a member-free graph keeps the flat shape');
  solo.close();

  await L.doLink(client, server);
  const c = connect(join(client, '.wiregraph', 'graph.db'), { readonly: true });
  const out = Q.graphStats(c, client);
  has(out, 'Members: 1 linked', 'graph_stats: prints a Members summary block');
  has(out, `Own root: ${client}`, 'graph_stats: groups own compartments under Own root');
  has(out, `Linked: ${server}`, 'graph_stats: groups the member under a Linked heading');
  // The member compartment must sit UNDER the Linked heading, not Own root.
  const ownSeg = out.slice(out.indexOf('Own root:'), out.indexOf('Linked:'));
  const linkedSeg = out.slice(out.indexOf('Linked:'));
  ok(ownSeg.includes(basenameOf(client)) && !ownSeg.includes(basenameOf(server)), 'graph_stats: own segment lists only the own compartment');
  ok(linkedSeg.includes(basenameOf(server)), 'graph_stats: the member compartment is grouped under Linked');
  c.close();

  rmSync(ws, { recursive: true, force: true });
}

// Auto-created intent survives a crash in the auto-init → mirror window (finding #5).
// doLink writes SELF's link record (carrying autoCreated) BEFORE auto-init, so a
// throw injected AFTER auto-init but BEFORE the mirror write still lets a re-run
// stamp autoCreated on BOTH records — and a later unlink offers to clean the
// conjured peer. Drives the REAL doLink via its afterAutoInit test hook.
async function linkAutoCreatedCrashTest() {
  const L = await import('../scripts/lib/links.mjs');
  const S = await import('../scripts/lib/state.mjs');
  const { ws, client, server } = linkFixture('cg-autocrash-');
  await initGraph(client);

  // First attempt: throw right after auto-init, before the mirror record is written.
  let crashed = false;
  try {
    await L.doLink(client, server, { afterAutoInit: () => { throw new Error('simulated crash'); } });
  } catch { crashed = true; }
  ok(crashed, 'autocrash: the injected crash fired after auto-init');
  ok(existsSync(join(server, '.wiregraph', 'state.json')), 'autocrash: peer graph was auto-inited before the crash');

  // The durable intent: SELF's record exists with autoCreated:true even though the
  // crash pre-empted the mirror write (this is what a post-auto-init check would lose).
  const mid = S.readState(client);
  eq(mid.links.length, 1, 'autocrash: self record persisted (written BEFORE auto-init)');
  eq(mid.links[0].autoCreated, true, 'autocrash: self record marks the peer auto-created');
  ok(!S.findLink(server, client), 'autocrash: mirror not yet written (the crash window)');

  // Re-run converges: both records present, both autoCreated:true (NOT lost to the
  // now-preexisting peer state.json).
  await L.doLink(client, server);
  const cs = S.readState(client), ss = S.readState(server);
  eq(cs.links.length, 1, 'autocrash: no duplicate self record after re-run');
  eq(ss.links.length, 1, 'autocrash: mirror written on re-run (converged)');
  eq(cs.links[0].autoCreated, true, 'autocrash: self autoCreated preserved through reconcile');
  eq(ss.links[0].autoCreated, true, 'autocrash: mirror autoCreated true (intent survived the crash)');

  // Consequently, unlink correctly offers to clean the conjured peer.
  const r = await L.doUnlink(client, server);
  eq(r.cleanupEligible, true, 'autocrash: conjured peer is cleanup-eligible after the reconciled link');

  rmSync(ws, { recursive: true, force: true });
}

// Reset preserves links via EVERY entry point (finding #6, §9). Each named reset
// caller must funnel through runBuild→memberRoots (the union walk), never a stray
// single-root reset that would erase the member. The build CLI and refresh.mjs rows
// drive the REAL scripts as subprocesses; update_graph{full:true} and the schema-heal
// reset issue the identical runBuild call the server handlers make (spinning the MCP
// server over stdio is out of scope), so they are driven directly.
async function resetEntryPointsTest() {
  const linkedHome = async () => {
    const S = await import('../scripts/lib/state.mjs');
    const ws = mkdtempSync(join(tmpdir(), 'cg-reset-'));
    const G = realpathSync(mkdtempSync(join(ws, 'home-')));
    const M = realpathSync(mkdtempSync(join(ws, 'member-')));
    mkdirSync(join(G, '.git'), { recursive: true });
    mkdirSync(join(M, '.git'), { recursive: true });
    writeFileSync(join(G, 'g.js'), 'export function g(){ return 1; }\n');
    writeFileSync(join(M, 'm.js'), 'export function m(){ return 2; }\n');
    await runBuild({ target: G, project: G, reset: true });   // index home alone
    S.addLink(G, { root: M, peer: M, initiator: G });         // link the member
    await runBuild({ target: G, project: G, reset: true });   // union rebuild — member now in db
    return { ws, G, M };
  };
  const entryPoints = [
    { name: 'build CLI --reset', run: (G) => execFileP('node', [BUILD, G, '--reset']) },
    { name: 'refresh.mjs --full', run: (G) => execFileP('node', [REFRESH, '--full'], { env: { ...process.env, CLAUDE_PROJECT_DIR: G } }) },
    { name: 'update_graph {full:true}', run: (G) => runBuild({ target: G, project: G, reset: true }) },
    { name: 'schema-heal reset', run: (G) => runBuild({ target: G, project: G, reset: true }) },
  ];
  for (const ep of entryPoints) {
    const { ws, G, M } = await linkedHome();
    await ep.run(G);
    const comps = compNamesOf(G, G);
    ok(comps.includes(basenameOf(M)), `reset-entry: member compartment survives a reset via ${ep.name}`);
    ok(comps.includes(basenameOf(G)), `reset-entry: own compartment survives a reset via ${ep.name}`);
    rmSync(ws, { recursive: true, force: true });
  }
}

// Member-aware freshness (finding #7, §9). changedSince/projectRepos iterate the
// union, so a committed change in a linked member surfaces with a newShas entry
// keyed by the MEMBER's repo root; and two members whose repo dirs share a basename
// get DISTINCT reposLastSha keys (keyed by absolute root, the git-layer rhyme of the
// compartment basename guard). Uses real git repos.
async function memberFreshnessTest() {
  const S = await import('../scripts/lib/state.mjs');
  const GIT = await import('../scripts/lib/git.mjs');
  const gitCommit = async (dir, files, msg = 'init') => {
    await execFileP('git', ['-C', dir, 'init', '-q']);
    await execFileP('git', ['-C', dir, 'config', 'user.email', 't@t']);
    await execFileP('git', ['-C', dir, 'config', 'user.name', 't']);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    await execFileP('git', ['-C', dir, 'add', '-A']);
    await execFileP('git', ['-C', dir, 'commit', '-q', '-m', msg]);
  };
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-mfresh-')));

  // home indexed + one linked member, both real git repos.
  const home = realpathSync(mkdtempSync(join(ws, 'home-')));
  const member = realpathSync(mkdtempSync(join(ws, 'member-')));
  await gitCommit(home, { 'h.js': 'export function h(){ return 1; }\n' });
  await gitCommit(member, { 'm.js': 'export function m(){ return 2; }\n' });
  await runBuild({ target: home, project: home, reset: true });
  S.addLink(home, { root: member, peer: member, initiator: home });

  const baseShas = {};
  for (const r of GIT.projectRepos(home)) if (r.head) baseShas[r.root] = r.head;
  ok(baseShas[member], 'member-fresh: projectRepos discovers the linked member repo, keyed by its root');

  // Commit a change INSIDE the member.
  writeFileSync(join(member, 'm.js'), 'export function m(){ return 2; }\nexport function extra(){ return 3; }\n');
  await execFileP('git', ['-C', member, 'commit', '-qam', 'add extra']);

  const c = GIT.changedSince(home, baseShas);
  ok(c.files.includes(join(member, 'm.js')), 'member-fresh: changedSince surfaces the member-repo change across the union');
  ok(c.newShas[member] && c.newShas[member] !== baseShas[member], 'member-fresh: newShas has an entry keyed by the member repo root, advanced to its new HEAD');

  // Two members with a COLLIDING repo basename ('svc') under distinct parents: keyed
  // by absolute root, so two distinct reposLastSha keys — not one collapsed entry.
  const home2 = realpathSync(mkdtempSync(join(ws, 'home2-')));
  const a = realpathSync(mkdtempSync(join(ws, 'a-')));
  const b = realpathSync(mkdtempSync(join(ws, 'b-')));
  const svcA = join(a, 'svc'), svcB = join(b, 'svc');
  mkdirSync(svcA, { recursive: true }); mkdirSync(svcB, { recursive: true });
  await gitCommit(home2, { 'h.js': 'export function h2(){ return 1; }\n' });
  await gitCommit(svcA, { 'x.js': 'export function xa(){ return 1; }\n' });
  await gitCommit(svcB, { 'y.js': 'export function yb(){ return 2; }\n' });
  await runBuild({ target: home2, project: home2, reset: true });
  // addLink directly (canLink would reject same-basename COMPARTMENTS; this asserts
  // the independent git-layer keying, which must stay root-keyed regardless).
  S.addLink(home2, { root: svcA, peer: svcA, initiator: home2 });
  S.addLink(home2, { root: svcB, peer: svcB, initiator: home2 });
  const c2 = GIT.changedSince(home2, {});
  ok(c2.newShas[svcA] && c2.newShas[svcB], 'member-fresh: same-basename members BOTH present in newShas');
  ok(c2.newShas[svcA] !== c2.newShas[svcB] || svcA !== svcB, 'member-fresh: same-basename members are keyed by distinct absolute roots (no key collision)');
  eq([svcA, svcB].filter((k) => k in c2.newShas).length, 2, 'member-fresh: exactly two distinct keys for the colliding-basename members');

  rmSync(ws, { recursive: true, force: true });
}

// Catch-up escalation (H4 + M5). changedSince flags conditions where an INCREMENTAL
// apply would silently miss committed code — a freshly-cloned sub-repo never diffed
// (new repo, no baseline entry) or a stored baseline that's no longer a reachable
// revision (invalid baseline, e.g. gc'd after a rebase). Both set fullBuildNeeded so
// an auto-catch-up caller escalates to a full rebuild instead of advancing shas past
// unindexed history. Also asserts the normal incremental path is undisturbed, and an
// end-to-end assertion that refresh.mjs's auto path escalates and actually indexes
// the new repo's code. Uses real git repos.
async function catchUpEscalationTest() {
  const S = await import('../scripts/lib/state.mjs');
  const GIT = await import('../scripts/lib/git.mjs');
  const gitCommit = async (dir, files, msg = 'init') => {
    await execFileP('git', ['-C', dir, 'init', '-q']);
    await execFileP('git', ['-C', dir, 'config', 'user.email', 't@t']);
    await execFileP('git', ['-C', dir, 'config', 'user.name', 't']);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    await execFileP('git', ['-C', dir, 'add', '-A']);
    await execFileP('git', ['-C', dir, 'commit', '-q', '-m', msg]);
  };
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-catchup-')));

  // --- H4: a NEW repo (no reposLastSha entry) with ONLY committed code ---------
  const home = realpathSync(mkdtempSync(join(ws, 'home-')));
  await gitCommit(home, { 'h.js': 'export function h(){ return 1; }\n' });
  await runBuild({ target: home, project: home, reset: true });
  const baseShas = {};
  for (const r of GIT.projectRepos(home)) if (r.head) baseShas[r.root] = r.head;

  // A freshly-cloned sub-repo appears AFTER the baseline: committed source, NO
  // uncommitted changes → no baseline entry and zero porcelain files, so the old
  // incremental path would index nothing yet march the sha to HEAD forever.
  const sub = join(home, 'sub');
  mkdirSync(sub, { recursive: true });
  await gitCommit(sub, { 's.js': 'export function subFn(){ return 2; }\n' });
  const cNew = GIT.changedSince(home, baseShas);
  ok(cNew.fullBuildNeeded === true, 'catch-up H4: a new sub-repo with only committed code sets fullBuildNeeded');
  ok(cNew.fullBuildReasons.some((r) => r.includes('new repo') && r.includes('sub')), `catch-up H4: a reason names the new repo (got ${JSON.stringify(cNew.fullBuildReasons)})`);

  // --- M5: a stored baseline that is no longer a reachable revision ------------
  // 40 hex chars that name no real object → git diff last..HEAD FAILS (git() → null,
  // distinct from "" for a valid-but-empty diff). This must NOT force a whole-project
  // full rebuild (bug B): it surfaces the ONE repo in invalidBaselineRepos so the
  // caller can content-reconcile just that repo. fullBuildNeeded stays false — only a
  // NEW repo (H4) escalates the whole project.
  const m5 = realpathSync(mkdtempSync(join(ws, 'm5-')));
  await gitCommit(m5, { 'a.js': 'export function a(){ return 1; }\n' });
  const bogus = 'deadbeef'.repeat(5);
  const cBad = GIT.changedSince(m5, { [m5]: bogus });
  ok(cBad.fullBuildNeeded === false, 'catch-up M5: an unreachable stored sha does NOT force a whole-project full rebuild (content-reconcile instead)');
  ok(cBad.invalidBaselineRepos.some((r) => r.root === m5), `catch-up M5: the repo with the invalid baseline is surfaced in invalidBaselineRepos (got ${JSON.stringify(cBad.invalidBaselineRepos.map((r) => r.name))})`);
  ok(!cBad.fullBuildReasons.some((r) => r.includes('invalid baseline')), 'catch-up M5: invalid baseline is no longer lumped into fullBuildReasons');

  // --- Negative: a valid baseline with a real commit on top → normal incremental
  const norm = realpathSync(mkdtempSync(join(ws, 'norm-')));
  await gitCommit(norm, { 'a.js': 'export function a(){ return 1; }\n' });
  const normBase = GIT.headSha(norm);
  writeFileSync(join(norm, 'b.js'), 'export function b(){ return 2; }\n');
  await execFileP('git', ['-C', norm, 'add', '-A']);
  await execFileP('git', ['-C', norm, 'commit', '-qm', 'add b']);
  const cNorm = GIT.changedSince(norm, { [norm]: normBase });
  ok(cNorm.fullBuildNeeded === false, 'catch-up negative: a valid baseline + real commit stays incremental (no escalation)');
  ok(cNorm.files.includes(join(norm, 'b.js')), 'catch-up negative: the committed change still surfaces in files');

  // --- Negative: fully up to date (last === head, no edits) → nothing to do ----
  const cFresh = GIT.changedSince(norm, { [norm]: GIT.headSha(norm) });
  ok(cFresh.fullBuildNeeded === false, 'catch-up negative: an up-to-date repo does not escalate');
  eq(cFresh.files.length, 0, 'catch-up negative: an up-to-date repo reports no changed files');

  // --- V7: null diff vs valid-but-effectively-empty diff -----------------------
  // The M5 case above proves a NULL diff (git() returns null on an unreachable
  // baseline) escalates to fullBuildNeeded. This is the CONTRAST: a VALID baseline
  // whose only commit-on-top touches a NON-source file. `git diff` then returns a
  // non-null, NON-EMPTY string (README.md changed), but langForFile filters every
  // path out → files is empty. That empty-after-filter case must NOT escalate — it is
  // "nothing indexable changed", categorically different from a failed (null) diff.
  const nonsrc = realpathSync(mkdtempSync(join(ws, 'nonsrc-')));
  await gitCommit(nonsrc, { 'a.js': 'export function a(){ return 1; }\n' });
  const nonsrcBase = GIT.headSha(nonsrc);
  writeFileSync(join(nonsrc, 'README.md'), '# docs\n\nsome prose, not source\n');
  await execFileP('git', ['-C', nonsrc, 'add', '-A']);
  await execFileP('git', ['-C', nonsrc, 'commit', '-qm', 'docs only']);
  // Sanity: the raw diff really is non-null and non-empty (names README.md) — so the
  // FALSE below comes from the source-language filter, not from a null/empty diff.
  // (git() is module-private, so probe the same range with the git CLI directly.)
  const rawDiff = (await execFileP('git', ['-C', nonsrc, 'diff', '--name-only', `${nonsrcBase}..HEAD`])).stdout;
  ok(rawDiff.includes('README.md'),
    'catch-up V7: the raw diff is a non-null, non-empty string naming the non-source file');
  const cNonSrc = GIT.changedSince(nonsrc, { [nonsrc]: nonsrcBase });
  ok(cNonSrc.fullBuildNeeded === false, 'catch-up V7: a valid baseline with only a non-source (non-null, non-empty) diff does NOT escalate');
  eq(cNonSrc.files.length, 0, 'catch-up V7: the non-source change is filtered out (no indexable files), distinct from a null diff');

  // --- End-to-end: refresh.mjs auto path escalates and indexes the new repo ----
  // Stamp a baseline via --full (only `home2` in reposLastSha), then add a sub-repo
  // and run the AUTO path. The escalation must full-rebuild: sub's committed symbol
  // becomes queryable and its repo sha lands in reposLastSha.
  const home2 = realpathSync(mkdtempSync(join(ws, 'home2-')));
  await gitCommit(home2, { 'h.js': 'export function h2(){ return 1; }\n' });
  await execFileP('node', [REFRESH, '--full'], { env: { ...process.env, CLAUDE_PROJECT_DIR: home2 } });
  const before = S.readState(home2);
  ok(before?.reposLastSha?.[home2] && !before.reposLastSha[join(home2, 'nested')], 'catch-up e2e: baseline stamped for home only');

  const nested = join(home2, 'nested');
  mkdirSync(nested, { recursive: true });
  await gitCommit(nested, { 'n.js': 'export function nestedFn(){ return 9; }\n' });
  await execFileP('node', [REFRESH], { env: { ...process.env, CLAUDE_PROJECT_DIR: home2 } });

  const after = S.readState(home2);
  ok(after?.reposLastSha?.[nested], 'catch-up e2e: auto path restamped the new repo sha (escalated to full rebuild)');
  ok(after.lastFullBuild && after.lastFullBuild !== before.lastFullBuild, 'catch-up e2e: a fresh full build ran (lastFullBuild advanced)');
  const conn = connect(join(home2, '.wiregraph', 'graph.db'), { readonly: true });
  has(Q.findSymbol(conn, home2, 'nestedFn'), 'n.js', 'catch-up e2e: the new repo\'s committed symbol is now indexed');
  conn.close();

  rmSync(ws, { recursive: true, force: true });
}

// Invalid-baseline CONTENT RECONCILE (bug B). A git worktree that gets rebased/amended
// then gc'd loses the stored baseline sha (git diff last..HEAD fails). The old code
// escalated to a whole-PROJECT teardown+rebuild on EVERY such cycle — a massive needless
// rebuild that fired even when a message-only `git commit --amend` never touched a file.
// The fix reconciles the ONE affected repo by on-disk content (mtime+size vs what was
// indexed, schema v2): reindex only files that actually differ, prune vanished ones,
// restamp the repo, and LEAVE the rest of the graph intact. Falls back to a full rebuild
// only when the store can't support a content comparison (safety over cleverness).
// Uses real git repos + the real refresh.mjs auto path end-to-end.
async function invalidBaselineReconcileTest() {
  const S = await import('../scripts/lib/state.mjs');
  const GIT = await import('../scripts/lib/git.mjs');
  const B = await import('../src/build.js');
  const gitCommit = async (dir, files, msg = 'init') => {
    await execFileP('git', ['-C', dir, 'init', '-q']);
    await execFileP('git', ['-C', dir, 'config', 'user.email', 't@t']);
    await execFileP('git', ['-C', dir, 'config', 'user.name', 't']);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    await execFileP('git', ['-C', dir, 'add', '-A']);
    await execFileP('git', ['-C', dir, 'commit', '-q', '-m', msg]);
  };
  // Orphan a repo's baseline: rewrite HEAD then gc away the old (now unreachable) commit,
  // so its stored sha no longer names a reachable revision — the exact bug trigger.
  const orphanHead = async (dir) => {
    await execFileP('git', ['-C', dir, 'reflog', 'expire', '--expire=now', '--all']);
    await execFileP('git', ['-C', dir, 'gc', '--prune=now', '-q']);
  };
  const symCount = (dbPath) => { const db = connect(dbPath, { readonly: true }); const n = db.prepare('SELECT COUNT(*) c FROM symbols').get().c; db.close(); return n; };
  const runRefresh = (proj, args = []) => execFileP('node', [REFRESH, ...args], { env: { ...process.env, CLAUDE_PROJECT_DIR: proj } });
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-invbase-')));

  // ---- Case 1: message-only amend + gc → CONTENT NO-OP, no full rebuild --------
  // The working tree never changed, so every file's mtime+size still matches what was
  // indexed → zero files reindexed, zero symbols disturbed, and NO whole-project rebuild.
  const p1 = realpathSync(mkdtempSync(join(ws, 'noop-')));
  await gitCommit(p1, { 'a.js': 'export function alpha(){ return 1; }\n' });
  await runRefresh(p1, ['--full']);
  const db1 = join(p1, '.wiregraph', 'graph.db');
  const st1 = S.readState(p1);
  const fullBefore1 = st1.lastFullBuild;
  const symsBefore1 = symCount(db1);
  // Rewrite ONLY the commit message (never a working-tree file) and gc, so the baseline
  // sha is orphaned but every file's mtime+size is untouched. A new message guarantees a
  // fresh sha regardless of timing (--no-edit can reproduce the same sha within one second).
  await execFileP('git', ['-C', p1, 'commit', '--amend', '-m', 'amended: message only', '-q']);
  await orphanHead(p1);
  // changedSince now flags the invalid baseline WITHOUT a whole-project escalation.
  const cInv = GIT.changedSince(p1, st1.reposLastSha);
  ok(cInv.fullBuildNeeded === false && cInv.invalidBaselineRepos.length === 1 && cInv.invalidBaselineRepos[0].root === p1,
    'inv-base noop: amend+gc surfaces the repo in invalidBaselineRepos with no whole-project fullBuildNeeded');
  await runRefresh(p1);
  const log1 = readFileSync(S.refreshLogPath(p1), 'utf8');
  has(log1, 'content no-op', 'inv-base noop: refresh logs a content no-op after the invalid baseline');
  const st1b = S.readState(p1);
  eq(st1b.lastFullBuild, fullBefore1, 'inv-base noop: NO full rebuild ran (lastFullBuild unchanged)');
  eq(symCount(db1), symsBefore1, 'inv-base noop: the graph symbols are undisturbed (nothing reindexed)');
  eq(st1b.reposLastSha[p1], GIT.headSha(p1), 'inv-base noop: the repo sha was restamped to the new HEAD');
  await runRefresh(p1);
  has(readFileSync(S.refreshLogPath(p1), 'utf8').trim().split('\n').pop(), 'nothing changed',
    'inv-base noop: the restamp sticks — the next refresh is a plain no-op (not a re-escalation)');

  // ---- Case 2: content DID change under an invalid baseline; only the changed file
  //      is reindexed, an unrelated SUB-REPO (its own compartment) stays intact, and
  //      NO whole-project reset runs -----------------------------------------------
  const home = realpathSync(mkdtempSync(join(ws, 'home-')));
  await gitCommit(home, { 'h.js': 'export function homeFn(){ return 1; }\n' });
  const nested = join(home, 'nested');
  mkdirSync(nested, { recursive: true });
  await gitCommit(nested, { 'n.js': 'export function nestedFn(){ return 2; }\n' });
  await runRefresh(home, ['--full']); // indexes home + the nested sub-repo; stamps BOTH baselines
  const dbH = join(home, '.wiregraph', 'graph.db');
  const st2 = S.readState(home);
  ok(st2.reposLastSha[home] && st2.reposLastSha[nested], 'inv-base changed: baselines stamped for both the home repo and its nested sub-repo');
  { const db = connect(dbH, { readonly: true }); has(Q.findSymbol(db, home, 'nestedFn'), 'n.js', 'inv-base changed: the nested sub-repo symbol is indexed'); db.close(); }

  // Change home's OWN file, then AMEND its baseline commit (rewriting history) and gc —
  // so home's stored baseline sha is orphaned while the working tree carries the new
  // code. (A plain commit keeps the baseline reachable as an ancestor; only a rewrite
  // orphans it — the actual bug trigger, a rebase/amend the dev repeats often.) The
  // nested sub-repo is left completely untouched, so its baseline stays valid.
  writeFileSync(join(home, 'h.js'), 'export function homeFn(){ return 1; }\nexport function addedFn(){ return 9; }\n');
  await execFileP('git', ['-C', home, 'commit', '--amend', '--no-edit', '-a', '-q']);
  await orphanHead(home);
  const cChg = GIT.changedSince(home, st2.reposLastSha);
  ok(cChg.invalidBaselineRepos.some((r) => r.root === home) && !cChg.invalidBaselineRepos.some((r) => r.root === nested),
    'inv-base changed: ONLY the home repo has an invalid baseline; the nested sub-repo stays valid');
  const fullBefore2 = st2.lastFullBuild;
  await runRefresh(home);
  const log2 = readFileSync(S.refreshLogPath(home), 'utf8');
  has(log2, 'by content (1 file', 'inv-base changed: exactly the one changed file was reconciled by content');
  ok(!/escalated to full rebuild/.test(log2.trim().split('\n').slice(-3).join('\n')), 'inv-base changed: no whole-project escalation was logged for this reconcile');
  const st2b = S.readState(home);
  eq(st2b.lastFullBuild, fullBefore2, 'inv-base changed: NO whole-project rebuild ran (lastFullBuild unchanged)');
  const dbAfter = connect(dbH, { readonly: true });
  has(Q.findSymbol(dbAfter, home, 'addedFn'), 'h.js', 'inv-base changed: the newly-committed symbol was reindexed');
  has(Q.findSymbol(dbAfter, home, 'nestedFn'), 'n.js', 'inv-base changed: the unrelated nested sub-repo is left intact');
  has(Q.findSymbol(dbAfter, home, 'homeFn'), 'h.js', 'inv-base changed: the surviving same-file symbol is kept');
  dbAfter.close();
  eq(st2b.reposLastSha[home], GIT.headSha(home), 'inv-base changed: home restamped to its new HEAD');
  eq(st2b.reposLastSha[nested], st2.reposLastSha[nested], 'inv-base changed: the untouched nested sub-repo keeps its baseline');

  // ---- Case 3: a VANISHED file is pruned on reconcile --------------------------
  const p3 = realpathSync(mkdtempSync(join(ws, 'vanish-')));
  await gitCommit(p3, { 'keep.js': 'export function keeper(){ return 1; }\n', 'gone.js': 'export function goner(){ return 2; }\n' });
  await runRefresh(p3, ['--full']);
  const db3 = join(p3, '.wiregraph', 'graph.db');
  { const db = connect(db3, { readonly: true }); has(Q.findSymbol(db, p3, 'goner'), 'gone.js', 'inv-base vanish: goner is indexed before removal'); db.close(); }
  const fullBefore3 = S.readState(p3).lastFullBuild;
  await execFileP('git', ['-C', p3, 'rm', '-q', 'gone.js']);
  await execFileP('git', ['-C', p3, 'commit', '--amend', '--no-edit', '-q']); // rewrite the baseline commit to drop gone.js
  await orphanHead(p3);
  await runRefresh(p3);
  eq(S.readState(p3).lastFullBuild, fullBefore3, 'inv-base vanish: reconcile did not full-rebuild');
  const db3after = connect(db3, { readonly: true });
  has(Q.findSymbol(db3after, p3, 'goner'), 'No symbol named "goner"', 'inv-base vanish: the vanished file\'s symbol was pruned');
  has(Q.findSymbol(db3after, p3, 'keeper'), 'keep.js', 'inv-base vanish: the surviving file is untouched');
  db3after.close();

  // ---- Case 4: no usable content stamp → FALL BACK to a full rebuild -----------
  // If the store lacks mtime/size for the repo's files, a content comparison can't be
  // trusted, so the reconcile must refuse and preserve correctness via a full rebuild.
  const p4 = realpathSync(mkdtempSync(join(ws, 'fallback-')));
  await gitCommit(p4, { 'a.js': 'export function fa(){ return 1; }\n' });
  await runRefresh(p4, ['--full']);
  const db4 = join(p4, '.wiregraph', 'graph.db');
  // Wipe the recorded stamps to simulate a pre-v2 / unstamped db.
  { const db = connect(db4); db.prepare('UPDATE files SET mtime = NULL, size = NULL').run(); db.close(); }
  const recNo = B.reconcileRepoByContent(p4, p4);
  ok(recNo.ok === false, 'inv-base fallback: reconcileRepoByContent refuses (ok:false) when no file carries a usable mtime/size');
  const fullBefore4 = S.readState(p4).lastFullBuild;
  await execFileP('git', ['-C', p4, 'commit', '--amend', '-m', 'amended: orphan the baseline', '-q']); // message-only rewrite → fresh sha
  await orphanHead(p4);
  await runRefresh(p4);
  const log4 = readFileSync(S.refreshLogPath(p4), 'utf8');
  has(log4, 'no content comparison', 'inv-base fallback: refresh logs the full-rebuild fallback reason');
  ok(S.readState(p4).lastFullBuild !== fullBefore4, 'inv-base fallback: a full rebuild actually ran (lastFullBuild advanced)');

  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// LINK FEATURE — END-TO-END (§9, edge-app ↔ log-server). The whole thesis in one
// test: two code-disconnected repos joined only by an HTTP wire. edge-app (a
// terminal repo) HTTP-uploads to the literal route /api/logs; log-server (a server
// repo) defines that route. `link` is driven from edge-app. We assert both graphs
// rebuild over the union, trace_contract returns the seam with the producer
// (edge-app) and consumer (log-server) sides, path_between crosses the seam through
// the contract node, get_source on a log-server symbol read from edge-app's own db
// resolves log-server's REAL external path — then `unlink` tears it all down: seam
// gone from both graphs, member rows purged, and the auto-created log-server peer
// offered for cleanup.
async function e2eLinkSeamTest() {
  const L = await import('../scripts/lib/links.mjs');
  const S = await import('../scripts/lib/state.mjs');
  const ws = mkdtempSync(join(tmpdir(), 'cg-e2e-'));
  // Named repos so compartment ids are exactly 'edge-app' / 'log-server' (root basename).
  const EDGE = join(ws, 'edge-app');
  const SERVER = join(ws, 'log-server');
  cpSync(FIXTURE_EDGE, EDGE, { recursive: true });
  cpSync(FIXTURE_SERVER, SERVER, { recursive: true });
  mkdirSync(join(EDGE, '.git'), { recursive: true });
  mkdirSync(join(SERVER, '.git'), { recursive: true });
  const edge = realpathSync(EDGE), server = realpathSync(SERVER);

  // /wiregraph-init on edge-app only; log-server has no .wiregraph yet (auto-init target).
  await initGraph(edge);
  ok(!existsSync(join(server, '.wiregraph', 'state.json')), 'e2e: log-server starts un-indexed (link will auto-create it)');

  // ---- link, driven from edge-app ---------------------------------------------
  await L.doLink(edge, server);

  // Both graphs rebuilt over the union: each db holds BOTH compartments.
  const edgeComps = compNamesOf(edge, edge), serverComps = compNamesOf(server, server);
  ok(edgeComps.includes('edge-app') && edgeComps.includes('log-server'), `e2e: edge-app db holds both compartments (got ${edgeComps.join(', ')})`);
  ok(serverComps.includes('edge-app') && serverComps.includes('log-server'), `e2e: log-server db holds both compartments (got ${serverComps.join(', ')})`);

  const conn = connect(join(edge, '.wiregraph', 'graph.db'), { readonly: true });

  // ---- trace_contract returns the seam with producer + consumer sides ---------
  const tc = Q.traceContract(conn, edge, 'inferred', undefined, false);
  has(tc, '/api/logs', 'e2e: trace_contract names the /api/logs wire token');
  has(tc, '[edge-app]', 'e2e: trace_contract shows the producer side (edge-app) referencing the contract');
  has(tc, '[log-server]', 'e2e: trace_contract shows the consumer side (log-server) referencing the contract');

  // Directional WIRE edge oriented producer(edge-app, the caller/out) -> consumer
  // (log-server, the definer/in) — producers:[edge-app], consumers:[log-server].
  const wire = conn.prepare(
    `SELECT sp.compartment src, dp.compartment dst FROM edges e
       JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
      WHERE e.project=? AND e.type='WIRE'`).all(edge);
  ok(wire.some((w) => w.src === 'edge-app' && w.dst === 'log-server'),
    `e2e: WIRE oriented producer(edge-app) -> consumer(log-server) (got ${wire.map((w) => w.src + '->' + w.dst).join(', ') || 'none'})`);

  // ---- path_between crosses the seam (through the shared contract node) --------
  const path = Q.pathBetween(conn, edge, 'uploadLogs', 'registerRoutes');
  has(path, 'edge-app:uploader.js', 'e2e: path_between starts on the edge-app producer symbol');
  has(path, 'log-server:routes.js', 'e2e: path_between reaches the log-server consumer symbol');
  has(path, 'REFERENCES', 'e2e: the crossing hop is a REFERENCES edge through the contract seam');

  // ---- get_source on a log-server symbol, read from edge-app's OWN db ----------
  // Resolves the file via compartments.root to log-server's real external path and
  // returns ITS body — the exact resolution a silent basename collision corrupts.
  const src = Q.getSource(conn, edge, 'registerRoutes');
  has(src, 'log-server:routes.js', 'e2e: get_source attributes the symbol to the log-server compartment/file');
  has(src, "app.post('/api/logs'", "e2e: get_source reads log-server's real external file body");
  conn.close();

  // ---- unlink: tear it all down ----------------------------------------------
  const r = await L.doUnlink(edge, server);
  eq(r.cleanupEligible, true, 'e2e: the auto-created log-server peer is offered for cleanup');
  eq(S.readState(edge).links.length, 0, 'e2e: edge-app member record removed on unlink');
  eq(S.readState(server).links.length, 0, 'e2e: log-server mirror record removed on unlink');

  const afterComps = compNamesOf(edge, edge);
  ok(!afterComps.includes('log-server'), 'e2e: log-server compartment purged from the edge-app db');
  ok(afterComps.includes('edge-app'), 'e2e: edge-app own compartment survives the unlink rebuild');
  eq(edgeCount(edge, edge, 'WIRE'), 0, 'e2e: the cross-repo WIRE seam is gone after unlink');
  const after = connect(join(edge, '.wiregraph', 'graph.db'), { readonly: true });
  const gone = Q.traceContract(after, edge, 'inferred', undefined, false);
  after.close();
  ok(/No contract matches/.test(gone) || !gone.includes('[log-server]'), 'e2e: trace_contract no longer reports the log-server seam');

  rmSync(ws, { recursive: true, force: true });
}

// Contracts-dir discovery: detectContractsDirs must find (a) the root ITSELF when
// its basename looks like a contracts dir or it holds top-level *.asyncapi specs,
// (b) ALL matching child dirs (not just the first), (c) a symlink-to-dir, and
// (d) case-insensitively. Regression for the "standalone *-contracts repo / second
// contracts dir / symlinked dir silently skipped" family (M3 + m1 + m2 + n1).
async function contractDiscoveryTest() {
  const { detectContractsDirs } = await import('../src/build.js');
  const ws = mkdtempSync(join(tmpdir(), 'cg-disco-'));

  // (a1) a root whose basename is `*-contracts` is its own home (no children needed).
  const repo = join(ws, 'payments-contracts');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'pay.asyncapi.yaml'), 'asyncapi: 3.0.0\ninfo: { title: Pay, version: 1.0.0 }\nchannels: {}\n');
  ok(detectContractsDirs(repo).includes(repo), 'discovery: a *-contracts basename root is its own contracts home');

  // (a2) a root with a non-matching name but a top-level *.asyncapi.yml still counts.
  const svc = join(ws, 'billing-svc');
  mkdirSync(svc, { recursive: true });
  writeFileSync(join(svc, 'bill.asyncapi.yml'), 'asyncapi: 3.0.0\ninfo: { title: Bill, version: 1.0.0 }\nchannels: {}\n');
  ok(detectContractsDirs(svc).includes(svc), 'discovery: a root holding top-level *.asyncapi.yml is its own home');

  // (b) a root with BOTH contracts/ and api-contracts/ children loads both, deterministically.
  const multi = join(ws, 'multi');
  const cA = join(multi, 'contracts'), cB = join(multi, 'api-contracts');
  mkdirSync(cA, { recursive: true }); mkdirSync(cB, { recursive: true });
  const multiDirs = detectContractsDirs(multi);
  ok(multiDirs.includes(cA) && multiDirs.includes(cB), `discovery: BOTH contracts/ and api-contracts/ children found (got ${multiDirs.join(', ') || 'none'})`);

  // (c) a symlink child pointing at a real contracts dir is followed.
  const symHost = join(ws, 'symhost');
  mkdirSync(symHost, { recursive: true });
  const realCon = join(ws, 'real-contracts-target');
  mkdirSync(realCon, { recursive: true });
  symlinkSync(realCon, join(symHost, 'contracts'));
  ok(detectContractsDirs(symHost).includes(join(symHost, 'contracts')), 'discovery: a symlinked contracts dir is followed');

  // (d) case-insensitive child name matching.
  const ci = join(ws, 'ci');
  const ciChild = join(ci, 'AsyncAPI');
  mkdirSync(ciChild, { recursive: true });
  ok(detectContractsDirs(ci).includes(ciChild), 'discovery: child dir matched case-insensitively (AsyncAPI)');

  rmSync(ws, { recursive: true, force: true });
}

// M3 (end-to-end) — a standalone contracts repo whose spec sits at its TOP LEVEL
// (no contracts/ subdir) must not only be DISCOVERED (contractDiscoveryTest) but
// actually LIGHT THE SEAM: indexed as its own root, detectContractsDirs's root-self
// branch adds it, loadAllContracts reads the top-level spec, and matchContracts mints
// cross-repo REFERENCES from BOTH the producer and the consumer. Before the fix a
// top-level-spec / *-contracts repo was silently skipped, so the seam never formed.
async function topLevelSpecSeamTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-toplevel-'));
  const client = realpathSync(mkdtempSync(join(work, 'client-')));
  const server = realpathSync(mkdtempSync(join(work, 'server-')));
  // A standalone contracts repo: basename ends in -contracts AND its spec is a
  // top-level file (no contracts/ subdir) — the two ways detectContractsDirs's
  // root-self branch fires.
  const specRepo = realpathSync(mkdtempSync(join(work, 'pay-contracts-')));
  mkdirSync(join(client, '.git'), { recursive: true });
  mkdirSync(join(server, '.git'), { recursive: true });
  mkdirSync(join(specRepo, '.git'), { recursive: true });
  writeFileSync(join(client, 'up.js'), "async function pay(){ await fetch('/api/pay', { method: 'POST', body }); }\n");
  writeFileSync(join(server, 'routes.js'), "function routes(app){ app.post('/api/pay', handle); }\n");
  writeFileSync(join(specRepo, 'pay.asyncapi.yaml'),
    'asyncapi: 3.0.0\n' +
    'info: { title: Pay, version: 1.0.0 }\n' +
    'channels:\n' +
    '  pay:\n' +
    '    address: /api/pay\n' +
    '    messages:\n' +
    '      m: { payload: { type: object, properties: {} } }\n' +
    'operations:\n' +
    '  r: { action: receive, channel: { $ref: "#/channels/pay" }, messages: [{ $ref: "#/channels/pay/messages/m" }] }\n');

  // Index all three as roots under one project tag — the standalone contracts repo
  // is its OWN root, so detectContractsDirs adds it via the root-self branch.
  const project = client;
  const db = join(work, 'graph.db');
  await runBuild({ target: project, project, db, reset: true, roots: [client, server, specRepo] });

  const conn = connect(db, { readonly: true });
  const repos = new Set(
    conn.prepare("SELECT DISTINCT s.compartment repo FROM edges e JOIN symbols s ON s.id=e.src WHERE e.project=? AND e.type='REFERENCES'")
      .all(project).map((r) => r.repo));
  ok(repos.has(basenameOf(client)) && repos.has(basenameOf(server)),
    `toplevel-seam: a top-level-spec *-contracts repo lights the cross-repo seam (REFERENCES from ${[...repos].join(', ') || 'none'})`);
  conn.close();
  rmSync(work, { recursive: true, force: true });
}

// SPEC_NAME collision: a hand-applied spec and the link-inferred spec that share
// info.title 'wiregraph-inferred' collapse to ONE contractId. Node dedup and
// buildWireEdges' cById must UNION their channels/wireRoles so a hand-authored
// channel the scanner couldn't infer keeps its WIRE edge (M2 + n3). Before the fix,
// cById was last-wins (inferred), dropping the hand channel's roles -> no WIRE.
async function contractCollisionMergeTest() {
  const { loadAllContracts, buildWireEdges } = await import('../src/extract/contracts.js');
  const work = mkdtempSync(join(tmpdir(), 'cg-collide-'));
  const cdir = join(work, 'contracts');
  mkdirSync(cdir, { recursive: true });
  // Both specs share info.title 'wiregraph-inferred' => same contractId. HAND spec
  // defines /hand/x with explicit producer/consumer roles; INFERRED spec defines
  // /inf/y. Each channel carries its own x-wiregraph-* roles (P produces, Q consumes).
  const spec = (title, addr) =>
    `asyncapi: 3.0.0\ninfo: { title: ${title}, version: 1.0.0 }\nchannels:\n` +
    `  ch:\n    address: ${addr}\n    x-wiregraph-producers: [P]\n    x-wiregraph-consumers: [Q]\n` +
    `    messages: { m: { payload: { type: object, properties: {} } } }\n` +
    `operations:\n  r: { action: receive, channel: { $ref: "#/channels/ch" }, messages: [{ $ref: "#/channels/ch/messages/m" }] }\n`;
  writeFileSync(join(cdir, 'hand.asyncapi.yaml'), spec('wiregraph-inferred', '/hand/xyz'));
  writeFileSync(join(cdir, 'wiregraph-inferred.asyncapi.yaml'), spec('wiregraph-inferred', '/inf/abc'));

  const g = new Graph('p');
  const merged = loadAllContracts(g, [cdir]);
  eq(merged.length, 1, 'collision: two same-title specs merge into ONE contract');
  eq(g.contracts.size, 1, 'collision: exactly one Contract node minted for the shared id');
  const cnode = [...g.contracts.values()][0];
  const nodeTokens = new Set((cnode.tokenMeta || []).map((t) => t.token));
  ok(nodeTokens.has('/hand/xyz') && nodeTokens.has('/inf/abc'),
    `collision: node tokenMeta unions both channels (got ${[...nodeTokens].join(', ') || 'none'})`);

  // Two compartments referencing BOTH tokens; expect a WIRE edge per token.
  g.addSymbol({ id: 'P:a.js:pf:1', compartment: 'P', file: 'a.js', name: 'pf', kind: 'function', startLine: 1 });
  g.addSymbol({ id: 'Q:b.js:qf:1', compartment: 'Q', file: 'b.js', name: 'qf', kind: 'function', startLine: 1 });
  const cid = merged[0].id;
  for (const tok of ['/hand/xyz', '/inf/abc']) {
    for (const s of ['P:a.js:pf:1', 'Q:b.js:qf:1']) g.addEdge('REFERENCES', s, cid, { token: tok });
  }
  // Pass RAW same-id duplicates (as the per-file load produced them) so this guards
  // buildWireEdges' OWN cById merge — a last-wins cById would drop the hand channel.
  const rawHand = { id: cid, name: 'wiregraph-inferred', tokens: ['/hand/xyz'], direction: {}, wireRoles: new Map([['/hand/xyz', { producers: new Set(['P']), consumers: new Set(['Q']) }]]) };
  const rawInf = { id: cid, name: 'wiregraph-inferred', tokens: ['/inf/abc'], direction: {}, wireRoles: new Map([['/inf/abc', { producers: new Set(['P']), consumers: new Set(['Q']) }]]) };
  buildWireEdges(g, [rawInf, rawHand]);
  const wireTokens = new Set(g.edges.filter((e) => e.type === 'WIRE').map((e) => e.props.token));
  ok(wireTokens.has('/hand/xyz'), `collision: hand-authored channel keeps its WIRE edge (got ${[...wireTokens].join(', ') || 'none'})`);
  ok(wireTokens.has('/inf/abc'), 'collision: inferred channel keeps its WIRE edge');

  rmSync(work, { recursive: true, force: true });
}

// L19 — synthesizeAsyncApi channel-key collision. channelKey collapses every
// non-alphanumeric run to a single '-', so two DISTINCT same-kind tokens differing
// only by separators (message device:heartbeat vs device.heartbeat) both hash to
// 'message-device-heartbeat'. clusterSeams keeps them as SEPARATE seams (it groups on
// the raw normalized token, which never merges .:/-). Under the old unconditional
// channels[key]=... the second seam OVERWROTE the first — dropping its address, its
// x-wiregraph-* roles, and every edge it would have produced (only one channel
// survived). The fix suffixes collisions (-2, -3, …) so each seam keeps its own
// channel + operation. Seams are hand-built here in the exact shape synthesizeAsyncApi
// consumes ({kind, token, compartments, inCompartments, outCompartments, labels}),
// deterministically ordered as clusterSeams would return them.
async function channelKeyCollisionTest() {
  const I = await import('../src/contracts/infer.js');
  const YAML = (await import('yaml')).default;
  const seams = [
    { kind: 'message', token: 'device.heartbeat', compartments: ['app', 'worker'], inCompartments: ['worker'], outCompartments: ['app'], labels: [] },
    { kind: 'message', token: 'device:heartbeat', compartments: ['app', 'worker'], inCompartments: ['worker'], outCompartments: ['app'], labels: [] },
  ];
  const doc = YAML.parse(I.synthesizeAsyncApi(seams));

  // 1. BOTH seams survive — two channels, not one (old behavior kept exactly one).
  const chKeys = Object.keys(doc.channels);
  eq(chKeys.length, 2, `L19: colliding seams keep separate channels (got ${chKeys.length}: ${chKeys.join(', ')})`);

  // 2. Both original tokens appear as channel addresses (neither was overwritten).
  const addrs = new Set(chKeys.map((k) => doc.channels[k].address));
  ok(addrs.has('device.heartbeat') && addrs.has('device:heartbeat'),
    `L19: both original addresses preserved (got ${[...addrs].join(', ') || 'none'})`);

  // 3. Keys are distinct: first seam keeps the base key, the collider gets '-2'.
  ok(chKeys.includes('message-device-heartbeat'), 'L19: first seam keeps the base channel key');
  ok(chKeys.includes('message-device-heartbeat-2'), 'L19: colliding seam gets a numeric suffix');

  // Each channel carries its OWN operation and its own producer/consumer roles.
  for (const k of chKeys) {
    ok(doc.operations[`receive-${k}`], `L19: channel ${k} has its own receive operation`);
    eq(doc.channels[k]['x-wiregraph-producers'].join(','), 'app', `L19: ${k} keeps its producers`);
    eq(doc.channels[k]['x-wiregraph-consumers'].join(','), 'worker', `L19: ${k} keeps its consumers`);
  }
}

// S1 — template-literal client route inference. The canonical JS/TS client form
// `fetch(`/orders/${orderId}/items`)` must (A) normalize its `${orderId}` param to
// `{orderId}` in toAsyncApiPath, and (B) cluster with a server route on the SAME
// pattern but a different param name (`/orders/:id/items`) into ONE cross-compartment
// seam — because clusterSeams canonicalizes param NAMES in the grouping key only.
// Before this fix `${orderId}` fell through toAsyncApiPath verbatim AND the param name
// was part of the group key, so the client `out` and server `in` never met: the
// inference->build round-trip was dead for the most idiomatic client route.
async function templateLiteralSeamTest() {
  const I = await import('../src/contracts/infer.js');

  // (A) toAsyncApiPath normalizes `${name}` params, whole-segment and intra-segment,
  // while keeping the existing `:id`/`{id}`/`<id>` forms and leaving a non-path topic
  // (no `${...}`) untouched apart from the wire leading slash it always adds.
  eq(I.toAsyncApiPath('/orders/${orderId}/items'), '/orders/{orderId}/items',
    'S1: toAsyncApiPath normalizes a whole-segment template-literal param');
  eq(I.toAsyncApiPath('/files/${name}.json'), '/files/{name}.json',
    'S1: toAsyncApiPath normalizes an intra-segment template-literal param');
  eq(I.toAsyncApiPath('/orders/:id/items'), '/orders/{id}/items',
    'S1: toAsyncApiPath still normalizes the classic :id form');
  eq(I.toAsyncApiPath('order.created'), '/order.created',
    'S1: toAsyncApiPath leaves a non-param token unchanged (no `{}` introduced)');

  // (B) clustering: a CLIENT wire `out` on `/orders/${orderId}/items` and a SERVER
  // wire `in` on `/orders/:id/items` — same endpoint pattern, different param names,
  // different compartments — must cluster into exactly ONE seam spanning both. Two
  // genuinely different routes (`/orders/:id` vs `/users/:id`) must stay separate.
  const candidates = [
    { kind: 'wire', token: '/orders/${orderId}/items', role: 'out', label: 'get', compartment: 'mobile-app', file: 'client.js', line: 1 },
    { kind: 'wire', token: '/orders/:id/items', role: 'in', label: 'get', compartment: 'svc-api', file: 'server.js', line: 1 },
    { kind: 'wire', token: '/orders/:id', role: 'in', label: 'get', compartment: 'svc-api', file: 'server.js', line: 2 },
    { kind: 'wire', token: '/users/:id', role: 'in', label: 'get', compartment: 'svc-api', file: 'server.js', line: 3 },
  ];
  const seams = I.clusterSeams(candidates);
  const itemsSeam = seams.filter((s) => s.token.includes('/items'));
  eq(itemsSeam.length, 1,
    `S1: client ${'`${orderId}`'} + server :id cluster into exactly one /items seam (got ${itemsSeam.map((s) => s.token).join(', ') || 'none'})`);
  const seam = itemsSeam[0];
  eq(seam.compartments.join(','), 'mobile-app,svc-api', 'S1: the seam spans both compartments');
  eq(seam.inCompartments.join(','), 'svc-api', 'S1: server compartment learned as in');
  eq(seam.outCompartments.join(','), 'mobile-app', 'S1: client compartment learned as out');
  ok(/^\/orders\/\{[A-Za-z0-9_]+\}\/items$/.test(seam.token),
    `S1: seam address keeps a readable {param} form (got ${seam.token})`);
  // The two param-only siblings on distinct static segments must NOT wrongly merge:
  // `/orders/{id}` and `/users/{id}` collapse to `/orders/{}` and `/users/{}` — different
  // keys — so each stays its own (single-compartment => dropped) group, never one seam.
  const bareOrders = seams.filter((s) => /^\/orders\/\{[^/]*\}$/.test(s.token));
  const bareUsers = seams.filter((s) => /^\/users\/\{[^/]*\}$/.test(s.token));
  ok(bareOrders.length + bareUsers.length === 0,
    'S1: single-compartment /orders/{id} and /users/{id} did not wrongly merge into a seam');

  // (C) round-trip proof without a full build: synthesizeAsyncApi emits the seam as a
  // channel whose address the name-agnostic H2 pathTokenRegex matches against BOTH the
  // client `${orderId}` source form AND the server `:id` source form — so buildWireEdges
  // WOULD mint REFERENCES on both sides and a WIRE seam from this inferred spec.
  const YAML = (await import('yaml')).default;
  const { pathTokenRegex } = await import('../src/extract/contracts.js');
  const doc = YAML.parse(I.synthesizeAsyncApi(seams));
  const addr = Object.values(doc.channels).map((c) => c.address).find((a) => String(a).includes('/items'));
  ok(addr, `S1: synthesized spec carries the /items channel address (got ${addr || 'none'})`);
  const re = pathTokenRegex(addr);
  ok(re.test('/orders/${orderId}/items'), 'S1: inferred channel matches the client template-literal source form');
  ok(re.test('/orders/:id/items'), 'S1: inferred channel matches the server :id source form');
}

// M1 — incremental parity: a body-only edit to a producer, routed through the
// INCREMENTAL path (files:, the same path the MCP self-heal uses), must re-mint its
// REFERENCES to the link-INFERRED contract. pruneFile drops the edited symbol's
// REFERENCES; before the fix, incremental loaded contracts from this root's own dir
// only (never the .wiregraph/inferred/ dir a full build unions in), so the pruned
// seam was never re-matched and silently vanished until a full rebuild.
async function incrementalContractRematchTest() {
  const L = await import('../scripts/lib/links.mjs');
  const { ws, client, server } = linkFixture('cg-increm-');
  await initGraph(client);
  await L.doLink(client, server); // mints the inferred /api/logs seam both sides

  const upRefs = () => {
    const c = connect(join(client, '.wiregraph', 'graph.db'), { readonly: true });
    try {
      return c.prepare(
        `SELECT count(*) n FROM edges e JOIN symbols s ON s.id=e.src
           WHERE e.project=? AND e.type='REFERENCES' AND s.file='up.js'`).get(client).n;
    } finally { c.close(); }
  };
  ok(upRefs() >= 1, 'increm: producer up.js REFERENCES the inferred contract after link');

  // Body-only edit — the /api/logs route literal is UNCHANGED, only the body differs.
  writeFileSync(join(client, 'up.js'), "async function up(){ await fetch('/api/logs', { method: 'POST', body: { n: 42 } }); }\n");
  await runBuild({ target: client, project: client, files: [join(client, 'up.js')] });

  ok(upRefs() >= 1, `increm: producer REFERENCES to the inferred contract re-minted after a body-only incremental edit (seam NOT dropped; got ${upRefs()})`);
  rmSync(ws, { recursive: true, force: true });
}

// Change 1 — incremental WIRE self-heal. pruneFile still deletes the derived WIRE seam
// touching an edited/surviving symbol (a stale seam with no live backing), but the
// incremental path now RE-DERIVES the whole project's WIRE set from the db's fresh
// REFERENCES — so the seam is as fresh as a full rebuild's, WITHOUT a source re-parse.
// Covers: (1a) parity with a from-scratch full rebuild after a producer edit; (1b) an
// unrelated edit leaves the seam intact; (1c) deleting the producer leaves NO dangling
// WIRE; (1d) two identical incremental passes yield the same WIRE set.
async function incrementalWireRederiveTest() {
  const L = await import('../scripts/lib/links.mjs');
  const { ws, client, server } = linkFixture('cg-rederive-');
  await initGraph(client);
  await L.doLink(client, server); // full build mints the inferred /api/logs seam + WIRE
  ok(edgeCount(client, client, 'WIRE') >= 1, 'rederive: WIRE seam present after link (full build)');

  // (1a) DERIVE PARITY: a body-only edit to the PRODUCER, routed through the incremental
  // path, leaves the seam's WIRE present and EQUAL to a from-scratch full rebuild's set.
  writeFileSync(join(client, 'up.js'), "async function up(){ await fetch('/api/logs', { method: 'POST', body: { n: 1 } }); }\n");
  await runBuild({ target: client, project: client, files: [join(client, 'up.js')] });
  const wInc = wireSet(client, client);
  ok(wInc.size >= 1, `rederive(1a): WIRE seam PRESENT after an incremental producer edit (self-healed, got ${wInc.size})`);
  ok(edgeCount(client, client, 'REFERENCES') >= 1, 'rederive(1a): REFERENCES seam also survives the edit');
  // From-scratch full rebuild of the SAME post-edit code, into a SEPARATE db, then diff.
  const fdb = join(ws, 'fromscratch.db');
  await runBuild({ target: client, project: client, db: fdb, reset: true, roots: [client, server] });
  const cf = connect(fdb, { readonly: true });
  const wFull = new Set(cf.prepare("SELECT src, dst, token FROM edges WHERE project=? AND type='WIRE'").all(client).map((r) => `${r.src}|${r.dst}|${r.token}`));
  cf.close();
  ok(wFull.size >= 1 && setEq(wInc, wFull),
    `rederive(1a): incremental WIRE set EQUALS a from-scratch full rebuild's (inc ${[...wInc].join(' , ') || 'none'} | full ${[...wFull].join(' , ') || 'none'})`);

  // (1d) IDEMPOTENCY: re-running the same incremental edit yields the same WIRE set.
  await runBuild({ target: client, project: client, files: [join(client, 'up.js')] });
  const wInc2 = wireSet(client, client);
  ok(setEq(wInc, wInc2), `rederive(1d): a second identical incremental pass gives the same WIRE set (got ${[...wInc2].join(' , ') || 'none'})`);

  // (1b) UNRELATED EDIT: a new file with NO contract references must not destroy the seam.
  writeFileSync(join(client, 'other.js'), 'function noop(){ return 1; }\n');
  await runBuild({ target: client, project: client, files: [join(client, 'other.js')] });
  ok(setEq(wireSet(client, client), wInc), 'rederive(1b): editing an unrelated file leaves the WIRE seam intact');

  // (1c) DELETE PRODUCER: removing up.js leaves NO dangling WIRE (its half of the seam
  // is gone, so the token is one-sided and yields no edge).
  rmSync(join(client, 'up.js'), { force: true });
  await runBuild({ target: client, project: client, files: [join(client, 'up.js')] });
  eq(edgeCount(client, client, 'WIRE'), 0, 'rederive(1c): deleting the producer leaves no dangling WIRE');
  const c = connect(join(client, '.wiregraph', 'graph.db'), { readonly: true });
  const symIds = new Set(c.prepare('SELECT id FROM symbols WHERE project=?').all(client).map((r) => r.id));
  const dangling = c.prepare("SELECT src, dst FROM edges WHERE project=? AND type='WIRE'").all(client).filter((r) => !symIds.has(r.src) || !symIds.has(r.dst));
  c.close();
  eq(dangling.length, 0, 'rederive(1c): no WIRE edge references a vanished symbol');

  rmSync(ws, { recursive: true, force: true });
}

// Change 2 — seamStaleSinceInference. Incremental re-matches the EXISTING inferred spec
// but never regenerates it, so a route added/removed in a contract-bearing compartment
// is invisible to the seams until a full rebuild re-infers. The flag makes that honest:
// (2a) set ONLY by an incremental that BOTH changes the symbol name-set AND touches a
// contract-referencing compartment — a pure body edit never sets it, a full rebuild
// clears it. (2b) the flag graph_status/trace_contract branch on is present when set.
async function seamStaleSinceInferenceTest() {
  const S = await import('../scripts/lib/state.mjs');
  const L = await import('../scripts/lib/links.mjs');
  const { ws, client, server } = linkFixture('cg-seamstale-');
  await initGraph(client);
  await L.doLink(client, server); // full build → seam inferred + flag cleared
  eq(!!S.readState(client)?.seamStaleSinceInference, false, 'seam-stale: cleared after the link full build');

  // (2a-body) pure body edit — route literal + symbol name UNCHANGED → no structural
  // drift → flag must NOT be set (never nag on a body edit).
  writeFileSync(join(client, 'up.js'), "async function up(){ await fetch('/api/logs', { method: 'POST', body: { n: 7 } }); }\n");
  await runBuild({ target: client, project: client, files: [join(client, 'up.js')] });
  eq(!!S.readState(client)?.seamStaleSinceInference, false, 'seam-stale: NOT set by a pure body edit in a contract compartment');

  // (2a-rename) rename the producer symbol (name-set change) in the contract-referencing
  // compartment → structural drift + contract-relevant → flag SET. This is the "a route
  // may have changed" signal (the inferred spec was not regenerated).
  writeFileSync(join(client, 'up.js'), "async function upload(){ await fetch('/api/logs', { method: 'POST', body: { n: 7 } }); }\n");
  await runBuild({ target: client, project: client, files: [join(client, 'up.js')] });
  eq(S.readState(client)?.seamStaleSinceInference, true, 'seam-stale: SET after a name-set change in a contract-referencing compartment');

  // (2b) graph_status SURFACES it: the handler appends statusAdvisories(state) after
  // its freshness line, so drive that exact shared helper over the real on-disk state
  // and assert the seam-stale note is rendered (server.js can't be imported — it opens
  // a stdio transport at module load, so we test the pure fn its handler delegates to).
  const staleNotes = S.statusAdvisories(S.readState(client));
  ok(staleNotes.includes(S.SEAM_STALE_NOTE), 'seam-stale(2b): graph_status surfaces the seam-stale note while the flag is set');

  // full rebuild re-infers/re-matches → flag cleared, and graph_status stops surfacing it.
  await runBuild({ target: client, project: client, reset: true });
  eq(!!S.readState(client)?.seamStaleSinceInference, false, 'seam-stale: cleared by a full rebuild');
  ok(!S.statusAdvisories(S.readState(client)).includes(S.SEAM_STALE_NOTE), 'seam-stale(2b): graph_status no longer surfaces the note once the flag is cleared');
  rmSync(ws, { recursive: true, force: true });
}

// M4 — unlink converges on re-run. A crash injected mid-unlink (between the two
// rebuilds, before ANY record is retracted) must leave BOTH link records intact so a
// plain re-run is NOT a notLinked no-op, and the re-run tears the seam down in both
// graphs. Before the fix, doUnlink removed both records BEFORE rebuilding; a rebuild
// crash then left a stale seam AND vanished records, so a re-run early-returned
// notLinked — a silent, unrecoverable no-op. Drives the REAL doUnlink via its
// afterSelfRebuild test hook, mirroring linkAutoCreatedCrashTest.
async function unlinkConvergenceTest() {
  const L = await import('../scripts/lib/links.mjs');
  const S = await import('../scripts/lib/state.mjs');
  const { ws, client, server } = linkFixture('cg-unlinkconv-');
  await initGraph(client);
  await L.doLink(client, server); // auto-creates server, mints the seam both sides
  ok(edgeCount(client, client, 'WIRE') >= 1, 'unlink-conv: seam present before unlink');

  let crashed = false;
  try {
    await L.doUnlink(client, server, { afterSelfRebuild: () => { throw new Error('simulated crash'); } });
  } catch { crashed = true; }
  ok(crashed, 'unlink-conv: the injected mid-unlink crash fired');

  // Records intact — retraction happens only AFTER both rebuilds, so neither side lost
  // its record to the crash.
  ok(S.findLink(client, server), 'unlink-conv: client record still present after the crash (no premature removal)');
  ok(S.findLink(server, client), 'unlink-conv: server mirror still present after the crash');

  // A plain re-run converges: no notLinked no-op, records gone both sides, seam gone.
  const r = await L.doUnlink(client, server);
  ok(!r.notLinked, 'unlink-conv: the re-run is NOT a notLinked no-op');
  eq(S.readState(client).links.length, 0, 'unlink-conv: client record removed on re-run');
  eq(S.readState(server).links.length, 0, 'unlink-conv: server mirror removed on re-run');
  eq(edgeCount(client, client, 'WIRE'), 0, 'unlink-conv: no stale WIRE seam survives in the client db');
  eq(edgeCount(server, server, 'WIRE'), 0, 'unlink-conv: no stale WIRE seam survives in the server db');
  ok(!compNamesOf(client, client).includes(basenameOf(server)), 'unlink-conv: server compartment purged from the client db');
  rmSync(ws, { recursive: true, force: true });
}

// Global aggregation: /wiregraph-stats reads the REGISTRY (no fs scan), aggregates
// read-only across projects, sorts by savings, and prunes dead roots lazily.
async function globalStatsTests() {
  const M = await import('../scripts/lib/metrics.mjs');
  const S = await import('../scripts/lib/state.mjs');
  const use = (t, saved) => ({ t, sessionId: 's', kind: 'use', tool: 'get_source', savedTokens: saved, fileTokens: saved + 100, returnedTokens: 100 });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cg-global-home-')));
  const savedReg = process.env.WIREGRAPH_REGISTRY;
  process.env.WIREGRAPH_REGISTRY = join(home, 'registry.json'); // isolated from the suite's
  try {
    const mkProj = (name, reads, savedEach) => {
      const proj = join(home, name);
      const p = M.metricsPath(proj);
      mkdirSync(dirname(p), { recursive: true });
      const ev = [];
      for (let i = 0; i < reads; i++) ev.push(use(i, savedEach));
      writeFileSync(p, ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
      return proj;
    };
    const a = mkProj('alpha', 3, 1000); // 3000 saved
    const b = mkProj('beta', 2, 500);   // 1000 saved
    const dead = join(home, 'ghost');   // registered but never created on disk
    writeFileSync(S.registryPath(), JSON.stringify([a, b, dead, a], null, 2)); // dup + dead

    const roots = M.globalRoots();
    eq(roots.length, 2, 'global: dead + duplicate roots dropped, 2 live roots remain');
    ok(!S.readRegistry().includes(dead), 'global: dead root pruned from the registry on read');

    const { perProject, total } = await M.summarizeAll(roots);
    eq(perProject.length, 2, 'global: two projects with activity');
    eq(perProject[0].name, 'alpha', 'global: biggest saver (alpha) sorts first');
    eq(total.savedTokens, 4000, 'global: total saved = 3000 + 1000');
    eq(total.getSourceCalls, 5, 'global: total calls = 3 + 2');

    // Aggregation is READ-ONLY: a pre-v2 project (log, no state) is NOT migrated/archived.
    const c = mkProj('gamma', 1, 100);
    await M.summarizeAll([c]);
    ok(!existsSync(join(c, '.wiregraph', 'metrics.v1.jsonl')), 'global: aggregation never migrates/archives a project');

    const rep = M.formatGlobalReport({ perProject, total }, {});
    has(rep, 'global impact', 'global: report titled "global impact"');
    has(rep, 'alpha', 'global: per-project breakdown lists projects');
  } finally {
    if (savedReg === undefined) delete process.env.WIREGRAPH_REGISTRY; else process.env.WIREGRAPH_REGISTRY = savedReg;
    rmSync(home, { recursive: true, force: true });
  }
}

// Regression: a "fatal" link-preview stop (missing target, self not indexed, self-
// link) must PRINT its reason — not exit 2 with no output (the bug that made a bare
// `preview IM30` look dead until re-run with 2>&1 and an absolute path).
async function linkPreviewFatalTest() {
  const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-lprev-')));
  mkdirSync(join(proj, '.wiregraph'), { recursive: true });
  writeFileSync(join(proj, '.wiregraph', 'state.json'), JSON.stringify({ project: proj, links: [] }));
  const LINKS = join(HERE, '..', 'scripts', 'lib', 'links.mjs');
  let out = '';
  try {
    ({ stdout: out } = await execFileP('node', [LINKS, 'preview', 'definitely-not-here'], { cwd: proj }));
  } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; } // exit 2 rejects execFile — keep its output
  ok(out.trim().length > 0, 'link-preview: a fatal stop is NOT silent (prints a reason)');
  has(out, 'does not exist', 'link-preview: names the missing target in the rejection');
  rmSync(proj, { recursive: true, force: true });
}

// Rename safety: a project whose stored state.project points at a dead (renamed/moved)
// path must self-heal own-root to the real directory on read — otherwise a full build
// walks nothing and wipes the graph to 0 (the codegraph→wiregraph rename footgun).
async function staleProjectHealTest() {
  const S = await import('../scripts/lib/state.mjs');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cg-rename-')));
  mkdirSync(join(dir, '.wiregraph'), { recursive: true });
  const deadPath = join(tmpdir(), 'cg-OLD-NAME-does-not-exist');
  writeFileSync(join(dir, '.wiregraph', 'state.json'),
    JSON.stringify({ project: deadPath, indexedRoots: [deadPath], links: [] }));

  const st = S.readState(dir);
  eq(st.project, dir, 'rename-heal: readState rebinds project to the actual directory');
  const roots = S.memberRoots(dir);
  ok(roots.includes(dir), 'rename-heal: own root is the live dir, not the dead stored path');
  ok(!roots.includes(deadPath), 'rename-heal: the dead path is dropped from the union');

  // End-to-end: a full build over the "renamed" project indexes its files (was 0 pre-fix).
  writeFileSync(join(dir, 'package.json'), '{"name":"renamed"}');
  writeFileSync(join(dir, 'x.js'), 'export function hello(){ return 1; }\n');
  const { runBuild } = await import('../src/build.js');
  await runBuild({ target: dir, project: dir, reset: true });
  const { connect } = await import('../src/store/sqlite.js');
  const db = connect(join(dir, '.wiregraph', 'graph.db'), { readonly: true });
  const n = db.prepare('SELECT count(*) n FROM symbols').get().n;
  db.close();
  ok(n > 0, `rename-heal: full build indexes the renamed project (got ${n} symbols, 0 pre-fix)`);
  rmSync(dir, { recursive: true, force: true });
}

// Rename must not leave a GHOST compartment. Rebuilding a moved project — whose db still
// holds rows tagged with the OLD path — must clear the whole db, not just the new path,
// or symbols/edges double. (Found by the two-repo e2e adversarial pass.)
async function renameGhostCompartmentTest() {
  const { runBuild } = await import('../src/build.js');
  const { connect } = await import('../src/store/sqlite.js');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cg-ghost-')));
  const a = join(base, 'proj-a');
  mkdirSync(a);
  writeFileSync(join(a, 'package.json'), '{"name":"proj","type":"module"}');
  writeFileSync(join(a, 'x.js'), 'export function hi(){ return lo(); }\nexport function lo(){ return 1; }\n');
  await runBuild({ target: a, project: a, reset: true });
  renameSync(a, join(base, 'proj-b')); // move the dir (its db + old-path rows move with it)
  const b = join(base, 'proj-b');
  await runBuild({ target: b, project: b, reset: true });
  const db = connect(join(b, '.wiregraph', 'graph.db'), { readonly: true });
  const comps = db.prepare('SELECT count(*) n FROM compartments').get().n;
  const projs = db.prepare('SELECT count(DISTINCT project) n FROM symbols').get().n;
  const dupes = db.prepare('SELECT count(*) n FROM (SELECT name, file, compartment FROM symbols GROUP BY name, file, compartment HAVING count(*) > 1)').get().n;
  db.close();
  eq(comps, 1, 'rename-ghost: one compartment after rebuild (no ghost of the old path)');
  eq(projs, 1, 'rename-ghost: all symbols tagged with a single project');
  eq(dupes, 0, 'rename-ghost: no duplicated symbols');
  rmSync(base, { recursive: true, force: true });
}

// Former-links tombstone: record (dedup, self-excluded), read, and clear — the memory
// that lets /wiregraph-init offer to re-establish links a prior remove/unlink tore down.
async function formerLinksTombstoneTest() {
  const S = await import('../scripts/lib/state.mjs');
  const saved = process.env.WIREGRAPH_LINKS_HISTORY;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cg-tomb-')));
  const a = join(dir, 'a'), b = join(dir, 'b'), c = join(dir, 'c');
  for (const d of [a, b, c]) mkdirSync(d);
  process.env.WIREGRAPH_LINKS_HISTORY = join(dir, 'hist.json');
  try {
    S.recordFormerLinks(a, [a, b, c]); // self (a) must be excluded
    const list = S.formerLinks(a);
    eq(list.length, 2, 'tombstone: records the peers, excludes self');
    ok(!list.includes(a), 'tombstone: never records the graph as its own peer');
    S.recordFormerLinks(a, [b]); // re-record an existing peer
    eq(S.formerLinks(a).length, 2, 'tombstone: re-recording an existing peer dedups');
    S.forgetFormerLinks(a);
    eq(S.formerLinks(a).length, 0, 'tombstone: forget clears the entry');
  } finally {
    if (saved === undefined) delete process.env.WIREGRAPH_LINKS_HISTORY; else process.env.WIREGRAPH_LINKS_HISTORY = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

// find_symbol truncation (L17/L18): symbolMatches is capped at 100 rows before the
// header is built, so the header MUST report the TRUE total (not the capped count) and
// flag the truncation — otherwise an agent trusts "100 match(es)" as complete and stops
// narrowing. Build a real project with >100 same-named defs (the header count is the
// bug's whole surface), plus a small name to lock the non-truncated header exactly.
async function findSymbolTruncationTest() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-findsym-cap-')));
  const project = join(work, 'proj');
  mkdirSync(project);
  const db = join(project, '.wiregraph', 'graph.db');
  writeFileSync(join(project, 'package.json'), '{"name":"proj","type":"module"}');
  // 150 files each defining dupName → 150 matches (> the 100 cap).
  for (let i = 0; i < 150; i++) writeFileSync(join(project, `f${i}.js`), 'export function dupName(){}\n');
  // 3 files defining triName → an exact 3-match header, below the cap.
  for (let i = 0; i < 3; i++) writeFileSync(join(project, `t${i}.js`), 'export function triName(){}\n');
  await runBuild({ target: project, project, db, reset: true });
  const conn = connect(db, { readonly: true });

  const trunc = String(Q.findSymbol(conn, project, 'dupName'));
  // TRUE total, not the capped 100 (the old code printed "100 match(es)" here).
  has(trunc, '150 match(es)', 'find_symbol reports the true total when matches exceed the cap');
  has(trunc, 'showing first 100', 'find_symbol flags truncation when matches exceed the cap');
  const listed = trunc.split('\n').filter((ln) => ln.startsWith('  ')).length;
  eq(listed, 100, 'find_symbol lists exactly the capped 100 result lines when truncated');

  const small = String(Q.findSymbol(conn, project, 'triName'));
  has(small, '3 match(es) for "triName":', 'find_symbol header is the exact count below the cap');
  ok(!small.includes('showing first'), 'find_symbol omits the truncation note below the cap');
  conn.close();
  rmSync(work, { recursive: true, force: true });
}

// Legacy-codegraph cleanup (L23/L24/L25): a project initialized before the
// codegraph→wiregraph rename must uninstall cleanly — the legacy CLAUDE.md block and
// the .codegraph/ .gitignore entry — WITHOUT rewriting the user's unrelated whitespace.
async function legacyCleanupTests() {
  const CM = await import('../scripts/lib/claudemd.mjs');
  const RM = await import('../scripts/remove.mjs');

  // --- L23: legacy-only CLAUDE.md block is seen by the removal gate --------
  const legacyBlock = '<!-- BEGIN codegraph (managed) -->\n## codegraph directive body\n<!-- END codegraph -->';
  const legacyCm = `# My project\n\nSome user prose here.\n\n${legacyBlock}\n\nMore user prose after.\n`;
  ok(CM.presentAny(legacyCm), 'L23: presentAny sees a legacy-only codegraph block (removal gate fires)');
  ok(!CM.present(legacyCm), 'L23: present (new-sentinel only) misses the legacy block — the gap the fix closes');
  const strippedCm = CM.withoutBlock(legacyCm);
  ok(!strippedCm.includes('BEGIN codegraph'), 'L23: withoutBlock removes the legacy block');
  ok(!strippedCm.includes('codegraph directive body'), 'L23: withoutBlock removes the legacy block body');
  has(strippedCm, 'Some user prose here.', 'L23: withoutBlock preserves user prose before the block');
  has(strippedCm, 'More user prose after.', 'L23: withoutBlock preserves user prose after the block');

  // Current-block content still gates and strips as before.
  const curCm = `# Proj\n\n${CM.block()}\n\ntail\n`;
  ok(CM.presentAny(curCm), 'L23: presentAny sees a current wiregraph block too');
  ok(CM.present(curCm), 'L23: present still true for a current block (apply/diff wording unchanged)');
  ok(!CM.presentAny('# just prose\n'), 'L23: presentAny false when no block is present');

  // --- L24: legacy .codegraph/ .gitignore entry (+ its comment) is dropped --
  const legacyGi = 'node_modules/\ndist/\n\n# wiregraph (managed) — the graph db lives here\n.codegraph/\n\n*.log\n';
  const strippedGi = RM.stripGitignore(legacyGi);
  ok(!strippedGi.includes('.codegraph/'), 'L24: stripGitignore drops the legacy .codegraph/ line');
  ok(!strippedGi.includes('# wiregraph'), 'L24: stripGitignore drops the legacy entry comment');
  has(strippedGi, 'node_modules/', 'L24: stripGitignore keeps unrelated entries (node_modules/)');
  has(strippedGi, 'dist/', 'L24: stripGitignore keeps unrelated entries (dist/)');
  has(strippedGi, '*.log', 'L24: stripGitignore keeps unrelated entries (*.log)');

  // The current .wiregraph/ case still works.
  const curGi = 'src/\n\n# wiregraph (managed)\n.wiregraph/\n\nbuild/\n';
  const strippedCurGi = RM.stripGitignore(curGi);
  ok(!strippedCurGi.includes('.wiregraph/'), 'L24: stripGitignore still drops the current .wiregraph/ line');
  ok(!strippedCurGi.includes('# wiregraph'), 'L24: stripGitignore still drops the current entry comment');
  has(strippedCurGi, 'src/', 'L24: stripGitignore keeps unrelated entries around the current line');
  has(strippedCurGi, 'build/', 'L24: stripGitignore keeps unrelated entries after the current line');

  // --- L25: seam-only whitespace normalization -----------------------------
  // An intentional triple-blank run ELSEWHERE in the file must survive.
  const farApart = `head line\n\n\n\nintentional triple-blank section above\n\n${CM.block()}\n\ntail\n`;
  const strippedFar = CM.withoutBlock(farApart);
  has(strippedFar, 'head line\n\n\n\nintentional triple-blank section above', 'L25: unrelated triple-blank run is preserved (not collapsed)');
  ok(!strippedFar.includes(BEGIN_MARK(CM)), 'L25: the block itself is removed');

  // Block in the middle → exactly one blank line at the seam.
  const mid = `before\n\n${CM.block()}\n\nafter\n`;
  eq(CM.withoutBlock(mid), 'before\n\nafter\n', 'L25: block in the middle leaves exactly one blank line at the seam');

  // Block at file start → no leading blank line.
  const atStart = `${CM.block()}\n\nafter\n`;
  eq(CM.withoutBlock(atStart), 'after\n', 'L25: block at file start leaves no leading blank line');

  // Block at file end → a single trailing newline.
  const atEnd = `before\n\n${CM.block()}\n`;
  eq(CM.withoutBlock(atEnd), 'before\n', 'L25: block at file end keeps a single trailing newline');

  // stripGitignore preserves an unrelated multi-blank run after stripping an entry.
  const giBlanks = 'a/\n\n\n\nb/\n\n# wiregraph (managed)\n.wiregraph/\n';
  const strippedGiBlanks = RM.stripGitignore(giBlanks);
  has(strippedGiBlanks, 'a/\n\n\n\nb/', 'L25: stripGitignore preserves an unrelated multi-blank run');
  ok(!strippedGiBlanks.includes('.wiregraph/'), 'L25: stripGitignore still removed the entry');
}

// Small helper so the L25 assertion above doesn't hard-code the sentinel string.
function BEGIN_MARK(CM) { return CM.block().split('\n')[0]; }

// GEXF export (parallel to exportHtmlTests). Two things must hold: the file is
// well-formed GEXF whose node count matches the exporter's kept-symbol set, and —
// mirroring the export-html XSS tests — every string that lands in the XML is run
// through the xml() escaper so a hostile symbol/token/contract name can't break out
// of a tag or attribute. We inject a symbol + WIRE edge carrying XML-hostile chars
// (a literal </node>, &, ", <script>) straight into the db and prove the CLI escapes
// them. --all mode is used so every symbol + CALLS + WIRE lands in the output.
async function exportGexfTests() {
  const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-gexf-')));
  cpSync(FIXTURE, join(proj, 'repo'), { recursive: true });
  mkdirSync(join(proj, 'repo', '.git'), { recursive: true });
  const db = join(proj, '.wiregraph', 'graph.db');
  await runBuild({ target: proj, project: proj, db, reset: true });
  const EXPORT = join(HERE, '..', 'src', 'export-gexf.js');
  const out = join(proj, 'graph.gexf');

  // --- well-formed GEXF + node/edge counts --------------------------------
  await execFileP('node', [EXPORT, '--all', '--project', proj, '--db', db, out]);
  const gexf = readFileSync(out, 'utf8');
  has(gexf, '<?xml version="1.0"', 'export-gexf: emits an XML prolog');
  has(gexf, '<gexf xmlns="http://gexf.net/1.3"', 'export-gexf: root <gexf> element with namespace');
  has(gexf, 'defaultedgetype="directed"', 'export-gexf: the graph is directed');
  has(gexf, '<nodes>', 'export-gexf: opens a <nodes> section');
  has(gexf, '</nodes>', 'export-gexf: closes the <nodes> section');
  has(gexf, '<edges>', 'export-gexf: opens an <edges> section');
  has(gexf, '</edges>', 'export-gexf: closes the <edges> section');
  has(gexf, '</gexf>', 'export-gexf: closes the root element');

  // The <node> count must equal the exporter's kept-symbol set. We mirror its own
  // isTest predicate so a regression on either side (dropped nodes, leaked test
  // symbols) is caught, not just "some XML came out".
  const conn = connect(db, { readonly: true });
  const isTestF = (f) => !!f && (f.includes('tests/') || f.includes('/test/') || f.includes('.test.') || f.includes('_test.') || f.includes('/test_'));
  const expectedNodes = conn.prepare('SELECT file FROM symbols WHERE project=?').all(proj).filter((r) => !isTestF(r.file)).length;
  conn.close();
  ok(expectedNodes > 0, `export-gexf: the fixture produced symbols to export (got ${expectedNodes})`);
  eq((gexf.match(/<node /g) || []).length, expectedNodes, 'export-gexf: exactly one <node> per kept symbol');
  ok((gexf.match(/<edge /g) || []).length > 0, 'export-gexf: the fixture CALLS edges are emitted as <edge> elements');
  has(gexf, 'id="e0"', 'export-gexf: edges carry sequential ids');

  // --- escaping: hostile name / attrs / edge tokens must be XML-escaped ----
  const evil = '</node> & "q" <script>x</script>';
  const w = connect(db, {});
  w.prepare('INSERT INTO symbols (id,project,compartment,file,name,kind,lang,startLine,endLine) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('EVIL', proj, 'c<&>', 'e<v>.js', evil, 'function', 'js', 1, 2);
  w.prepare('INSERT INTO edges (type,src,dst,project,token,cnt,resolution,evidence,direction,contract) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('WIRE', 'EVIL', 'EVIL', proj, evil, 1, null, null, evil, evil);
  w.close();
  await execFileP('node', [EXPORT, '--all', '--project', proj, '--db', db, out]);
  const hostile = readFileSync(out, 'utf8');
  has(hostile, 'id="EVIL"', 'export-gexf: the injected hostile symbol is exported');
  has(hostile, '&lt;/node&gt;', 'export-gexf: a </node> in a name is escaped so it cannot close the node early');
  has(hostile, '&amp;', 'export-gexf: a bare & is escaped to &amp;');
  has(hostile, '&quot;', 'export-gexf: a double-quote is escaped to &quot; so it cannot break an attribute');
  ok(!hostile.includes('</node> &'), 'export-gexf: the raw </node> breakout sequence from the name is absent');
  ok(!hostile.includes('<script>'), 'export-gexf: no unescaped <script> tag leaks into the XML');
  rmSync(proj, { recursive: true, force: true });
}

// contracts.mjs CLI (scan / apply). Drive the real script over a scratch two-repo
// workspace with a genuine cross-repo wire seam (svc-api defines /api/register, the
// mobile-app calls it). scan must report the seam and write NOTHING; apply must write
// the draft AsyncAPI spec into a fresh contracts/ home; a re-apply over a hand-edited
// draft must back the old one up before overwriting (the never-silently-clobber rule).
async function contractsCliTests() {
  const CONTRACTS = join(HERE, '..', 'scripts', 'contracts.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-contracts-cli-')));
  cpSync(join(FIXTURE_CONTRACTS, 'svc-api'), join(work, 'svc-api'), { recursive: true });
  cpSync(join(FIXTURE_CONTRACTS, 'mobile-app'), join(work, 'mobile-app'), { recursive: true });
  mkdirSync(join(work, 'svc-api', '.git'), { recursive: true });   // distinct git repos => cross-repo seam
  mkdirSync(join(work, 'mobile-app', '.git'), { recursive: true });
  const specPath = join(work, 'contracts', 'wiregraph-inferred.asyncapi.yaml');

  // --- scan: report the seam, print a draft, write nothing ----------------
  const scan = await execFileP('node', [CONTRACTS, 'scan', work]);
  has(scan.stdout, '/api/register', 'contracts-cli scan: reports the cross-repo seam token');
  has(scan.stdout, 'NOT written', 'contracts-cli scan: labels the proposed contract as unwritten');
  has(scan.stdout, 'address: /api/register', 'contracts-cli scan: prints the draft channel address');
  ok(!existsSync(specPath), 'contracts-cli scan: is a dry run — no spec file written');

  // --- apply: write the draft into a fresh contracts/ home ----------------
  const apply = await execFileP('node', [CONTRACTS, 'apply', work]);
  has(apply.stdout, 'Wrote', 'contracts-cli apply: reports it wrote the channel(s)');
  ok(existsSync(specPath), 'contracts-cli apply: writes contracts/wiregraph-inferred.asyncapi.yaml');
  const spec = readFileSync(specPath, 'utf8');
  has(spec, 'asyncapi:', 'contracts-cli apply: the written file is an AsyncAPI spec');
  has(spec, 'address: /api/register', 'contracts-cli apply: the spec carries the inferred channel address');

  // --- re-apply over a hand-edited draft backs the old one up -------------
  writeFileSync(specPath, spec + '\n# hand edit\n');
  const reapply = await execFileP('node', [CONTRACTS, 'apply', work]);
  has(reapply.stdout, 'backed it up', 'contracts-cli apply: a differing existing draft is backed up, not silently clobbered');
  const backupDir = join(work, '.wiregraph', 'contract-backups');
  ok(existsSync(backupDir) && readdirSync(backupDir).some((f) => f.endsWith('.bak')), 'contracts-cli apply: the prior draft is preserved as a timestamped .bak under .wiregraph/');
  ok(!readFileSync(specPath, 'utf8').includes('# hand edit'), 'contracts-cli apply: the spec is regenerated (the hand edit is overwritten after backup)');

  rmSync(work, { recursive: true, force: true });
}

// workspace.mjs `repos` scope classifier (drives the init scope guidance). The three
// classes: MULTI (>=2 compartments — cross-compartment contracts possible), SINGLE
// (one compartment / lone git repo), NO-GIT (a manifest-less non-git folder indexed
// as one unit). Each is asserted through the CLI's `scope:` line.
async function workspaceScopeTests() {
  const WS = join(HERE, '..', 'scripts', 'lib', 'workspace.mjs');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cg-wspace-')));

  // (a) MULTI — a parent holding two separate git repos = two compartments.
  const multi = join(base, 'multi');
  mkdirSync(join(multi, 'alpha', '.git'), { recursive: true });
  mkdirSync(join(multi, 'beta', '.git'), { recursive: true });
  writeFileSync(join(multi, 'alpha', 'a.js'), 'export function a(){ return 1; }\n');
  writeFileSync(join(multi, 'beta', 'b.js'), 'export function b(){ return 2; }\n');
  const mOut = (await execFileP('node', [WS, 'repos', multi])).stdout;
  has(mOut, 'scope: MULTI (compartments=2)', 'workspace: two git repos under a parent classify as MULTI with 2 compartments');
  has(mOut, 'alpha', 'workspace: the MULTI listing names the alpha compartment');
  has(mOut, 'beta', 'workspace: the MULTI listing names the beta compartment');

  // (b) SINGLE — one git repo is its own lone compartment.
  const single = join(base, 'single');
  mkdirSync(join(single, '.git'), { recursive: true });
  writeFileSync(join(single, 's.js'), 'export function s(){ return 3; }\n');
  const sOut = (await execFileP('node', [WS, 'repos', single])).stdout;
  has(sOut, 'scope: SINGLE (compartments=1)', 'workspace: a lone git repo classifies as SINGLE');
  has(sOut, 'Target is itself a git repo: yes', 'workspace: the SINGLE target is reported as a git repo');

  // (c) NO-GIT — a plain source folder with neither .git nor a module manifest.
  const plain = join(base, 'plain');
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, 'p.js'), 'export function p(){ return 4; }\n');
  const pOut = (await execFileP('node', [WS, 'repos', plain])).stdout;
  has(pOut, 'scope: NO-GIT (compartments=0)', 'workspace: a non-git, manifest-less folder classifies as NO-GIT');
  has(pOut, 'Compartments found: 0', 'workspace: NO-GIT reports zero compartments');

  rmSync(base, { recursive: true, force: true });
}

// Isolate the global-project registry: builds during the suite would otherwise
// register temp /tmp projects into the real ~/.wiregraph-projects.json. Point it at a
// throwaway file for the whole run (cleaned up before exit).
process.env.WIREGRAPH_REGISTRY = join(tmpdir(), `cg-test-registry-${process.pid}.json`);
// Likewise the former-links tombstone: doUnlink records into it, so isolate it too.
process.env.WIREGRAPH_LINKS_HISTORY = join(tmpdir(), `cg-test-links-history-${process.pid}.json`);

console.log('wiregraph regression test');
await fixtureTests();
await fullBuildIdempotencyTest();
await pythonTests();
await jvmLangTests('java', FIXTURE_JAVA, 'App.java');
await jvmLangTests('kotlin', FIXTURE_KOTLIN, 'App.kt');
await freshnessTests();
await concurrencyTest();
await ensureFreshTests();
lockStealDecisionTest();
await rebuildDurabilityTest();
await incrementalDurabilityTest();
await metricsTests();
await measuredRecurringTests();
await sessionFilterTests();
await hookAppendTests();
await metricsMigrationTests();
await globalStatsTests();
await resolutionTests();
await contractsTests();
await contractDriftTest();
await wordBoundaryAttributionTest();
await paramRouteMatchTest();
await prefixNestingMatchTest();
await roleAwareDriftTest();
await pathTokenMatchUnitTest();
await messagingTest();
await stateTest();
await tsEnvStateTest();
await atomicStateTest();
await potentialTest();
await importsTest();
await exportHtmlTests();
await exportContractEdgesTest();
await exportHtmlEscapingTest();
await schemaGuardTest();
await structuralDriftTest();
await distinctivenessTest();
await monorepoCompartmentTest();
await wireCrossCompartmentOnlyTest();
await contractDiscoveryTest();
await topLevelSpecSeamTest();
await contractCollisionMergeTest();
await channelKeyCollisionTest();
await templateLiteralSeamTest();
await gitReposTest();
await linkStateTests();
await linkGuardTests();
await previewLinkShapeTest();
await walkSourcesTests();
await nestedWorktreeTests();
await inferAcrossTest();
await idIndependenceTest();
await unionBuildTest();
await linkMutualAutoInitTest();
await unlinkPurgeCleanupTest();
await fanOutAttributionTest();
await reindexRegressionTest();
await filesArgParseTest();
await commaPathReindexTest();
await findIndexedRootInvarianceTest();
await linkAtomicityTest();
await linkInitiatorPreservedTest();
await linkAutoCreatedCrashTest();
await resetEntryPointsTest();
await memberFreshnessTest();
await catchUpEscalationTest();
await invalidBaselineReconcileTest();
await graphStatsGroupingTest();
await e2eLinkSeamTest();
await incrementalContractRematchTest();
await incrementalWireRederiveTest();
await seamStaleSinceInferenceTest();
await unlinkConvergenceTest();
await linkPreviewFatalTest();
await staleProjectHealTest();
await renameGhostCompartmentTest();
await formerLinksTombstoneTest();
await findSymbolTruncationTest();
await legacyCleanupTests();
await exportGexfTests();
await contractsCliTests();
await workspaceScopeTests();
rmSync(process.env.WIREGRAPH_REGISTRY, { force: true }); // drop the throwaway registry
rmSync(process.env.WIREGRAPH_LINKS_HISTORY, { force: true }); // and the throwaway tombstone
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
