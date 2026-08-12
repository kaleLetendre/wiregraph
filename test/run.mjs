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
import { dirname, basename, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
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
const FIXTURE_RUST = join(HERE, 'fixture-rust');
const FIXTURE_CONTRACTS = join(HERE, 'fixture-contracts');
const FIXTURE_RESOURCE = join(HERE, 'fixture-resource');
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
  const { ensureFresh, __setTestHooks, __resetFresh, __getLastFreshAt, __getLastFreshError } = await import('../src/mcp/server.js');

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

    // ...and it is RECORDED, not swallowed. This was a bare `catch {}`, which made the
    // read path the most dangerous of the three incremental entry points: when
    // incrementalBuild REFUSES (the declared compartments moved since the last full
    // build), every read discarded the refusal and quietly served the pre-edit graph.
    // With posture `off` the SessionStart escalation that normally recovers never runs,
    // so the project stayed wedged and silently wrong with no signal anywhere.
    has(__getLastFreshError(), 'boom', 'ensureFresh: a failed self-heal is RECORDED so the read tools can surface it (not swallowed)');
    __setTestHooks({ staleNow: () => [], reindexFiles: async () => {} });
    __resetFresh();
    __setTestHooks({ staleNow: () => [], reindexFiles: async () => {} });
    await ensureFresh();
    eq(__getLastFreshError(), null, 'ensureFresh: the recorded failure clears once a refresh succeeds');
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

// Java, Kotlin and Rust share the same fixture shape as the Python one: run() reaches a
// cross-file class/impl method (handle), a same-file helper, and a constructor (Rust: the
// associated fn Service::new); handle calls util, so callees(run) reaches util
// transitively. One parametrized harness — a new language earns these six assertions by
// building a fixture of that shape, and nothing else.
async function langFixtureTests(label, fixtureDir, mainFile) {
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

// RUST — the parts langFixtureTests cannot express, asserted at the DATABASE level.
//
// Two of these are the whole reason the language was added, and BOTH produced literally
// nothing before it:
//   * `Cargo.toml` was already a MODULE_MANIFEST, so a crate directory was already a
//     compartment BOUNDARY — but a compartment only reaches the db as a side effect of
//     walking a PARSEABLE source file, so with no `.rs` in the EXT map a Rust project
//     indexed to zero compartments, zero files and zero symbols.
//   * a module-scope `const X: &str = "…/…"` vendored into two crates is the resource
//     seam Phase 1b's name+value join exists for, and Rust is the second language (after
//     Python) to reach it with NO import candidates at all.
//
// Every lookup is `?.`-guarded: an unguarded deref on a rule that stopped firing throws
// and aborts the suite instead of printing a FAIL.
async function rustTests() {
  const { parseSource } = await import('../src/extract/parse.js');
  const { langForFile } = await import('../src/extract/lang.js');
  const I = await import('../src/contracts/infer.js');

  // --- the EXT lookup, the gate everything else is behind --------------------
  eq(langForFile('src/main.rs')?.lang, 'rust', 'rust(ext): .rs maps to the rust grammar');
  eq(langForFile('build.rs')?.variant, 'rust', 'rust(ext): …with the rust variant');
  eq(langForFile('Cargo.toml'), null, 'rust(ext): Cargo.toml itself is a manifest, not a source file');

  // --- definition shapes -----------------------------------------------------
  const src = [
    'pub struct Service { n: i32 }',
    'pub enum Kind { A, B }',
    'pub trait Runner {',
    '    fn go(&self) -> i32;',
    '    fn twice(&self) -> i32 { self.go() * 2 }',
    '}',
    'pub mod inner { pub fn nested() -> i32 { 1 } }',
    'impl Service {',
    '    pub fn new() -> Self { Service { n: 0 } }',
    '    pub fn handle(&self, n: i32) -> i32 { util(n) }',
    '}',
    'impl Runner for Service { fn go(&self) -> i32 { self.handle(1) } }',
    'pub fn util(x: i32) -> i32 { x * 2 }',
  ].join('\n');
  let p;
  try { p = parseSource(src, 'rust', 'rust'); } catch (e) { p = { error: e.message }; }
  const syms = p?.symbols || [];
  const shown = syms.map((s) => `${s?.kind}:${s?.name}`).join(', ') || (p?.error || 'none');
  const kindOf = (n) => syms.find((s) => s?.name === n)?.kind;
  eq(kindOf('util'), 'function', `rust(def): a free fn is a function (got ${shown})`);
  eq(kindOf('nested'), 'function', `rust(def): a fn inside a \`mod\` body is still a FREE function, not a method (got ${shown})`);
  // The one the mutation test targets: a fn in an impl block's declaration_list.
  eq(kindOf('new'), 'method', `rust(def): an associated fn inside \`impl\` is a method (got ${shown})`);
  eq(kindOf('handle'), 'method', `rust(def): an inherent method inside \`impl\` is a method (got ${shown})`);
  eq(kindOf('go'), 'method', `rust(def): a TRAIT-impl method is a method too — same impl_item shape, extra \`trait:\` field (got ${shown})`);
  eq(kindOf('twice'), 'method', `rust(def): a trait's DEFAULT body is a method (got ${shown})`);
  eq(kindOf('Service'), 'class', `rust(def): a struct is the container kind 'class', as java's enum/record and kotlin's object are (got ${shown})`);
  eq(kindOf('Kind'), 'class', `rust(def): an enum likewise (got ${shown})`);
  eq(kindOf('Runner'), 'class', `rust(def): a trait likewise (got ${shown})`);
  eq(kindOf('inner'), 'class', `rust(def): a \`mod\` likewise — NOT kind 'module', which is reserved for the synthetic per-file symbol and filtered out of find_symbol (got ${shown})`);
  // A bodiless trait signature has nothing to get_source and the impls carry the code.
  ok(!syms.some((s) => s?.name === 'go' && s?.kind === 'function'),
    `rust(def): a trait's bodiless function_signature_item is not minted as a second symbol (got ${shown})`);

  // --- callee shapes ---------------------------------------------------------
  // Every shape reduces to the LAST path segment, which is the name resolveCalls indexes
  // definitions under (as tsCall does with a member property and cCall with a field).
  const callsOf = (s) => {
    try { return (parseSource(s, 'rust', 'rust')?.calls || []).map((c) => c?.name); }
    catch (e) { return [`<error ${e.message}>`]; }
  };
  const cs = callsOf([
    'fn run(n: i32) -> i32 {',
    '    let s = Service::new();',
    '    let t = svc::inner::make();',
    '    helper(n) + s.handle(n) + generic::<i32>(n) + t.len() as i32',
    '}',
  ].join('\n'));
  ok(cs.includes('helper'), `rust(call): a plain identifier callee (got ${cs.join(', ') || 'none'})`);
  ok(cs.includes('new'), `rust(call): Type::new() — a scoped_identifier resolves to its LAST segment (got ${cs.join(', ') || 'none'})`);
  ok(cs.includes('make'), `rust(call): module::path::fn() — a nested scoped_identifier likewise (got ${cs.join(', ') || 'none'})`);
  ok(cs.includes('handle'), `rust(call): x.method() — a field_expression resolves to its field (got ${cs.join(', ') || 'none'})`);
  ok(cs.includes('generic'), `rust(call): foo::<T>() — a generic_function unwraps to its function (got ${cs.join(', ') || 'none'})`);
  ok(!cs.includes('Service'), `rust(call): the scoped path's NAMESPACE is not itself a callee (got ${cs.join(', ') || 'none'})`);

  // --- env-var signal --------------------------------------------------------
  const tokens = (s) => {
    try { return (parseSource(s, 'rust', 'rust')?.candidates || []).filter((c) => c?.kind === 'state').map((c) => c?.token); }
    catch (e) { return [`<error ${e.message}>`]; }
  };
  ok(tokens('fn f() { let v = std::env::var("GAME_STATE_DIR"); }').includes('GAME_STATE_DIR'),
    'rust(sig): std::env::var("NAME") is a state candidate');
  ok(tokens('use std::env;\nfn f() { let v = env::var("GAME_STATE_DIR"); }').includes('GAME_STATE_DIR'),
    'rust(sig): the shortened env::var("NAME") too');
  ok(tokens('fn f() { let v = std::env::var_os("GAME_STATE_DIR"); }').includes('GAME_STATE_DIR'),
    'rust(sig): and the OsString variant');
  // The `env::` qualifier is required — a bare `var(…)` is far too common a name, and a
  // false state token mints a cross-compartment seam.
  eq(tokens('fn f() { let v = var("GAME_STATE_DIR"); }').length, 0,
    'rust(sig): an UNQUALIFIED var("NAME") is not treated as an env read');
  eq(tokens('fn f() { let v = std::env::var(name); }').length, 0,
    'rust(sig): a non-literal argument yields no token');

  // --- the graph a real crate layout produces --------------------------------
  const work = mkdtempSync(join(tmpdir(), 'cg-rust-'));
  const proj = join(work, 'ws');
  cpSync(FIXTURE_RUST, proj, { recursive: true });
  const project = realpathSync(proj);
  const dbPath = join(work, 'graph.db');
  await runBuild({ target: proj, project, db: dbPath, reset: true });
  const db = connect(dbPath, { readonly: true });

  // Cargo.toml compartments: BOTH exist as rows, with their files attributed to them.
  const comps = db.prepare('SELECT name FROM compartments WHERE project=? ORDER BY name').all(project).map((r) => r?.name);
  eq(JSON.stringify(comps), JSON.stringify(['crate-a', 'crate-b']),
    `rust(db): each Cargo.toml directory is its own compartment ROW (got ${JSON.stringify(comps)})`);
  const files = db.prepare('SELECT compartment, path, lang FROM files WHERE project=? ORDER BY compartment, path').all(project)
    .map((r) => `${r?.compartment}/${r?.path}:${r?.lang}`);
  eq(JSON.stringify(files), JSON.stringify([
    'crate-a/src/app.rs:rust', 'crate-a/src/svc.rs:rust', 'crate-b/src/store.rs:rust',
  ]), `rust(db): every .rs file is indexed, attributed to its own crate, tagged lang=rust (got ${JSON.stringify(files)})`);

  const dbSyms = db.prepare("SELECT compartment, file, name, kind FROM symbols WHERE project=? AND kind<>'module' ORDER BY name").all(project);
  const dbKind = (n) => dbSyms.find((s) => s?.name === n)?.kind;
  const symShown = dbSyms.map((s) => `${s?.kind}:${s?.name}`).join(', ') || 'none';
  eq(dbKind('run'), 'function', `rust(db): symbols reach the database, not just the extractor (got ${symShown})`);
  eq(dbKind('Service'), 'class', `rust(db): the struct is stored as a class (got ${symShown})`);
  eq(dbKind('handle'), 'method', `rust(db): the impl method is stored as a method (got ${symShown})`);
  eq(dbSyms.find((s) => s?.name === 'handle')?.file, 'src/svc.rs',
    'rust(db): …in the crate-relative path, not an absolute one');

  // CALLS edges, by NAME, across the three shapes run() uses.
  const edges = db.prepare(`SELECT a.name AS caller, b.name AS callee FROM edges e
      JOIN symbols a ON a.id=e.src AND a.project=e.project
      JOIN symbols b ON b.id=e.dst AND b.project=e.project
      WHERE e.project=? AND e.type='CALLS'`).all(project).map((r) => `${r?.caller}->${r?.callee}`);
  const edgeShown = edges.sort().join(', ') || 'none';
  ok(edges.includes('run->helper'), `rust(db/CALLS): identifier callee, same file (got ${edgeShown})`);
  ok(edges.includes('run->new'), `rust(db/CALLS): scoped_identifier callee Service::new(), CROSS-FILE (got ${edgeShown})`);
  ok(edges.includes('run->handle'), `rust(db/CALLS): field_expression callee s.handle(), cross-file method on an impl (got ${edgeShown})`);
  ok(edges.includes('handle->util'), `rust(db/CALLS): and the impl method's own call to a free fn (got ${edgeShown})`);
  // Resolution is compartment-scoped: crate-b's `connect` must never be reached from
  // crate-a by name, exactly as C and TS never resolve across compartments.
  ok(!edges.some((e) => e.endsWith('->connect')), `rust(db/CALLS): no cross-compartment name resolution (got ${edgeShown})`);
  db.close();

  // --- the vendored resource seam across two crates --------------------------
  const { candidates, comments } = I.extractSignals(proj);
  const rejected = [];
  const seams = I.clusterResourceSeams(candidates, proj, { comments, rejected }) || [];
  const seamShown = seams.map((s) => s?.token).join(', ') || 'none';
  const seam = seams.find((s) => s?.token === 'GAME_SOCK_PATH');
  eq(seam?.layout, 'vendored',
    `rust(seam): the same module-scope const NAME+VALUE in two Cargo.toml compartments is a vendored resource seam (got ${seamShown})`);
  eq(seam?.value, '/var/run/wiregraph-fixture/game.sock', 'rust(seam): …carrying the decoded value');
  eq(JSON.stringify(seam?.compartments), JSON.stringify(['crate-a', 'crate-b']),
    `rust(seam): …with both crates as participants (got ${JSON.stringify(seam?.compartments)})`);
  eq(JSON.stringify(seam?.corroborated), JSON.stringify([]),
    'rust(seam): …and NO import corroboration, because wiregraph emits no import candidates for Rust — the name+value join stands alone');
  // MODULE SCOPE, the mutation-tested guard: crate-a and crate-b hold an identical
  // FUNCTION-LOCAL const (same name, same value). It is the measured false-positive
  // shape and must never be extracted, let alone become a seam.
  ok(!seams.some((s) => s?.token === 'LOCAL_SCRATCH_PATH'),
    `rust(seam/reject): an identical function-local const in two crates is NOT a seam — module scope is required at extraction (got ${seamShown})`);
  ok(!candidates.some((c) => c?.kind === 'const' && c?.name === 'LOCAL_SCRATCH_PATH'),
    'rust(seam/reject): …because it is not extracted at all');
  eq(seams.length, 1, `rust(seam): exactly one seam, so nothing extra slipped in (got ${seamShown})`);
  eq((I.clusterSeams(candidates) || []).length, 0,
    'rust(seam): and const candidates still mint ZERO wire seams');

  rmSync(work, { recursive: true, force: true });

  // --- the SHARED-MODULE layout, and Rust's `use` line ----------------------
  // The dominant Rust shape: one `common` crate holds the constant and every consumer
  // writes `use common::NAME;`. A `use` line NAMES the constant without touching it, and
  // the reference scan reads RAW TEXT — so without `use` in IMPORT_START_RE the crate
  // that only imports it is promoted to a full participant in a seam it has no part in.
  // That is the same false positive phase 1a fixed for JS `import { X } from …`.
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-rust-use-')));
  const crate = (name, body) => {
    mkdirSync(join(ws, name, 'src'), { recursive: true });
    writeFileSync(join(ws, name, 'Cargo.toml'), `[package]\nname = "${name}"\nversion = "0.0.0"\n`);
    writeFileSync(join(ws, name, 'src', 'lib.rs'), body);
  };
  crate('common', 'pub const SHARED_SPOOL_PATH: &str = "/var/spool/wiregraph/queue";\n');
  crate('rd-a', [
    'use common::SHARED_SPOOL_PATH;',
    'pub fn read() -> std::io::Result<String> { std::fs::read_to_string(SHARED_SPOOL_PATH) }',
  ].join('\n') + '\n');
  crate('rd-b', [
    'use common::{',
    '    SHARED_SPOOL_PATH,',
    '};',
    'pub fn write(v: &str) -> std::io::Result<()> { std::fs::write(SHARED_SPOOL_PATH, v) }',
  ].join('\n') + '\n');
  crate('importer', [
    '// Names the constant in its use list and NEVER touches it — not a participant.',
    'pub use common::SHARED_SPOOL_PATH;',
  ].join('\n') + '\n');

  const sig2 = I.extractSignals(ws);
  const seams2 = I.clusterResourceSeams(sig2.candidates, ws, { comments: sig2.comments }) || [];
  const seam2 = seams2.find((s) => s?.token === 'SHARED_SPOOL_PATH');
  eq(seam2?.layout, 'shared-module',
    `rust(seam/shared): one crate defines the constant and others reference it (got ${seams2.map((s) => s?.token).join(', ') || 'none'})`);
  eq(JSON.stringify(seam2?.compartments), JSON.stringify(['rd-a', 'rd-b']),
    `rust(seam/shared): only the crates that USE it participate — the \`use\`-only crate and the defining crate are both excluded (got ${JSON.stringify(seam2?.compartments)})`);
  eq(JSON.stringify(seam2?.definers), JSON.stringify(['common']),
    'rust(seam/shared): …and the single definer is named as such');
  rmSync(ws, { recursive: true, force: true });
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

// Phase 1b-i: named string CONSTANTS are extracted as kind:'const' candidates in every
// language wiregraph parses, carrying the constant's NAME and its string VALUE as
// separate fields. Both halves are load-bearing for resource-seam inference: the
// VENDORED-COPY layout (each compartment holds its own copy of the constants module)
// produces no cross-compartment IMPORTS edge to resolve through, so the only join left
// is "same NAME and same VALUE in two compartments" — and name alone would fuse
// unrelated constants that merely share a common name like DATA_DIR.
//
// Only STRING-valued constants are a resource identifier, so a numeric/boolean one must
// NOT be extracted; and adding the rule must not disturb what each language already
// emits (a function-valued `const` is still a SYMBOL, not a constant).
async function constCandidateTests() {
  const { parseSource } = await import('../src/extract/parse.js');
  const I = await import('../src/contracts/infer.js');

  // Every lookup is optional-chained: an unguarded deref on a rule that stopped firing
  // would throw and abort the whole suite instead of printing a FAIL.
  const parse = (src, lang, variant) => {
    try { return parseSource(src, lang, variant); } catch (e) { return { error: e.message }; }
  };
  const consts = (src, lang, variant) =>
    (parse(src, lang, variant)?.candidates || []).filter((c) => c?.kind === 'const');
  const got = (src, lang, variant) =>
    consts(src, lang, variant).map((c) => `${c?.name}=${c?.value}`).join(', ') || 'none';
  const one = (src, lang, variant, name) => consts(src, lang, variant).find((c) => c?.name === name);
  // K3(a): a declaration whose initialiser is NOT a plain string is still a DEFINITION —
  // recorded with `value: null`, "definition present, value unknown". The old rule
  // dropped it entirely, and that hole is what let a compartment whose own copy of a
  // constant is computed (`process.env.X || '/somewhere/else'`) be treated as a pure USER
  // of somebody else's value and joined to a seam on a path it does not use. Being
  // extracted and having a usable VALUE are two different questions from here on.
  const valueUnknown = (src, lang, variant, name) => {
    const c = one(src, lang, variant, name);
    return !!c && c.value === null;
  };

  // --- TypeScript / JS ------------------------------------------------------
  {
    const src = [
      'export const RESOURCE_PATH = "/var/run/game/state.json";',
      'const TEMPLATE_PATH = `/var/run/game/lock`;',
      'const MAX_RETRIES = 42;',
      'const ENABLED = true;',
      'let MUTABLE_PATH = "/var/run/mutable";',
      'const handler = () => 1;',
      'function localScope() {',
      '  const LOCAL_STATE_PATH = "/tmp/local-ts";',
      '  return LOCAL_STATE_PATH;',
      '}',
    ].join('\n');
    const L = ['typescript', 'typescript'];
    const c = one(src, ...L, 'RESOURCE_PATH');
    ok(c, `const(ts): a string const is extracted (got ${got(src, ...L)})`);
    eq(c?.value, '/var/run/game/state.json', 'const(ts): the VALUE is captured, not the name');
    eq(c?.token, 'RESOURCE_PATH', 'const(ts): token mirrors the constant NAME (what matchContracts matches on)');
    eq(one(src, ...L, 'TEMPLATE_PATH')?.value, '/var/run/game/lock', 'const(ts): a template-string initialiser is captured');
    ok(valueUnknown(src, ...L, 'MAX_RETRIES'), `const(ts): a NUMERIC const has no resource VALUE, but the definition is recorded (got ${got(src, ...L)})`);
    ok(valueUnknown(src, ...L, 'ENABLED'), `const(ts): likewise a BOOLEAN const (got ${got(src, ...L)})`);
    // A module-scope `let`/`var` is a REBINDING, not a constant — but a compartment that
    // rebinds the name is emphatically not a passive user of somebody else's value.
    ok(valueUnknown(src, ...L, 'MUTABLE_PATH'), `const(ts): a \`let\` binding has no constant value, and IS recorded as a definition (got ${got(src, ...L)})`);
    // MODULE SCOPE is required (1b-ii). A function-local const is not shareable across
    // compartments, and it is the measured false-positive source: 19 of the 24 const
    // candidates in wiregraph's own src/ were locals, including a local `key` with an
    // IDENTICAL value in two files — the exact vendored-copy join signature.
    ok(!one(src, ...L, 'LOCAL_STATE_PATH'), `const(ts): a FUNCTION-LOCAL const is NOT extracted (got ${got(src, ...L)})`);
    // Unchanged behavior: a function-valued `const` is still a SYMBOL and is not a constant.
    const syms = parse(src, ...L)?.symbols || [];
    const fn = syms.find((s) => s?.name === 'handler');
    eq(fn?.kind, 'function', `const(ts): a function-valued const is still a function SYMBOL (got ${syms.map((s) => s?.name + ':' + s?.kind).join(', ') || 'none'})`);
    ok(valueUnknown(src, ...L, 'handler'), 'const(ts): a function-valued const carries no constant value (it is a SYMBOL), while still being a definition of the name');
  }

  // --- Python ---------------------------------------------------------------
  {
    const src = [
      'RESOURCE_PATH = "/var/run/game/state.json"',
      'MAX_RETRIES = 42',
      'def loader():',
      '    LOCAL_PATH = "/tmp/local"',
      '    return LOCAL_PATH',
      'class Holder:',
      '    ATTR_PATH = "/tmp/attr"',
    ].join('\n');
    const L = ['python', 'python'];
    eq(one(src, ...L, 'RESOURCE_PATH')?.value, '/var/run/game/state.json', `const(py): a module-level string const is extracted with its value (got ${got(src, ...L)})`);
    ok(valueUnknown(src, ...L, 'MAX_RETRIES'), `const(py): a NUMERIC assignment has no resource value, and is still a definition (got ${got(src, ...L)})`);
    // Python has no const keyword, so SCOPE is the only signal: a name bound inside a
    // function is a local, not something another compartment can share.
    ok(!one(src, ...L, 'LOCAL_PATH'), `const(py): a function-local assignment is NOT extracted (got ${got(src, ...L)})`);
    ok(!one(src, ...L, 'ATTR_PATH'), `const(py): a class-body attribute is NOT extracted (got ${got(src, ...L)})`);
  }

  // --- C --------------------------------------------------------------------
  {
    const src = [
      '#define RESOURCE_PATH "/var/run/game/state.json"',
      '#define MAX_RETRIES 42',
      'static const char *STATE_FILE = "/var/run/game/state";',
      'const char OTHER_FILE[] = "/var/run/game/other";',
      'char *mutable_path = "/var/run/mutable";',
      'static const int LIMIT = 3;',
      'void local_scope(void) {',
      '  static const char *LOCAL_STATE_FILE = "/tmp/local-c";',
      '  (void)LOCAL_STATE_FILE;',
      '}',
    ].join('\n');
    const L = ['c', 'c'];
    eq(one(src, ...L, 'RESOURCE_PATH')?.value, '/var/run/game/state.json', `const(c): #define of a string is extracted with its value (got ${got(src, ...L)})`);
    eq(one(src, ...L, 'STATE_FILE')?.value, '/var/run/game/state', 'const(c): static const char * is extracted with its value');
    eq(one(src, ...L, 'OTHER_FILE')?.value, '/var/run/game/other', 'const(c): const char [] is extracted with its value');
    ok(valueUnknown(src, ...L, 'MAX_RETRIES'), `const(c): a numeric #define has no resource value, and is still a definition (got ${got(src, ...L)})`);
    ok(valueUnknown(src, ...L, 'LIMIT'), `const(c): likewise a numeric static const (got ${got(src, ...L)})`);
    ok(!one(src, ...L, 'mutable_path'), `const(c): a non-const char* is not a constant (got ${got(src, ...L)})`);
    // FILE SCOPE is required (1b-ii): a `static const` inside a function body is a local.
    ok(!one(src, ...L, 'LOCAL_STATE_FILE'), `const(c): a FUNCTION-BODY static const is NOT extracted (got ${got(src, ...L)})`);
  }

  // --- Java (first signal rule this language has ever had) -------------------
  {
    const src = [
      'class Holder {',
      '  public static final String RESOURCE_PATH = "/var/run/game/state.json";',
      '  static final int MAX_RETRIES = 42;',
      '  final String perInstance = "/var/run/instance";',
      '  String plain = "/var/run/plain";',
      '  void run() { final String LOCAL_STATE_PATH = "/tmp/local-java"; helper(); }',
      '}',
    ].join('\n');
    const L = ['java', 'java'];
    eq(one(src, ...L, 'RESOURCE_PATH')?.value, '/var/run/game/state.json', `const(java): static final String is extracted with its value (got ${got(src, ...L)})`);
    ok(valueUnknown(src, ...L, 'MAX_RETRIES'), `const(java): a numeric static final has no resource value, and is still a definition (got ${got(src, ...L)})`);
    ok(!one(src, ...L, 'perInstance'), `const(java): a non-static final field is not a shared constant (got ${got(src, ...L)})`);
    ok(!one(src, ...L, 'plain'), `const(java): a plain mutable field is not a constant (got ${got(src, ...L)})`);
    // Java cannot express the TS/C scope problem — a local cannot be `static` — but the
    // rule keys on field_declaration, so pin that a method-local final is still excluded.
    ok(!one(src, ...L, 'LOCAL_STATE_PATH'), `const(java): a METHOD-LOCAL final is NOT extracted (got ${got(src, ...L)})`);
    // Adding a `sig` rule must not disturb java's def/call extraction.
    const p = parse(src, ...L);
    ok((p?.symbols || []).some((s) => s?.name === 'Holder' && s?.kind === 'class'), 'const(java): class symbols still extracted alongside the new sig rule');
    ok((p?.calls || []).some((c) => c?.name === 'helper'), 'const(java): calls still extracted alongside the new sig rule');
  }

  // --- Kotlin (likewise) ----------------------------------------------------
  {
    const src = [
      'const val RESOURCE_PATH = "/var/run/game/state.json"',
      'const val MAX_RETRIES = 42',
      'val notConst = "/var/run/notconst"',
      'object Holder { const val INNER_PATH = "/var/run/game/inner" }',
      'fun run() { val LOCAL_STATE_PATH = "/tmp/local-kt"; helper() }',
    ].join('\n');
    const L = ['kotlin', 'kotlin'];
    eq(one(src, ...L, 'RESOURCE_PATH')?.value, '/var/run/game/state.json', `const(kt): top-level const val is extracted with its value (got ${got(src, ...L)})`);
    eq(one(src, ...L, 'INNER_PATH')?.value, '/var/run/game/inner', 'const(kt): a const val inside an object is extracted');
    ok(valueUnknown(src, ...L, 'MAX_RETRIES'), `const(kt): a numeric const val has no resource value, and is still a definition (got ${got(src, ...L)})`);
    ok(!one(src, ...L, 'notConst'), `const(kt): a plain \`val\` is not a compile-time constant (got ${got(src, ...L)})`);
    // Kotlin cannot express the scope problem either — `const val` is a compile error
    // inside a function body — but a function-local `val` must still not be extracted.
    ok(!one(src, ...L, 'LOCAL_STATE_PATH'), `const(kt): a FUNCTION-LOCAL val is NOT extracted (got ${got(src, ...L)})`);
    // K3(c) — AN ANNOTATION BREAKS THE PARSE. `@Suppress("unused")` above an UNTYPED
    // top-level `const val` makes this grammar error-recover into
    // `assignment > annotated_expression > infix_expression`, with `const`, `val` and the
    // name as three bare identifiers and NO property_declaration anywhere — so the rule
    // never fired and the constant vanished. Measured consequence: a vendored pair whose
    // second copy carried a @Suppress was seen as defined in ONE compartment and
    // mislabelled layout 'shared-module'.
    const annotated = [
      '@Suppress("unused")',
      'const val ANNOTATED_LOCK_PATH = "/var/run/game/annotated.lock"',
      '@JvmField',
      'const val FIELD_LOCK_PATH = "/var/run/game/field.lock"',
      '@Suppress("unused") const val INLINE_LOCK_PATH = "/var/run/game/inline.lock"',
      '@Suppress("unused")',
      'const val TYPED_LOCK_PATH: String = "/var/run/game/typed.lock"',
      'object Wrapped { @Suppress("x") const val OBJECT_LOCK_PATH = "/var/run/game/object.lock" }',
    ].join('\n');
    for (const [n, v] of [
      ['ANNOTATED_LOCK_PATH', '/var/run/game/annotated.lock'],
      ['FIELD_LOCK_PATH', '/var/run/game/field.lock'],
      ['INLINE_LOCK_PATH', '/var/run/game/inline.lock'],
      ['TYPED_LOCK_PATH', '/var/run/game/typed.lock'],
      ['OBJECT_LOCK_PATH', '/var/run/game/object.lock'],
    ]) {
      eq(one(annotated, ...L, n)?.value, v,
        `const(kt/K3c): an ANNOTATED const val is still extracted — ${n} (got ${got(annotated, ...L)})`);
    }

    const p = parse(src, ...L);
    ok((p?.symbols || []).some((s) => s?.name === 'Holder' && s?.kind === 'class'), 'const(kt): object/class symbols still extracted alongside the new sig rule');
    ok((p?.calls || []).some((c) => c?.name === 'helper'), 'const(kt): calls still extracted alongside the new sig rule');
  }

  // --- Rust -----------------------------------------------------------------
  {
    const src = [
      'pub const RESOURCE_PATH: &str = "/var/run/game/state.json";',
      'pub static STATIC_LOCK_PATH: &str = "/var/run/game/lock";',
      'static mut MUTABLE_PATH: &str = "/var/run/mutable";',
      'const MAX_RETRIES: usize = 42;',
      'const ENABLED: bool = true;',
      'const RAW_WIN_PATH: &str = r"C:\\temp\\state";',
      'const BYTE_PATH: &[u8] = b"/var/run/bytes";',
      'const JOINED_PATH: &str = concat!("/var/run/", "joined");',
      'pub mod cfg { pub const MOD_SCOPE_PATH: &str = "/var/run/game/mod"; }',
      'pub struct Holder;',
      'impl Holder { const ASSOC_STATE_PATH: &str = "/var/run/game/assoc"; }',
      'fn local_scope() -> usize {',
      '    const LOCAL_STATE_PATH: &str = "/tmp/local-rs";',
      '    static LOCAL_STATIC_PATH: &str = "/tmp/local-static-rs";',
      '    helper(LOCAL_STATE_PATH.len() + LOCAL_STATIC_PATH.len())',
      '}',
    ].join('\n');
    const L = ['rust', 'rust'];
    eq(one(src, ...L, 'RESOURCE_PATH')?.value, '/var/run/game/state.json', `const(rs): a module-scope \`const\` string is extracted with its value (got ${got(src, ...L)})`);
    eq(one(src, ...L, 'RESOURCE_PATH')?.token, 'RESOURCE_PATH', 'const(rs): token mirrors the constant NAME');
    eq(one(src, ...L, 'STATIC_LOCK_PATH')?.value, '/var/run/game/lock', 'const(rs): a `static` is extracted the same way — it is the other half of what C spells `#define`');
    ok(valueUnknown(src, ...L, 'MUTABLE_PATH'), `const(rs): a \`static mut\` is a REBINDING with no constant value, and is still recorded as a definition (got ${got(src, ...L)})`);
    ok(valueUnknown(src, ...L, 'MAX_RETRIES'), `const(rs): a NUMERIC const has no resource value, and is still a definition (got ${got(src, ...L)})`);
    ok(valueUnknown(src, ...L, 'ENABLED'), `const(rs): likewise a BOOLEAN const (got ${got(src, ...L)})`);
    ok(valueUnknown(src, ...L, 'JOINED_PATH'), `const(rs): a concat!() initialiser is definition-present/value-unknown, not a value (got ${got(src, ...L)})`);
    ok(valueUnknown(src, ...L, 'BYTE_PATH'), `const(rs): a b"…" byte string is not a plain string literal (got ${got(src, ...L)})`);
    // A RAW literal is deliberately value-unknown: constCandidate decodes escapes over
    // every value it keeps, and the entire point of `r"C:\temp\state"` is that `\t` is a
    // backslash and a `t` — decoding it would hand inference a value the program does not
    // hold. A missing value costs a seam; a WRONG value invents one.
    ok(valueUnknown(src, ...L, 'RAW_WIN_PATH'), `const(rs): a RAW string is recorded as a definition with NO value rather than a wrongly-unescaped one (got ${got(src, ...L)})`);
    // MODULE / FILE SCOPE, the Rust spelling of tsConst's `program` guard.
    eq(one(src, ...L, 'MOD_SCOPE_PATH')?.value, '/var/run/game/mod', `const(rs): a const inside a \`mod\` body is module scope (got ${got(src, ...L)})`);
    // An ASSOCIATED const is addressed as `Holder::ASSOC_STATE_PATH` from another crate —
    // exactly the position java's `static final` field and kotlin's object member occupy.
    eq(one(src, ...L, 'ASSOC_STATE_PATH')?.value, '/var/run/game/assoc', `const(rs): an \`impl\`-associated const is extracted (got ${got(src, ...L)})`);
    ok(!one(src, ...L, 'LOCAL_STATE_PATH'), `const(rs): a FUNCTION-BODY const is NOT extracted (got ${got(src, ...L)})`);
    ok(!one(src, ...L, 'LOCAL_STATIC_PATH'), `const(rs): nor a function-body \`static\` (got ${got(src, ...L)})`);
    // Adding the sig rule must not disturb rust's def/call extraction.
    const p = parse(src, ...L);
    ok((p?.symbols || []).some((s) => s?.name === 'Holder' && s?.kind === 'class'), 'const(rs): struct symbols still extracted alongside the sig rule');
    ok((p?.calls || []).some((c) => c?.name === 'helper'), 'const(rs): calls still extracted alongside the sig rule');
  }

  // --- the record survives BOTH re-shapers ----------------------------------
  // name/value are added in parseSource and must be carried through the two
  // independently-written shapers — the build path (src/extract/index.js) and the
  // inference path (src/contracts/infer.js). A field added to one only is silently
  // lost on the other, so assert BOTH pipelines, not just parseSource.
  {
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-const-')));
    const a = join(work, 'svc-a'), b = join(work, 'svc-b');
    mkdirSync(join(a, '.git'), { recursive: true });
    mkdirSync(join(b, '.git'), { recursive: true });
    // Vendored copies: each compartment holds its OWN constants module, so there is no
    // cross-compartment import — name+value is the only available join.
    writeFileSync(join(a, 'constants.js'), 'export const GAME_STATE_PATH = "/var/run/game/state.json";\n');
    writeFileSync(join(b, 'constants.js'), 'export const GAME_STATE_PATH = "/var/run/game/state.json";\n');

    const inferred = (I.extractCandidates(work) || []).filter((c) => c?.kind === 'const');
    const aSide = inferred.find((c) => c?.compartment === 'svc-a');
    const bSide = inferred.find((c) => c?.compartment === 'svc-b');
    eq(aSide?.name, 'GAME_STATE_PATH', `const(shape): infer.js shaper carries the NAME (got ${inferred.map((c) => c?.compartment + ':' + c?.name).join(', ') || 'none'})`);
    eq(aSide?.value, '/var/run/game/state.json', 'const(shape): infer.js shaper carries the VALUE');
    eq(bSide?.value, aSide?.value, 'const(shape): both vendored copies expose the same value, so the name+value join is available');
    eq(aSide?.file, 'constants.js', 'const(shape): infer.js shaper still carries file');

    const { extractCode } = await import('../src/extract/index.js');
    const g = new Graph(work);
    const built = (extractCode(g, work)?.candidates || []).filter((c) => c?.kind === 'const');
    eq(built.find((c) => c?.compartment === 'svc-a')?.name, 'GAME_STATE_PATH', `const(shape): extract/index.js shaper carries the NAME (got ${built.map((c) => c?.compartment + ':' + c?.name).join(', ') || 'none'})`);
    eq(built.find((c) => c?.compartment === 'svc-a')?.value, '/var/run/game/state.json', 'const(shape): extract/index.js shaper carries the VALUE');

    // 1b-i is extraction ONLY. clusterSeams groups on the token alone, so letting
    // 'const' fall through would mint a bogus AsyncAPI channel for every shared constant
    // NAME (regardless of value) and inflate the inferredSeams nudge count.
    const seams = I.clusterSeams(inferred) || [];
    eq(seams.length, 0, `const(scope): const candidates do not become wire seams in 1b-i (got ${seams.map((s) => s?.kind + ':' + s?.token).join(', ') || 'none'})`);
    rmSync(work, { recursive: true, force: true });
  }
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

// The HOOK incremental path needs the same schema gate the MCP update_graph path has
// (src/mcp/server.js ensureSchemaCurrent). Only a full --reset build migrates the
// tables, so on an old-schema db every background refresh — post-edit --files, the
// SessionStart catch-up, the invalid-baseline reconcile — would throw, and the graph
// would stay stale until the user noticed and rebuilt by hand. Stamping an older
// version is exactly what a real SCHEMA_VERSION bump looks like to the gate.
async function refreshSchemaGateTest() {
  const S = await import('../scripts/lib/state.mjs');
  const runRefresh = (proj, args = []) => execFileP('node', [REFRESH, ...args], { env: { ...process.env, CLAUDE_PROJECT_DIR: proj } });
  const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-schemagate-')));
  mkdirSync(join(proj, '.git'), { recursive: true });
  writeFileSync(join(proj, 'a.js'), 'export function alpha(){ return 1; }\n');
  await runRefresh(proj, ['--full']);

  const dbPath = join(proj, '.wiregraph', 'graph.db');
  const aJs = join(proj, 'a.js');
  // A real SCHEMA_VERSION bump moves BOTH stamps: loadGraph writes meta.schema_version
  // and mirrors it into the file header's user_version slot in one transaction. The gate
  // reads the header (a 64-byte read, so it stays off the hot path) and falls back to
  // `meta` only when the header stamp is absent — `header` is separable here so both
  // halves of that can be exercised.
  const stampVersion = (v, header = v) => {
    const c = connect(dbPath, {});
    c.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('schema_version', ?)").run(String(v));
    c.exec(`PRAGMA user_version = ${header}`);
    c.close();
  };
  const lastFull = () => S.readState(proj)?.lastFullBuild;
  // Only the tail WRITTEN BY THE RUN UNDER TEST counts: the log is append-only and an
  // earlier phase legitimately put an escalation line in it, so asserting over the whole
  // file makes the "must NOT escalate" cases unfalsifiable.
  const logLen = () => { try { return readFileSync(S.refreshLogPath(proj), 'utf8').length; } catch { return 0; } };
  const logTail = (from) => { try { return readFileSync(S.refreshLogPath(proj), 'utf8').slice(from); } catch { return ''; } };

  // (1) OLDER schema → the incremental (--files) path must escalate to a full rebuild,
  // which is the only thing that recreates the tables at the current version.
  const beforeOld = lastFull();
  const markOld = logLen();
  stampVersion(SCHEMA_VERSION - 1);
  writeFileSync(aJs, 'export function alpha(){ return 1; }\nexport function beta(){ return 2; }\n');
  await runRefresh(proj, ['--files', aJs]);
  ok(lastFull() && lastFull() !== beforeOld, 'schema gate: an old-schema db escalates the hook incremental to a full rebuild');
  has(logTail(markOld), 'db schema older', 'schema gate: the escalation is logged with its reason');
  {
    // NOT a gate assertion (the db reads as current either way — loadGraph restamps
    // unconditionally, which is the whole reason the gate exists). This pins that the
    // escalation does not LOSE the edit that triggered it.
    const c = connect(dbPath, { readonly: true });
    has(Q.findSymbol(c, proj, 'beta'), 'a.js', 'schema gate: the escalated rebuild still indexed the edit that triggered it');
    c.close();
  }

  // (2) The trap in the cheap path: an ABSENT header stamp means UNKNOWN, not outdated.
  // Every db built before that mirror existed reads 0, and treating 0 as old would full-
  // rebuild every existing project on its next edit — a far worse regression than the one
  // the cheap path is avoiding. meta says current, so nothing must happen.
  const beforeAbsent = lastFull();
  const markAbsent = logLen();
  stampVersion(SCHEMA_VERSION, 0);
  await runRefresh(proj, ['--files', aJs]);
  eq(lastFull(), beforeAbsent, 'schema gate: an ABSENT header stamp on a current db does NOT trigger a rebuild');
  ok(!logTail(markAbsent).includes('db schema older'), 'schema gate: an absent header stamp is never reported as outdated');

  // (3) …and with the header stamp absent the gate still falls back to the authoritative
  // `meta` row, so a genuinely old db is caught rather than waved through.
  const beforeFallback = lastFull();
  stampVersion(SCHEMA_VERSION - 1, 0);
  await runRefresh(proj, ['--files', aJs]);
  ok(lastFull() && lastFull() !== beforeFallback, 'schema gate: with no header stamp it falls back to meta and still escalates');

  // (4) NEWER schema → must NOT be auto-rebuilt: a reset would recreate the tables at
  // THIS older schema and discard whatever the newer wiregraph stored. The lethal
  // assertion is the LOG, not lastFullBuild: an over-triggering gate (`!==` instead of
  // `<`) escalates, loadGraph refuses the downgrade, the throw is swallowed by
  // main().catch — so lastFullBuild never moves either way and only the attempt shows.
  const beforeNew = lastFull();
  const markNew = logLen();
  stampVersion(SCHEMA_VERSION + 1);
  await runRefresh(proj, ['--files', aJs]);
  ok(!logTail(markNew).includes('db schema older'), 'schema gate: a NEWER-schema db is never diagnosed as outdated (no escalation attempted)');
  eq(lastFull(), beforeNew, 'schema gate: a NEWER-schema db is left alone (no silent downgrade rebuild)');

  rmSync(proj, { recursive: true, force: true });
}

// The gate has to cover every graph the refresh FANS OUT into, not just our own. All
// four incremental call sites pass {fanOut:true}, and reindexFiles runs a build against
// each linked peer's OWN db (build.js -> graphsListing), so a schema bump that heals only
// the editing project then runs the exact unguarded incremental this gate exists to
// prevent — against the peer. The peer's db cannot testify to that, because loadGraph
// restamps schema_version unconditionally on the incremental path; the tell is whether
// the peer got a full rebuild, i.e. its lastFullBuild.
async function refreshSchemaGateFanOutTest() {
  const S = await import('../scripts/lib/state.mjs');
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-gatefan-')));
  const A = join(ws, 'A'); const B = join(ws, 'B');
  for (const [d, f, body] of [[A, 'a.js', 'export function aFn(){ return 1; }\n'], [B, 'b.js', 'export function bFn(){ return 2; }\n']]) {
    mkdirSync(join(d, '.git'), { recursive: true });
    writeFileSync(join(d, f), body);
  }
  S.addLink(A, { root: B, peer: B, initiator: A });   // symmetric link, so an edit in A
  S.addLink(B, { root: A, peer: A, initiator: A });   // fans out into B's graph
  await initGraph(A);
  await initGraph(B);

  // Only B is left on an older schema — A's own db is fine, so nothing but the fan-out
  // coverage can catch this.
  const c = connect(join(B, '.wiregraph', 'graph.db'), {});
  c.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION - 1));
  c.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
  c.close();

  const beforeB = S.readState(B)?.lastFullBuild;
  writeFileSync(join(A, 'a.js'), 'export function aFn(){ return 1; }\nexport function aFn2(){ return 3; }\n');
  await execFileP('node', [REFRESH, '--files', join(A, 'a.js')], { env: { ...process.env, CLAUDE_PROJECT_DIR: A } });

  const afterB = S.readState(B)?.lastFullBuild;
  ok(afterB && afterB !== beforeB, 'schema gate: a stale-schema LINKED PEER is migrated too, not incrementally written');
  has(readFileSync(S.refreshLogPath(A), 'utf8'), B, 'schema gate: the peer escalation is logged against the peer it healed');

  rmSync(ws, { recursive: true, force: true });
}

// --- MCP schema gate --------------------------------------------------------
// The same hazard as the hook's gate, one layer up. Every read tool self-heals through
// ensureFresh and update_graph runs an incremental, and BOTH fan out into every linked
// peer's own db — so ensureSchemaCurrent has to hold PER GRAPH. It used to be one
// process-wide boolean plus one promise, which let the project's verdict speak for a
// peer: confirm the project, never look at the stale peer, then run against it the exact
// incremental the gate exists to prevent.
//
// Every assertion below keys on an observable SIDE EFFECT, never on the version the db
// ends up stamped with: the incremental path restamps schema_version unconditionally, so
// "the db reads as current afterwards" is equally true with the gate deleted. The tell is
// whether a full rebuild actually RAN — a marker function appended to a source file after
// the last build, and never incrementally indexed, appears in a graph only if something
// rebuilt that graph from scratch.
const MCP_SERVER_URL = pathToFileURL(join(HERE, '..', 'src', 'mcp', 'server.js')).href;

// src/mcp/server.js resolves PROJECT from CLAUDE_PROJECT_DIR once at import time, so each
// scenario runs the gate in its OWN child process — which also gives each one a clean
// per-graph cache. Returns the graph roots the gate confirmed. The marker prefix is
// needed because a rebuild logs its progress to the same stdout.
async function driveSchemaGate(project) {
  const src = `const m = await import(${JSON.stringify(MCP_SERVER_URL)});\n`
    + 'await m.ensureSchemaCurrent();\n'
    + "process.stdout.write('\\nCONFIRMED:' + JSON.stringify(m.__getSchemaConfirmed()) + '\\n');\n";
  const { stdout } = await execFileP('node', ['--input-type=module', '-e', src],
    { env: { ...process.env, CLAUDE_PROJECT_DIR: project } });
  return JSON.parse(/^CONFIRMED:(.*)$/m.exec(stdout)?.[1] || 'null');
}
// A real SCHEMA_VERSION bump moves BOTH stamps (loadGraph writes meta.schema_version and
// mirrors it into the file header's user_version slot in one transaction); `header` is
// separable so the cheap probe and its authoritative fallback can be exercised apart.
function stampSchemaVersion(project, v, header = v) {
  const c = connect(join(project, '.wiregraph', 'graph.db'), {});
  c.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('schema_version', ?)").run(String(v));
  c.exec(`PRAGMA user_version = ${header}`);
  c.close();
}
function graphHasSymbol(project, name) {
  const c = connect(join(project, '.wiregraph', 'graph.db'), { readonly: true });
  try { return (c.prepare('SELECT count(*) AS n FROM symbols WHERE name = ?').get(name)?.n || 0) > 0; }
  finally { c.close(); }
}

// Fan-out: only the PEER is left on an old schema, so nothing but per-graph coverage can
// catch this — and the project being CURRENT is what a single shared flag turns into
// "everything is current", skipping the peer entirely.
async function mcpSchemaGateFanOutTest() {
  const S = await import('../scripts/lib/state.mjs');
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-mcpgatefan-')));
  const A = join(ws, 'A'); const B = join(ws, 'B');
  for (const [d, f, body] of [[A, 'a.js', 'export function aFn(){ return 1; }\n'], [B, 'b.js', 'export function bFn(){ return 2; }\n']]) {
    mkdirSync(join(d, '.git'), { recursive: true });
    writeFileSync(join(d, f), body);
  }
  S.addLink(A, { root: B, peer: B, initiator: A });   // symmetric link, so an incremental
  S.addLink(B, { root: A, peer: A, initiator: A });   // from A writes into B's graph too
  await initGraph(A);
  await initGraph(B);

  appendFileSync(join(A, 'a.js'), 'export function aMarker(){ return 9; }\n');
  appendFileSync(join(B, 'b.js'), 'export function bMarker(){ return 9; }\n');
  stampSchemaVersion(B, SCHEMA_VERSION - 1);

  const confirmed = await driveSchemaGate(A);
  ok(graphHasSymbol(B, 'bMarker'), 'mcp schema gate: a stale-schema LINKED PEER is migrated (full rebuild) before a fan-out incremental can touch it');
  ok(!graphHasSymbol(A, 'aMarker'), 'mcp schema gate: the project\'s own current-schema db is left alone (no gratuitous rebuild)');
  ok(confirmed?.includes(A), 'mcp schema gate: the project is confirmed');
  ok(confirmed?.includes(B), 'mcp schema gate: the peer is confirmed on its OWN verdict, not the project\'s');

  rmSync(ws, { recursive: true, force: true });
}

// The probe itself, through the gate, against real dbs: an older db migrates, and the
// ABSENT header stamp stays UNKNOWN rather than becoming OUTDATED — reading 0 as old
// would full-rebuild every project built before the mirror existed, on its next read.
async function mcpSchemaGateProbeTest() {
  const P = realpathSync(mkdtempSync(join(tmpdir(), 'cg-mcpgate-')));
  mkdirSync(join(P, '.git'), { recursive: true });
  writeFileSync(join(P, 'p.js'), 'export function pFn(){ return 1; }\n');
  await initGraph(P);

  // (1) OLDER schema on the project's own db → migrate, so a read is served from tables
  // that actually have the current shape.
  appendFileSync(join(P, 'p.js'), 'export function markOld(){ return 2; }\n');
  stampSchemaVersion(P, SCHEMA_VERSION - 1);
  const c1 = await driveSchemaGate(P);
  ok(graphHasSymbol(P, 'markOld'), 'mcp schema gate: a stale-schema project db is healed by a full rebuild before any read');
  ok(c1?.includes(P), 'mcp schema gate: the healed graph is confirmed');

  // (2) THE TRAP: an absent header stamp on a db `meta` says is current. Every db built
  // before the mirror existed reads 0 here, and a rebuild-on-0 would hit all of them.
  appendFileSync(join(P, 'p.js'), 'export function markLegacy(){ return 3; }\n');
  stampSchemaVersion(P, SCHEMA_VERSION, 0);
  const c2 = await driveSchemaGate(P);
  ok(!graphHasSymbol(P, 'markLegacy'), 'mcp schema gate: an ABSENT header stamp is UNKNOWN, not outdated — a legacy db is NOT force-rebuilt');
  ok(c2?.includes(P), 'mcp schema gate: the absent stamp falls back to `meta`, which confirms the db as current');

  // (3) …and that fallback is a real authoritative read, not a blanket "0 means fine":
  // with the header still absent, a genuinely old `meta` row must still migrate.
  stampSchemaVersion(P, SCHEMA_VERSION - 1, 0);
  await driveSchemaGate(P);
  ok(graphHasSymbol(P, 'markLegacy'), 'mcp schema gate: with no header stamp it falls back to `meta` and still migrates a genuinely old db');

  // (4) NEWER db: a reset would recreate the tables at THIS older schema and discard what
  // the newer wiregraph stored. Never rebuilt — and never CONFIRMED either, so the probe
  // re-runs once the plugin is updated.
  appendFileSync(join(P, 'p.js'), 'export function markNewer(){ return 4; }\n');
  stampSchemaVersion(P, SCHEMA_VERSION + 1);
  const c4 = await driveSchemaGate(P);
  ok(!graphHasSymbol(P, 'markNewer'), 'mcp schema gate: a NEWER-schema db is never auto-rebuilt (no silent downgrade)');
  ok(!c4?.includes(P), 'mcp schema gate: a NEWER-schema db is not confirmed either');

  rmSync(P, { recursive: true, force: true });
}

// The per-graph bookkeeping, driven directly with injected deps — no dbs, no rebuilds, so
// the concurrency cases are deterministic. Mirrors ensureFreshTests' shape.
async function mcpSchemaGateUnitTests() {
  const { ensureSchemaCurrent, ensureFresh, __setTestHooks, __resetFresh, __getSchemaConfirmed, __getLastFreshError, __getLastFreshAt } =
    await import('../src/mcp/server.js');
  const A = '/graphs/a', B = '/graphs/b';

  // 1) Single-flight PER GRAPH: two callers that arrive on the same stale graph share ONE
  //    migrating rebuild, and BOTH stay pending until it settles (a caller that returned
  //    early would go on to read the un-migrated db).
  {
    __resetFresh();
    let calls = 0, release;
    const gate = new Promise((r) => { release = r; });
    __setTestHooks({ fanOutGraphs: () => [A], schemaStatus: () => 'older', runBuild: async () => { calls++; await gate; } });
    const p1 = ensureSchemaCurrent();
    const p2 = ensureSchemaCurrent();
    const sentinel = Symbol('pending');
    const timer = () => new Promise((r) => setTimeout(() => r(sentinel), 25));
    eq(await Promise.race([p1.then(() => 'resolved'), timer()]), sentinel, 'schema gate: the first caller stays pending until the migration settles');
    eq(await Promise.race([p2.then(() => 'resolved'), timer()]), sentinel, 'schema gate: a caller arriving mid-migration joins it (no early return onto the old schema)');
    release();
    await Promise.all([p1, p2]);
    eq(calls, 1, 'schema gate: concurrent heals of the SAME graph dedup onto one rebuild');
  }

  // 2) …and that dedup is per graph, not global: with A's migration still in flight, B
  //    must get its OWN rebuild rather than being covered by A's promise.
  {
    __resetFresh();
    const built = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    __setTestHooks({
      fanOutGraphs: () => [A, B],
      schemaStatus: () => 'older',
      runBuild: async (o) => { built.push(o.project); if (o.project === A) await gate; },
    });
    const p1 = ensureSchemaCurrent();
    const p2 = ensureSchemaCurrent();
    eq(built.join(','), A, 'schema gate: while A is migrating, no second rebuild of A is started');
    release();
    await Promise.all([p1, p2]);
    eq(built.join(','), `${A},${B}`, 'schema gate: concurrent heals of DIFFERENT graphs both proceed, once each');
    eq(__getSchemaConfirmed().sort().join(','), [A, B].sort().join(','), 'schema gate: each migrated graph is confirmed');
  }

  // 3) Confirming one graph must not confirm another — the whole defect. A is already
  //    current; B is stale and must still be rebuilt.
  {
    __resetFresh();
    const built = [];
    const probed = [];
    __setTestHooks({
      fanOutGraphs: () => [A, B],
      schemaStatus: (p) => { probed.push(p); return p.includes('/a') ? 'current' : 'older'; },
      runBuild: async (o) => { built.push(o.project); },
    });
    await ensureSchemaCurrent();
    eq(built.join(','), B, 'schema gate: a current project does not mark a stale peer as confirmed — the peer is still migrated');
    // 3b) …and a confirmed graph costs nothing on the next call: no re-probe, no rebuild.
    const probes = probed.length;
    await ensureSchemaCurrent();
    eq(probed.length, probes, 'schema gate: a confirmed graph is not re-probed on the next read');
    eq(built.length, 1, 'schema gate: a confirmed graph is not rebuilt again');
  }

  // 4) `missing` (nothing built) and `newer` (a later wiregraph wrote it) are not ours to
  //    fix, and neither is CONFIRMED — so the probe re-runs once the situation changes.
  for (const status of ['missing', 'newer', 'unreadable']) {
    __resetFresh();
    let calls = 0;
    __setTestHooks({ fanOutGraphs: () => [A], schemaStatus: () => status, runBuild: async () => { calls++; } });
    await ensureSchemaCurrent();
    eq(calls, 0, `schema gate: a '${status}' db is never rebuilt by the gate`);
    eq(__getSchemaConfirmed().length, 0, `schema gate: a '${status}' db is not confirmed (the probe re-runs)`);
  }

  // 5) A migration that FAILS must be observable and must BLOCK the incremental it was
  //    guarding — writing into an old-schema db is what the gate exists to prevent, and
  //    loadGraph would then stamp it current and defeat every later check. It reuses
  //    lastFreshError (freshRead prepends that to every answer until a refresh succeeds)
  //    rather than adding a second, competing channel.
  {
    __resetFresh();
    let reindexed = 0;
    __setTestHooks({
      fanOutGraphs: () => [A],
      schemaStatus: () => 'older',
      runBuild: async () => { throw new Error('rebuild exploded'); },
      staleNow: () => ['x.c'],
      reindexFiles: async () => { reindexed++; },
    });
    await ensureSchemaCurrent();
    eq(__getSchemaConfirmed().length, 0, 'schema gate: a graph whose migration failed is NOT confirmed');
    await ensureFresh();
    eq(reindexed, 0, 'schema gate: a failed migration blocks the self-heal incremental instead of running it against the old schema');
    has(__getLastFreshError(), 'rebuild exploded', 'schema gate: a failed migration is surfaced through lastFreshError, not swallowed');
    eq(__getLastFreshAt(), 0, 'schema gate: the freshness window stays unclaimed, so the next read retries the migration');
  }

  __resetFresh(); // leave module state clean
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

// Compartment BOUNDARY inference — what does and does not fragment the tree. Five rules
// with no prior coverage, and each one silently reshapes every symbol id when it changes
// (the compartment name is baked into every id):
//   (a) a bare/config package.json (no `name`, no `workspaces`) is NOT a boundary — and
//       the test is TRUTHINESS, not key presence: {"name":""} and {"workspaces":null}
//       are not boundaries, while {"workspaces":[]} is (walk.js:69);
//   (b) EVERY entry of MODULE_MANIFESTS is a boundary — no fixture exercised any of
//       go.mod / Cargo.toml / pyproject.toml / pom.xml / build.gradle[.kts];
//   (c) a manifest must be a FILE (walk.js:62) — a DIRECTORY named `pyproject.toml` is
//       not one. `.git` is deliberately matched WITHOUT that guard (walk.js:60), because
//       a normal repo's .git is a dir and a worktree's is a file and both are boundaries.
//       The asymmetry is load-bearing, so both halves are pinned;
//   (d) IGNORE_DIRS gates the walk BEFORE any boundary check, at EVERY depth — not just
//       under the scan root — so a manifest (or even a .git) under node_modules/ or
//       dist/ is never discovered, however deeply nested. Vendored packages would
//       otherwise mint hundreds of phantom compartments;
//   (e) the discovered set is asserted EXACTLY — as {dir, name} pairs, not a Set of
//       names. A Set hides duplicates, hides a spurious extra boundary, and cannot even
//       express the two-dirs-both-named-`api` basename collision that makes
//       compartmentId (src/model.js) collapse two roots into one row.
// Then the same picture at the DB level, since a filter applied downstream of
// findCompartmentRoots would be invisible to the walk-level assertions above.
async function compartmentBoundaryTest() {
  const W = await import('../src/extract/walk.js');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-bound-')));
  const ws = join(work, 'ws'); // named (not mkdtemp-random) so the root compartment is assertable
  mkdirSync(ws, { recursive: true });
  const mk = (rel, files) => {
    const d = join(ws, rel);
    mkdirSync(d, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(d, name), content);
    return d;
  };

  // (a) package.json variants — only a truthy `name` or `workspaces` is a boundary.
  mk('bare', { 'package.json': '{"private":true,"devDependencies":{"eslint":"^9"}}', 'b.js': 'export function bareFn(){ return 1; }\n' });
  mk('broken', { 'package.json': 'not json at all', 'x.js': 'export function brokenFn(){ return 4; }\n' });
  mk('emptyname', { 'package.json': '{"name":""}', 'en.js': 'export function emptyNameFn(){ return 8; }\n' });
  mk('nullws', { 'package.json': '{"workspaces":null}', 'nw.js': 'export function nullWsFn(){ return 9; }\n' });
  mk('named', { 'package.json': '{"name":"named"}', 'n.js': 'export function namedFn(){ return 2; }\n' });
  mk('wsonly', { 'package.json': '{"workspaces":["packages/*"]}', 'w.js': 'export function wsFn(){ return 3; }\n' });
  mk('emptyws', { 'package.json': '{"workspaces":[]}', 'ew.js': 'export function emptyWsFn(){ return 10; }\n' });

  // (b) one directory per module manifest. Three of them also get a source file so they
  // reach the DB assertion below; wiregraph indexes no Go or Rust, so the pairing is with
  // whatever language a repo carrying that manifest plausibly also holds.
  const MANIFESTS = {
    gomod: 'go.mod', cargo: 'Cargo.toml', pyproj: 'pyproject.toml',
    maven: 'pom.xml', gradle: 'build.gradle', gradlekts: 'build.gradle.kts',
  };
  for (const [dir, manifest] of Object.entries(MANIFESTS)) mk(join('mods', dir), { [manifest]: '' });
  writeFileSync(join(ws, 'mods', 'gomod', 'm.js'), 'export function goSideFn(){ return 11; }\n');
  writeFileSync(join(ws, 'mods', 'pyproj', 'm.py'), 'def py_fn():\n    return 12\n');
  writeFileSync(join(ws, 'mods', 'maven', 'M.java'), 'public class M { public static int mavenFn(){ return 13; } }\n');

  // (c) manifest-as-a-DIRECTORY vs .git-as-a-FILE.
  mkdirSync(join(ws, 'dirmanifest', 'pyproject.toml'), { recursive: true });
  writeFileSync(join(ws, 'dirmanifest', 'dm.js'), 'export function dirManifestFn(){ return 14; }\n');
  mk('gitfile', { '.git': 'gitdir: /nonexistent/repo/.git/worktrees/x\n', 'gf.js': 'export function gitFileFn(){ return 15; }\n' });

  // (d) boundaries buried inside ignored dirs — the strongest markers we have (a .git AND
  // a named package.json AND a module manifest), so only the IGNORE_DIRS gate can explain
  // their absence. The third sits TWO levels below the scan root, inside a dir that is
  // itself a compartment boundary, so a filter that only fires at depth 1 misses it.
  mkdirSync(join(ws, 'node_modules', 'dep', '.git'), { recursive: true });
  mk(join('node_modules', 'dep'), { 'package.json': '{"name":"dep"}', 'd.js': 'export function depFn(){ return 5; }\n' });
  mk(join('dist', 'gen'), { 'Cargo.toml': '', 'g.js': 'export function genFn(){ return 6; }\n' });
  mkdirSync(join(ws, 'named', 'node_modules', 'pkg', '.git'), { recursive: true });
  mk(join('named', 'node_modules', 'pkg'), { 'package.json': '{"name":"pkg"}', 'Cargo.toml': '', 'p.js': 'export function pkgFn(){ return 7; }\n' });

  // (e) two boundary dirs sharing the basename `api` — no source, so they stay out of the
  // db. compartmentId is name-only, so leaving BOTH named `api` collapsed them into one
  // row and made every file of one resolve under the other's root. The INFERRED partition
  // now disambiguates a basename collision by the dir's path relative to the walked root
  // (H1 — see inferredBasenameCollisionTest), so the expectation below is the FIXED name,
  // not the bare basename. Only the colliding pair is renamed; every other entry here is
  // byte-identical to before, which is the property that keeps existing ids stable.
  mk(join('svc1', 'api'), { 'Cargo.toml': '' });
  mk(join('svc2', 'api'), { 'go.mod': '' });

  const roots = W.findCompartmentRoots(ws).map((r) => `${relative(ws, r.dir)}|${r.name}`).sort();
  const expected = [
    'named|named', 'wsonly|wsonly', 'emptyws|emptyws',
    'mods/gomod|gomod', 'mods/cargo|cargo', 'mods/pyproj|pyproj',
    'mods/maven|maven', 'mods/gradle|gradle', 'mods/gradlekts|gradlekts',
    'gitfile|gitfile', 'svc1/api|svc1/api', 'svc2/api|svc2/api',
  ].sort();
  eq(JSON.stringify(roots), JSON.stringify(expected),
    'boundary: exactly these dirs are compartment roots — no extras, no duplicates, and the two `api` roots carry DISTINCT names');

  // The walk agrees: files under a NON-boundary dir fall through to the ROOT compartment,
  // and nothing under an ignored dir is yielded at all.
  const byFn = Object.fromEntries([...W.walkSources(ws)].map((f) => [f.relPath.split('/').pop(), f]));
  eq(byFn['b.js']?.compartment, 'ws', 'boundary: a file under a bare package.json attributes to the ROOT compartment');
  eq(byFn['b.js']?.relPath, join('bare', 'b.js'), 'boundary: its relPath stays relative to the root, not to the bare dir');
  eq(byFn['en.js']?.compartment, 'ws', 'boundary: an EMPTY-STRING package name is falsy — not a boundary');
  eq(byFn['nw.js']?.compartment, 'ws', 'boundary: a null `workspaces` is falsy — not a boundary');
  eq(byFn['ew.js']?.compartment, 'emptyws', 'boundary: an EMPTY-ARRAY `workspaces` is truthy — it IS a boundary');
  eq(byFn['dm.js']?.compartment, 'ws', 'boundary: a DIRECTORY named pyproject.toml is not a manifest');
  eq(byFn['gf.js']?.compartment, 'gitfile', 'boundary: a .git FILE (worktree pointer) is a boundary — .git skips the isFile guard');
  eq(byFn['n.js']?.compartment, 'named', 'boundary: a file under a named package.json attributes to that compartment');
  ok(!byFn['d.js'], 'boundary: no file under node_modules/ is walked');
  ok(!byFn['g.js'], 'boundary: no file under dist/ is walked');
  ok(!byFn['p.js'], 'boundary: no file under a node_modules/ nested two levels down is walked');

  // Same picture once persisted. Five of the six MODULE_MANIFESTS had never reached the
  // database at all, so any downstream filtering of findCompartmentRoots was invisible.
  const db = join(work, 'graph.db');
  await runBuild({ target: ws, project: ws, db, reset: true });
  const conn = connect(db, { readonly: true });
  // `gradlekts` is here even though nothing was written into it: `.kts` is an INDEXED
  // Kotlin extension (lang.js), so build.gradle.kts is simultaneously the manifest that
  // declares the boundary and the only source file inside it. That is current behavior,
  // pinned rather than papered over. `cargo` and `gradle` hold no source and so stay out.
  const comps = conn.prepare('SELECT name FROM compartments').all().map((r) => r.name).sort();
  eq(JSON.stringify(comps), JSON.stringify(['emptyws', 'gitfile', 'gomod', 'gradlekts', 'maven', 'named', 'pyproj', 'ws', 'wsonly']),
    'boundary/db: exactly the source-bearing boundaries become compartment rows');
  const files = conn.prepare('SELECT compartment, path FROM files').all().map((r) => `${r.compartment}:${r.path}`).sort();
  eq(JSON.stringify(files), JSON.stringify([
    'emptyws:ew.js', 'gitfile:gf.js', 'gomod:m.js', 'gradlekts:build.gradle.kts', 'maven:M.java', 'named:n.js', 'pyproj:m.py',
    'ws:bare/b.js', 'ws:broken/x.js', 'ws:dirmanifest/dm.js', 'ws:emptyname/en.js', 'ws:nullws/nw.js', 'wsonly:w.js',
  ]), 'boundary/db: files rows carry the boundary that owns them and a path relative to ITS root');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// NEAREST-ancestor (longest-prefix) attribution. A file inside nested boundaries
// belongs to the INNERMOST one, and `relPath` is relative to THAT root — not to the
// project root and not to the outer compartment. Both halves matter: the compartment
// name and the relPath are the two components of every symbol id (src/model.js), and
// relPath is what get_source resolves against, so an off-by-one-ancestor error reads
// the wrong file. Asserted at the walk level AND at the db level (`files` rows), since
// nothing else in the suite pins the stored path against a nested compartment.
async function nearestAncestorAttributionTest() {
  const W = await import('../src/extract/walk.js');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-nearest-')));
  const proj = join(work, 'proj');
  mkdirSync(join(proj, '.git'), { recursive: true });               // root boundary
  mkdirSync(join(proj, 'outer', 'inner', 'sub'), { recursive: true });
  writeFileSync(join(proj, 'loose.js'), 'export function looseFn(){ return 1; }\n');
  writeFileSync(join(proj, 'outer', 'package.json'), '{"name":"outer"}');   // middle boundary
  writeFileSync(join(proj, 'outer', 'mid.js'), 'export function midFn(){ return 2; }\n');
  writeFileSync(join(proj, 'outer', 'inner', 'Cargo.toml'), '');            // innermost boundary
  writeFileSync(join(proj, 'outer', 'inner', 'deep.js'), 'export function deepFn(){ return 3; }\n');
  writeFileSync(join(proj, 'outer', 'inner', 'sub', 'deeper.js'), 'export function deeperFn(){ return 4; }\n');
  // An ignored dir THREE levels down, holding a boundary marker: the IGNORE_DIRS skip is
  // not a depth-1 rule, and a phantom `gen` compartment would show up in the db below.
  mkdirSync(join(proj, 'outer', 'inner', 'dist', 'gen'), { recursive: true });
  writeFileSync(join(proj, 'outer', 'inner', 'dist', 'gen', 'Cargo.toml'), '');
  writeFileSync(join(proj, 'outer', 'inner', 'dist', 'gen', 'gen.js'), 'export function genFn(){ return 5; }\n');

  const walked = Object.fromEntries([...W.walkSources(proj)].map((f) => [basename(f.abs), f]));
  eq(walked['loose.js']?.compartment, 'proj', 'nearest: a root-level file attributes to the root compartment');
  eq(walked['mid.js']?.compartment, 'outer', 'nearest: a file under outer/ attributes to outer, not the root');
  eq(walked['deep.js']?.compartment, 'inner', 'nearest: a file under outer/inner/ attributes to inner, not outer');
  eq(walked['deep.js']?.relPath, 'deep.js', 'nearest: relPath is relative to the NEAREST root (not outer/inner/deep.js)');
  eq(walked['deeper.js']?.relPath, join('sub', 'deeper.js'), 'nearest: a deeper file keeps its path below the nearest root');
  ok(!walked['gen.js'], 'nearest: a boundary buried three levels down inside dist/ is never walked');

  // Attribution through a SYMLINKED root. compartmentNameFor prefix-matches RAW absolute
  // strings (walk.js:81), so the file paths and the compartment roots must be expressed in
  // the same form; walking through a symlink is where the two can diverge. If one side
  // realpaths and the other does not, no prefix ever matches and every file silently falls
  // through to the root compartment (walk.js:86) — a total partition collapse with no
  // error anywhere. (walkSourcesTests covers symlink DEDUP, which is a different thing.)
  const alias = join(work, 'alias');
  symlinkSync(proj, alias);
  const viaLink = Object.fromEntries([...W.walkSources(alias)].map((f) => [basename(f.abs), f]));
  eq(viaLink['deep.js']?.compartment, 'inner', 'symlinked root: the innermost boundary still wins when walked through a symlink');
  eq(viaLink['deep.js']?.relPath, 'deep.js', 'symlinked root: relPath stays relative to the nearest root through the symlink');
  eq(viaLink['mid.js']?.compartment, 'outer', 'symlinked root: the middle boundary still wins over the root');
  eq(viaLink['loose.js']?.compartment, 'alias', 'symlinked root: the root compartment is named after the WALKED path, not the realpath');

  // Same picture once persisted: the stored `path` is the nearest-root-relative one.
  const db = join(work, 'graph.db');
  await runBuild({ target: proj, project: proj, db, reset: true });
  const conn = connect(db, { readonly: true });
  const comps = conn.prepare('SELECT name FROM compartments ORDER BY name').all().map((r) => r.name);
  eq(JSON.stringify(comps), JSON.stringify(['inner', 'outer', 'proj']), 'nearest/db: all three nested boundaries become compartments');
  const files = conn.prepare("SELECT compartment, path FROM files WHERE path LIKE '%.js' ORDER BY compartment, path").all()
    .map((r) => `${r.compartment}:${r.path}`);
  eq(JSON.stringify(files), JSON.stringify(['inner:deep.js', 'inner:sub/deeper.js', 'outer:mid.js', 'proj:loose.js']),
    'nearest/db: files rows carry the nearest compartment and a path relative to ITS root');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// --- declared compartments (`recursive` mode) --------------------------------
// Opt-in per project: compartments are DECLARED in the project's own state.json
// instead of being inferred from `.git` / a build manifest. findCompartmentRoots is
// the single funnel every consumer goes through, so the declaration has to carry
// attribution, relPath, every node id, the link guard and the init scope report with
// it — and a project with NO mode key has to behave exactly as it always did.
const COMPARTMENTS_CLI = join(HERE, '..', 'scripts', 'lib', 'compartments.mjs');

// Build a source tree at `root` from a { relPath: contents } map.
function mkSourceTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

// The graph's ATTRIBUTION as one comparable string: every symbol's (compartment, file,
// name), sorted. This is precisely what a partition change rewrites and what a missed
// prune duplicates, so "the healed graph equals a from-scratch build" is checkable on it.
function symbolPartitionOf(dbPath) {
  const db = connect(dbPath, { readonly: true });
  const rows = db.prepare('SELECT compartment, file, name FROM symbols ORDER BY compartment, file, name')
    .all().map((r) => `${r.compartment}:${r.file}:${r.name}`);
  db.close();
  return rows.join('\n');
}

// The SAME tree built from scratch in a pristine directory under the SAME basename — the
// basename is the compartment every file outside every boundary is attributed to, so a
// reference build has to keep it. `.wiregraph/` is left behind, so the reference shares
// nothing with the graph under test.
async function fromScratchPartition(root) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cg-scratch-')));
  const ref = join(base, basename(root));
  cpSync(root, ref, { recursive: true, filter: (s) => basename(s) !== '.wiregraph' });
  await runBuild({ target: ref, project: ref, reset: true });
  const out = symbolPartitionOf(join(ref, '.wiregraph', 'graph.db'));
  rmSync(base, { recursive: true, force: true });
  return out;
}

const ENGINE_SOURCES = {
  'server/ecs/ecs.js': 'export function ecsTick(){ return 1; }\n',
  'server/sim/sim.js': 'export function simStep(){ return 2; }\n',
  'client/net/net.js': 'export function netSend(){ return 3; }\n',
  'client/net/deep/wire.js': 'export function wireUp(){ return 4; }\n',
  'shared/util.js': 'export function sharedUtil(){ return 5; }\n',
};

async function declaredCompartmentsTest() {
  const W = await import('../src/extract/walk.js');
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-declared-')));
  const proj = join(work, 'engine');
  // DELIBERATELY no `.git` and no manifest anywhere: today's inference finds ZERO
  // boundaries in this tree, so any partition that appears below can only have come
  // from the declaration. (A tree that also had inferred boundaries would let a broken
  // declaration read as "working" off the inference.)
  mkSourceTree(proj, ENGINE_SOURCES);

  // --- legacy half: no mode key, no compartments key ⇒ byte-for-byte today ------
  eq(W.readDeclaration(proj), null, 'declared/legacy: a project with no state file carries no declaration');
  eq(JSON.stringify(W.findCompartmentRoots(proj)), '[]', 'declared/legacy: no .git and no manifest ⇒ inference finds no boundary');
  const legacyWalk = Object.fromEntries([...W.walkSources(proj)].map((f) => [basename(f.abs), f]));
  eq(legacyWalk['ecs.js']?.compartment, 'engine', 'declared/legacy: every file attributes to the root compartment');
  eq(legacyWalk['ecs.js']?.relPath, join('server', 'ecs', 'ecs.js'), 'declared/legacy: relPath is relative to the project root');

  const legacyDb = join(work, 'legacy.db');
  await runBuild({ target: proj, project: proj, db: legacyDb, reset: true });
  let conn = connect(legacyDb, { readonly: true });
  eq(JSON.stringify(conn.prepare('SELECT name FROM compartments ORDER BY name').all().map((r) => r.name)),
    JSON.stringify(['engine']), 'declared/legacy/db: one compartment, the root');
  eq(JSON.stringify(conn.prepare('SELECT compartment, path FROM files ORDER BY compartment, path').all().map((r) => `${r.compartment}:${r.path}`)),
    JSON.stringify(['engine:client/net/deep/wire.js', 'engine:client/net/net.js', 'engine:server/ecs/ecs.js', 'engine:server/sim/sim.js', 'engine:shared/util.js']),
    'declared/legacy/db: every file row is root-relative under the root compartment');
  conn.close();

  const legacyState = S.readState(proj);
  ok(!('mode' in legacyState), 'declared/legacy: a normal full build NEVER writes a mode key (the metricsVersion precedent)');
  eq(S.isRecursiveMode(legacyState), false, 'declared/legacy: an absent mode reads as global at the read site');
  eq(Object.keys(legacyState.compartmentsFingerprint).join(','), '.',
    'declared/legacy: the stamped fingerprint is a PER-ROOT map keyed RELATIVE to the project ("." for its own root), so a project move cannot orphan the baseline');
  ok(String(legacyState.compartmentsFingerprint['.']).startsWith('g1:'),
    'declared/legacy: an UNDECLARED root hashes the INFERRED partition it actually resolved — not a constant that could never move');
  eq(S.compartmentsDrift(legacyState.compartmentsFingerprint, S.compartmentsFingerprint([proj])), null,
    'declared/legacy: …and it matches the live partition immediately after the build, so nothing escalates');
  has(S.modeLine(legacyState), 'global — compartments inferred', 'declared/legacy: graph_status reports the global mode');
  ok(!S.modeLine(legacyState).includes('FULL REBUILD IS PENDING'),
    'declared/legacy: …with no pending-rebuild warning, because the graph does match the partition in force');

  // --- declare, through the real write path ------------------------------------
  const decl = [
    { path: 'server/ecs', name: 'ecs' },
    { path: 'server/sim', name: 'sim' },
    { path: 'client/net', name: 'client_net' },
  ];
  const { stdout: declOut } = await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', proj, JSON.stringify(decl)]);
  has(declOut, 'Wrote mode: recursive', 'declared: the declare CLI reports exactly what it wrote');
  has(declOut, 'client_net', 'declared: the report names each declared compartment');
  has(declOut, 'A full rebuild is REQUIRED', 'declared: the report says a full rebuild is required');
  has(declOut, 'INVALIDATES contract specs that name a compartment',
    'declared: the report surfaces that specs (which record compartment NAME strings) go stale');

  // graph_status's `Mode:` line is what an agent reads mid-session to know whether a
  // compartment name came from a declaration or from the walk.
  const mode = S.modeLine(S.readState(proj));
  has(mode, 'recursive — 3 compartment(s) DECLARED', 'declared: graph_status reports the recursive mode and the count');
  has(mode, 'ecs, sim, client_net', 'declared: the Mode line names the declared compartments');

  const declared = W.findCompartmentRoots(proj).map((r) => `${relative(proj, r.dir)}|${r.name}`).sort();
  eq(JSON.stringify(declared), JSON.stringify(['client/net|client_net', 'server/ecs|ecs', 'server/sim|sim']),
    'declared: findCompartmentRoots returns the DECLARED list in the same {dir,name} shape inference returns');

  const walk2 = Object.fromEntries([...W.walkSources(proj)].map((f) => [basename(f.abs), f]));
  eq(walk2['ecs.js']?.compartment, 'ecs', 'declared: a file under a declared root attributes to its DECLARED name');
  eq(walk2['ecs.js']?.relPath, 'ecs.js', 'declared: relPath is relative to the DECLARED root');
  eq(walk2['wire.js']?.compartment, 'client_net', 'declared: a name that is NOT the dir basename is used verbatim');
  eq(walk2['wire.js']?.relPath, join('deep', 'wire.js'), 'declared: a deeper file keeps its path below the declared root');
  eq(walk2['util.js']?.compartment, 'engine', 'declared: a file under NO declared root still falls back to the project root');
  eq(walk2['util.js']?.relPath, join('shared', 'util.js'), 'declared: the fallback relPath stays relative to the project root');

  // A declaration change re-partitions every id, so the graph is only queryable again
  // after a FULL rebuild — which is safe by construction (runBuild always resets).
  const declDb = join(work, 'declared.db');
  await runBuild({ target: proj, project: proj, db: declDb, reset: true });
  conn = connect(declDb, { readonly: true });
  eq(JSON.stringify(conn.prepare('SELECT name FROM compartments ORDER BY name').all().map((r) => r.name)),
    JSON.stringify(['client_net', 'ecs', 'engine', 'sim']),
    'declared/db: the declared names plus the root fallback become the compartment rows');
  eq(JSON.stringify(conn.prepare('SELECT compartment, path FROM files ORDER BY compartment, path').all().map((r) => `${r.compartment}:${r.path}`)),
    JSON.stringify(['client_net:deep/wire.js', 'client_net:net.js', 'ecs:ecs.js', 'engine:shared/util.js', 'sim:sim.js']),
    'declared/db: each file row carries its DECLARED compartment and a path relative to THAT root');
  conn.close();

  // --- symlinked declared root -------------------------------------------------
  // compartmentNameFor prefix-matches RAW ABSOLUTE STRINGS against paths walkOneRoot
  // builds by join()ing down from the walked root. Declared paths are stored RELATIVE
  // and must be resolved LEXICALLY against that same walked root — realpath'ing them
  // would collapse a symlinked root to a different string, every prefix match would
  // fail, and EVERY file would fall through to the root compartment with no error and
  // no count change. That is the failure this pins.
  const alias = join(work, 'alias');
  symlinkSync(proj, alias);
  const aliasRoots = W.findCompartmentRoots(alias);
  eq(aliasRoots.length, 3, 'declared/symlink: the declaration is still read through a symlinked root');
  ok(aliasRoots.every((r) => r.dir.startsWith(alias + '/')),
    'declared/symlink: declared dirs resolve under the WALKED path, never the realpath');
  const walk3 = Object.fromEntries([...W.walkSources(alias)].map((f) => [basename(f.abs), f]));
  eq(walk3['ecs.js']?.compartment, 'ecs', 'declared/symlink: attribution survives a symlinked root (no partition collapse)');
  eq(walk3['ecs.js']?.relPath, 'ecs.js', 'declared/symlink: relPath stays relative to the declared root through the symlink');
  eq(walk3['wire.js']?.compartment, 'client_net', 'declared/symlink: the nested declared root still wins through the symlink');
  eq(walk3['util.js']?.compartment, 'alias', 'declared/symlink: the fallback compartment is named after the WALKED path, not the realpath');

  // --- null vs [] --------------------------------------------------------------
  // `null` = not declared (fall through to inference); `[]` = DECLARED EMPTY (no
  // sub-compartments at all). Proven on a tree that DOES have an inferred boundary,
  // so the two answers actually differ.
  const proj2 = join(work, 'ws');
  mkSourceTree(proj2, { 'pkg/a.js': 'export function aFn(){ return 1; }\n', 'root.js': 'export function rootFn(){ return 2; }\n' });
  writeFileSync(join(proj2, 'pkg', 'package.json'), '{"name":"pkg"}');
  eq(JSON.stringify(W.findCompartmentRoots(proj2).map((r) => r.name)), JSON.stringify(['pkg']),
    'declared/empty: with no declaration the package.json boundary is inferred as always');
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', proj2, '[]', '--new']);
  eq(JSON.stringify(W.findCompartmentRoots(proj2)), '[]',
    'declared/empty: a DECLARED EMPTY list suppresses inference entirely — [] is not null');
  const walk4 = Object.fromEntries([...W.walkSources(proj2)].map((f) => [basename(f.abs), f]));
  eq(walk4['a.js']?.compartment, 'ws', 'declared/empty: every file attributes to the root when the declaration is empty');

  // A hand-mangled declaration degrades to inference rather than breaking a build.
  S.updateState(proj2, { compartments: 'not-an-array' });
  eq(JSON.stringify(W.findCompartmentRoots(proj2).map((r) => r.name)), JSON.stringify(['pkg']),
    'declared: a non-array compartments value is treated as UNDECLARED, falling through to inference');

  rmSync(work, { recursive: true, force: true });
}

// Declare-time validation. Every rejection here is a failure that is SILENT once it
// reaches the graph, which is why they are hard errors and not warnings.
async function declaredCompartmentValidationTest() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-declvalid-')));
  const proj = join(work, 'engine');
  mkSourceTree(proj, ENGINE_SOURCES);
  mkSourceTree(join(work, 'outside'), { 'x.js': 'export function xFn(){ return 1; }\n' });
  mkdirSync(join(proj, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(proj, 'notadir.js'), 'export function nFn(){ return 1; }\n');

  // `validate` is the dry run — same code path as `declare`, writes nothing.
  const check = async (list) => {
    try {
      const { stdout } = await execFileP(process.execPath, [COMPARTMENTS_CLI, 'validate', proj, JSON.stringify(list)]);
      return { ok: true, out: stdout };
    } catch (e) {
      return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };

  const good = await check([{ path: 'server/ecs', name: 'ecs' }, { path: 'client/net', name: 'client_net' }]);
  ok(good.ok, 'declvalid: a well-formed declaration validates');
  has(good.out, '(dry run — nothing written)', 'declvalid: validate writes nothing');

  // 1. Two compartments sharing a NAME. compartmentId is name-only, so they collapse
  //    into one row via INSERT OR REPLACE keeping whichever `root` landed last — and
  //    then relPaths computed against the OTHER root resolve under it, so get_source
  //    reads the WRONG FILE. canLink guards this across members; nothing guarded it
  //    within a root.
  const dupName = await check([{ path: 'server/ecs', name: 'core' }, { path: 'client/net', name: 'core' }]);
  ok(!dupName.ok, 'declvalid: two compartments sharing a name are REJECTED');
  has(dupName.out, 'is claimed by 2 different roots', 'declvalid: the name-collision message names the cause');
  has(dupName.out, 'Nothing was written', 'declvalid: a rejected declaration writes nothing');

  // The ROOT FALLBACK is a compartment too: any file under no declared root attributes
  // to basename(project), so a declared name equal to the project basename collides in
  // exactly the same way.
  const rootClash = await check([{ path: 'server/ecs', name: 'engine' }]);
  ok(!rootClash.ok, 'declvalid: a declared name equal to the project basename collides with the ROOT fallback compartment');
  has(rootClash.out, 'the fallback compartment for every undeclared file', 'declvalid: the root-fallback collision is explained');

  // 2. Under IGNORE_DIRS — the walk never descends there, so the compartment would be
  //    permanently empty.
  const ignored = await check([{ path: 'node_modules/pkg', name: 'vendored' }]);
  ok(!ignored.ok, 'declvalid: a path under IGNORE_DIRS is REJECTED');
  has(ignored.out, 'wiregraph never walks', 'declvalid: the IGNORE_DIRS message says the walk never reaches it');

  // 3. Does not exist / is not a directory.
  const missing = await check([{ path: 'server/nope', name: 'nope' }]);
  ok(!missing.ok, 'declvalid: a path that does not exist is REJECTED');
  has(missing.out, 'does not exist', 'declvalid: the missing-path message says so');
  const notDir = await check([{ path: 'notadir.js', name: 'notadir' }]);
  ok(!notDir.ok, 'declvalid: a path that is not a directory is REJECTED');
  has(notDir.out, 'is not a directory', 'declvalid: the not-a-directory message says so');

  // 4. Outside the project root — both spellings.
  const outside = await check([{ path: '../outside', name: 'outside' }]);
  ok(!outside.ok, 'declvalid: a path that escapes the project root is REJECTED');
  has(outside.out, 'resolves outside the project root', 'declvalid: the escape message says so');
  const absolute = await check([{ path: join(proj, 'server', 'ecs'), name: 'ecs' }]);
  ok(!absolute.ok, 'declvalid: an ABSOLUTE path is REJECTED');
  has(absolute.out, 'must be RELATIVE', 'declvalid: the absolute-path message explains the rename hazard');

  // Shape / id-safety.
  const badName = await check([{ path: 'server/ecs', name: 'a:b' }]);
  ok(!badName.ok, 'declvalid: a name containing an id separator is REJECTED');
  const badShape = await check([{ path: 'server/ecs' }]);
  ok(!badShape.ok, 'declvalid: an entry with no name is REJECTED');
  const notArray = await check({ path: 'server/ecs', name: 'ecs' });
  ok(!notArray.ok, 'declvalid: a non-array declaration is REJECTED');

  // Nothing above may have written a declaration.
  const S = await import('../scripts/lib/state.mjs');
  eq(S.readState(proj), null, 'declvalid: not one rejected (or dry-run) validation created a state file');

  rmSync(work, { recursive: true, force: true });
}

// A declaration change forces a FULL rebuild. Compartment name is embedded in every id
// and relPath is relative to the compartment root, so re-partitioning changes BOTH
// components of every affected id. A full build is safe by construction (it always
// resets); an incremental is unsafe AND SILENT — build.js computes {compartment,
// relPath} from the CURRENT boundaries, then pruneFile deletes by (project,
// compartment, file), so the prune MISSES, old rows survive under the old compartment
// and new rows insert: duplicate symbols under two compartments plus orphaned CALLS
// edges. Nothing detected this before; these are both halves of the detection.
async function compartmentsFingerprintTest() {
  const S = await import('../scripts/lib/state.mjs');
  const G = await import('../scripts/lib/git.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-fingerprint-')));
  const proj = join(work, 'engine');
  mkSourceTree(proj, ENGINE_SOURCES);
  const db = join(work, 'graph.db');
  const anyFile = join(proj, 'server', 'ecs', 'ecs.js');

  // --- undeclared: the check is quiet while the PARTITION does not move ---------
  // It is NOT inert any more, and must not be: an undeclared root's partition is
  // INFERRED FROM DISK, and disk changes (see globalPartitionDriftTest).
  await runBuild({ target: proj, project: proj, db, reset: true });
  eq(JSON.stringify(S.readState(proj).compartmentsFingerprint), JSON.stringify(S.compartmentsFingerprint([proj])),
    'fingerprint/legacy: an undeclared union stamps the INFERRED partition it resolved, keyed relative to the project');
  let c = G.changedSince(proj, S.readState(proj).reposLastSha || {});
  eq(c.fullBuildNeeded, false, 'fingerprint/legacy: an undeclared project whose boundaries did not move never escalates');
  await runBuild({ target: proj, project: proj, db, files: [anyFile] });
  ok(true, 'fingerprint/legacy: an incremental on such a project is never refused');
  // …and ORDINARY SOURCE EDITS never move it. Only the BOUNDARY set does; hashing anything
  // wider would escalate every save to a full rebuild.
  const beforeEdit = S.compartmentsFingerprint([proj])['.'];
  writeFileSync(join(proj, 'shared', 'util.js'), 'export function sharedUtil(){ return 55; }\nexport function extra(){ return 1; }\n');
  writeFileSync(join(proj, 'shared', 'brand.js'), 'export function brandNew(){ return 1; }\n');
  eq(S.compartmentsFingerprint([proj])['.'], beforeEdit,
    'fingerprint/legacy: adding and editing ordinary source files does NOT move the partition value');

  // --- declared: stamped at the full build -------------------------------------
  const d1 = [{ path: 'server/ecs', name: 'ecs' }, { path: 'client/net', name: 'client_net' }];
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', proj, JSON.stringify(d1)]);
  // The stamp is deliberately NOT reset by `declare` — leaving the OLD value in place
  // is exactly what makes the change detectable before the rebuild happens.
  c = G.changedSince(proj, S.readState(proj).reposLastSha || {});
  eq(c.fullBuildNeeded, true, 'fingerprint: declaring compartments escalates the next catch-up to a full rebuild');
  has(c.fullBuildReasons.join('; '), 'the compartment partition changed', 'fingerprint: the escalation names the reason');

  let refused = null;
  try { await runBuild({ target: proj, project: proj, db, files: [anyFile] }); }
  catch (e) { refused = e.message; }
  ok(refused !== null, 'fingerprint: an incremental against a changed declaration is REFUSED outright');
  has(refused, 'the compartment partition changed since the last full build', 'fingerprint: the refusal explains what changed');
  has(refused, 'full rebuild', 'fingerprint: the refusal names the fix');

  await runBuild({ target: proj, project: proj, db, reset: true });
  const f1 = S.readState(proj).compartmentsFingerprint;
  ok(f1 && String(f1['.']).startsWith('r1:'), 'fingerprint: a full build in recursive mode stamps a DECLARED-partition fingerprint (r1:), distinct by prefix from an inferred one');
  c = G.changedSince(proj, S.readState(proj).reposLastSha || {});
  eq(c.fullBuildNeeded, false, 'fingerprint: the rebuild restamps, so the next catch-up is quiet again');
  await runBuild({ target: proj, project: proj, db, files: [anyFile] });
  ok(true, 'fingerprint: an incremental is allowed once the stamp matches the declaration');

  // --- a RENAME of one compartment is a partition change -----------------------
  const d2 = [{ path: 'server/ecs', name: 'ecs' }, { path: 'client/net', name: 'netcode' }];
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', proj, JSON.stringify(d2)]);
  ok(S.compartmentsFingerprint([proj])['.'] !== f1['.'], 'fingerprint: renaming a declared compartment moves the fingerprint');
  eq(G.changedSince(proj, S.readState(proj).reposLastSha || {}).fullBuildNeeded, true,
    'fingerprint: a rename-only declaration change still escalates');
  await runBuild({ target: proj, project: proj, db, reset: true });
  const f2 = S.readState(proj).compartmentsFingerprint;

  // --- adding a compartment, and dropping back to global -----------------------
  const d3 = [...d2, { path: 'server/sim', name: 'sim' }];
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', proj, JSON.stringify(d3)]);
  ok(S.compartmentsFingerprint([proj])['.'] !== f2['.'], 'fingerprint: adding a compartment moves the fingerprint');
  await runBuild({ target: proj, project: proj, db, reset: true });
  const f3 = S.readState(proj).compartmentsFingerprint;

  const { stdout: clearOut } = await execFileP(process.execPath, [COMPARTMENTS_CLI, 'clear', proj]);
  has(clearOut, 'mode is now global', 'fingerprint: clearing reports the mode change');
  eq(S.isRecursiveMode(S.readState(proj)), false, 'fingerprint: clearing drops back to the global mode');
  const cleared = S.compartmentsFingerprint([proj])['.'];
  ok(String(cleared).startsWith('g1:'), 'fingerprint: an un-declared project is back on the INFERRED partition (g1:), which is hashed, not asserted to be a constant');
  ok(f3['.'] !== cleared, 'fingerprint: ...which differs from the stamp the declared build left behind, so un-declaring is detected');
  ok(S.compartmentsDrift(f3, S.compartmentsFingerprint([proj])) !== null,
    'fingerprint: ...and reads as DRIFT, because a declared partition can never hash equal to an inferred one (different prefixes)');

  // --- NORMALISATION: one partition, ONE fingerprint (M9a) ---------------------
  // `declare` normalises, but state.json is hand-editable, and `pkg`, `pkg/` and
  // `pkg/../pkg` all name the same directory. Hashing the RAW string gave three
  // fingerprints for one identical partition and forced a rebuild that changed nothing.
  const spellings = ['server/sim', 'server/sim/', 'server/./sim', 'server/ecs/../sim'];
  const spelled = spellings.map((sp) => {
    S.updateState(proj, { mode: 'recursive', compartments: [{ path: sp, name: 'sim' }] });
    return S.compartmentsFingerprint([proj])['.'];
  });
  eq(new Set(spelled).size, 1, 'fingerprint: four spellings of ONE declared path give ONE fingerprint (the path is normalised before hashing)');
  ok(String(spelled[0]).startsWith('r1:'), 'fingerprint: ...and that one fingerprint is a real DECLARED value, not the inferred fallback');

  // --- COLLISION: a name may not forge a field boundary (M9b) ------------------
  // The old encoding joined (path, name) pairs with NUL/SOH/STX and asserted those bytes
  // could not occur in a name — but the name rule only rejected [:/\\]. Measured:
  // [{server/ecs,n1},{server/sim,n2}] and [{server/ecs,"n1<SOH>server/sim<STX>n2"}] hashed
  // IDENTICALLY, so a real partition change escaped the guard entirely.
  S.updateState(proj, { mode: 'recursive', compartments: [{ path: 'server/ecs', name: 'n1' }, { path: 'server/sim', name: 'n2' }] });
  const two = S.compartmentsFingerprint([proj])['.'];
  const forged = 'n1\u0001server/sim\u0002n2';
  S.updateState(proj, { mode: 'recursive', compartments: [{ path: 'server/ecs', name: forged }] });
  const one = S.compartmentsFingerprint([proj])['.'];
  ok(two !== one, 'fingerprint: a name carrying the old separator bytes cannot collide a two-compartment partition with a one-compartment one');
  ok(String(one).startsWith('g1:'), 'fingerprint: ...because a control character in a name is now REJECTED outright, so that declaration is unusable and the root falls back to inference');
  const cli = await execFileP(process.execPath, [COMPARTMENTS_CLI, 'validate', proj, JSON.stringify([{ path: 'server/ecs', name: forged }])]).then(() => null, (e) => `${e.stdout || ''}${e.stderr || ''}`);
  has(cli, 'control character', 'fingerprint: and the WRITE path rejects the same name with the same rule');
  eq(G.changedSince(proj, S.readState(proj).reposLastSha || {}).fullBuildNeeded, true,
    'fingerprint: dropping the declaration escalates too — un-declaring re-partitions every file just as declaring did');

  // --- the stamp is a BASELINE, never a verdict --------------------------------
  // A project last built before this key existed has no stamp. Reading absent as
  // "changed" would force a full rebuild of every such project on its very next
  // catch-up — the same trap schemaOutdated() documents for its 0 stamp.
  S.updateState(proj, { compartmentsFingerprint: null, mode: 'recursive', compartments: d3 });
  eq(G.changedSince(proj, S.readState(proj).reposLastSha || {}).fullBuildNeeded, false,
    'fingerprint: an ABSENT stamp means "no baseline", never "changed"');
  await runBuild({ target: proj, project: proj, db, files: [anyFile] });
  ok(true, 'fingerprint: an incremental with no stamped baseline is not refused');

  // A root with no ENTRY is the same "no baseline" case as a null stamp — that is what
  // makes a newly linked member (and a member unmounted at the last full build) safe.
  // THERE IS NO 'global' CONSTANT any more, for the same reason §14 removed the contracts
  // one: it exempted the DEFAULT mode from the entire guard, and its ~10 assertions only
  // ever asserted that the constant was the constant.
  eq(S.GLOBAL_COMPARTMENTS_FINGERPRINT, undefined,
    'fingerprint: the inferred-partition CONSTANT is gone — "the declaration cannot change" never implied "the partition cannot change"');

  eq(S.compartmentsDrift({ '/some/other/root': 'g1:whatever' }, S.compartmentsFingerprint([proj])), null,
    'fingerprint: a root the stamp has never seen is "no baseline", not "changed"');
  // WAS `eq(…, null, '…treated as no baseline, not as a mismatch')`. That WAS the defect: a
  // PRESENT but malformed value is not an ABSENT one, and failing open on it silently
  // disarmed the guard (see fingerprintDrift). Absent still fails open; a scalar fails SAFE.
  ok(S.compartmentsDrift('r1:legacyscalar', S.compartmentsFingerprint([proj])),
    'fingerprint: a stamp that is not a per-root map at all is MALFORMED and fails SAFE — only an ABSENT stamp means "no baseline"');

  rmSync(work, { recursive: true, force: true });
}

// B1 — A FINGERPRINT MAY ONLY BE STAMPED AFTER THE GRAPH IS WRITTEN.
//
// Both fingerprints assert "the graph in the db was built against THIS partition". Only a
// full build may assert it, and the old code read that entitlement as belonging to the
// ATTEMPT rather than to the COMPLETION: it stamped both values ~25 lines before the db
// was even opened, under a comment claiming a full build "is the only operation that is
// safe by construction". Any throw in between left state asserting the graph matched the
// NEW partition over a db still holding the OLD one — which does not merely miss one
// update, it PERMANENTLY disarms both guards. Observed with a 1 -> 2 compartment change
// and a full build that failed at the db open:
//   FP after good build:   {".":"r1:b9493ec5…"}
//   FP after FAILED build: {".":"r1:727348b6…"}   <- the NEW partition
//   compartmentsDrift now => null
// and then one ordinary save produced a live WIRE seam into a compartment that no longer
// existed, which trace_contract reported as real.
//
// Every failure point below is reachable in ordinary use, and the last one is the worst:
// loadGraph's member-losing-reset backstop exists to PREVENT corruption, and its firing
// used to corrupt the baseline instead.
async function stampFollowsWriteTest() {
  const S = await import('../scripts/lib/state.mjs');
  const G = await import('../scripts/lib/git.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-stampwrite-')));
  const proj = join(work, 'engine');
  mkSourceTree(proj, ENGINE_SOURCES);
  const db = join(proj, '.wiregraph', 'graph.db');
  const anyFile = join(proj, 'server', 'ecs', 'ecs.js');

  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', proj,
    JSON.stringify([{ path: 'server/ecs', name: 'ecs' }]), '--new']);
  mkdirSync(join(proj, 'contracts'), { recursive: true });
  writeFileSync(join(proj, 'contracts', 'a.asyncapi.yaml'),
    'asyncapi: 3.0.0\ninfo: { title: Stamp A, version: 1.0.0 }\nchannels:\n  c: { address: /api/one }\n');
  await runBuild({ target: proj, project: proj, db, reset: true });
  const good = S.readState(proj).compartmentsFingerprint;
  const goodK = S.readState(proj).contractsFingerprint;
  ok(String(good['.']).startsWith('r1:'), 'stampwrite: the baseline full build stamped the declared partition');
  ok(String(goodK['.']).startsWith('k2:'), 'stampwrite: ...and the resolved spec set');

  // Change BOTH partitions. The db on disk still holds the old ones.
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', proj,
    JSON.stringify([{ path: 'server/ecs', name: 'ecs' }, { path: 'client/net', name: 'netcode' }])]);
  writeFileSync(join(proj, 'contracts', 'b.asyncapi.yaml'),
    'asyncapi: 3.0.0\ninfo: { title: Stamp B, version: 1.0.0 }\nchannels:\n  c: { address: /api/two }\n');
  ok(S.compartmentsFingerprint([proj])['.'] !== good['.'], 'stampwrite: the declaration change moves the live partition value');
  ok(S.contractsFingerprint([proj])['.'] !== goodK['.'], 'stampwrite: ...and the added spec moves the live spec-set value');

  // graph_status must SAY so. modeLine used to recite the declaration as fact — observed
  // `2 compartment(s) DECLARED …: ecs, netcode` with `advisories: []` while the db held
  // ["ecs","engine"]. compartmentsDrift already knew at that moment.
  const line = S.modeLine(S.readState(proj));
  has(line, '2 compartment(s) DECLARED', 'stampwrite/modeline: the Mode line still reports the declaration');
  has(line, 'FULL REBUILD IS PENDING', 'stampwrite/modeline: ...and now also says the graph was NOT built against it');

  const stillArmed = async (label) => {
    const st = S.readState(proj) || {};
    eq((st.compartmentsFingerprint || {})['.'], good['.'],
      `stampwrite/${label}: the compartments stamp still records the partition the DB actually holds`);
    eq((st.contractsFingerprint || {})['.'], goodK['.'],
      `stampwrite/${label}: ...and so does the contracts stamp`);
    ok(S.compartmentsDrift(st.compartmentsFingerprint, S.compartmentsFingerprint([proj])) !== null,
      `stampwrite/${label}: ...so the partition guard is still ARMED (it read null after the failed build)`);
    ok(S.contractsDrift(st.contractsFingerprint, S.contractsFingerprint([proj])) !== null,
      `stampwrite/${label}: ...and so is the contract-scope guard`);
    eq(G.changedSince(proj, st.reposLastSha || {}).fullBuildNeeded, true,
      `stampwrite/${label}: ...the catch-up still escalates to a full rebuild`);
    let refused = null;
    try { await runBuild({ target: proj, project: proj, db, files: [anyFile] }); } catch (e) { refused = e.message; }
    ok(refused !== null, `stampwrite/${label}: ...and an incremental is still REFUSED outright`);
  };
  const failsWith = async (label, opts, needle) => {
    let threw = null;
    try { await runBuild({ target: proj, project: proj, db, reset: true, ...opts }); } catch (e) { threw = e.message; }
    ok(threw !== null, `stampwrite/${label}: the full build FAILS here (this is the injected failure point)`);
    if (needle) has(threw || '', needle, `stampwrite/${label}: ...for the expected reason`);
    await stillArmed(label);
  };

  // 1. The db path cannot be created/written — the ENOSPC / EACCES class, injected here as
  //    an ENOTDIR because it is deterministic and needs no privileges.
  writeFileSync(join(work, 'blocker'), 'not a directory\n');
  await failsWith('db-path-unusable', { db: join(work, 'blocker', 'graph.db') }, null);

  // 2. The <db>.lock cannot be CREATED. connect() takes the lock BEFORE reading the db, so
  //    this fails earlier than any graph work. Injected as a read-only .wiregraph/ (EACCES
  //    on the lock create), which is the same class as a full or read-only filesystem.
  //    (Do NOT inject this by putting a DIRECTORY at <db>.lock: acquireLock's EEXIST branch
  //    then reads the path, hits EISDIR, and `continue`s past its own deadline check —
  //    an unbounded spin. Reported separately; src/store/sqlite.js is not this wave's file.)
  chmodSync(join(proj, '.wiregraph'), 0o555);
  await failsWith('lock-unavailable', {}, null);
  chmodSync(join(proj, '.wiregraph'), 0o755);

  // 3. loadGraph's NEWER-SCHEMA refusal — a db written by a newer wiregraph must never be
  //    downgraded, so the load throws after connect() succeeded.
  {
    const conn = connect(db);
    conn.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '99')");
    conn.close();
  }
  await failsWith('newer-schema', {}, 'newer than this wiregraph');
  {
    const conn = connect(db);
    conn.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')`);
    conn.close();
  }

  // 4. loadGraph's MEMBER-LOSING-RESET backstop — the worst of the four, because this guard
  //    exists to prevent corruption and its firing used to cause a different one.
  const member = join(work, 'member');
  mkSourceTree(member, { 'm.js': 'export function memberFn(){ return 1; }\n' });
  S.addLink(proj, { root: member, peer: member, initiator: proj });
  await failsWith('member-losing-reset', { roots: [proj] }, 'refusing to --reset');
  S.removeLink(proj, member);

  // 5. --no-load writes NO db at all, so it may not stamp either: there is nothing new for
  //    the stamp to be true ABOUT.
  await runBuild({ target: proj, project: proj, db, reset: true, load: false });
  await stillArmed('no-load');

  // POSITIVE CONTROL: a build that COMPLETES does stamp, and disarms both guards.
  await runBuild({ target: proj, project: proj, db, reset: true });
  const after = S.readState(proj);
  ok((after.compartmentsFingerprint || {})['.'] !== good['.'], 'stampwrite: a COMPLETED full build restamps the partition');
  ok((after.contractsFingerprint || {})['.'] !== goodK['.'], 'stampwrite: ...and the spec set');
  eq(S.compartmentsDrift(after.compartmentsFingerprint, S.compartmentsFingerprint([proj])), null,
    'stampwrite: ...so the next update is cheap again');
  eq(S.contractsDrift(after.contractsFingerprint, S.contractsFingerprint([proj])), null, 'stampwrite: ...both of them');
  ok(!S.modeLine(after).includes('FULL REBUILD IS PENDING'), 'stampwrite: ...and the Mode line drops the pending warning');
  await runBuild({ target: proj, project: proj, db, files: [anyFile] });
  ok(true, 'stampwrite: ...and an incremental is accepted again');

  rmSync(work, { recursive: true, force: true });
}

// B2 — THE INFERRED PARTITION IS FINGERPRINTED TOO, and global is the DEFAULT mode.
//
// The per-root value for an undeclared root used to be the literal 'global', justified as
// "a legacy project's partition is not declared, so it cannot be declared differently" —
// true about the DECLARATION, false about the PARTITION. Inference reads DISK, and disk
// changes. §14 removed the identical simplification from the contracts fingerprint and
// never re-applied the argument to the fingerprint it was learned FROM.
//
// Reproduced on a plain global project: full build, then `echo '{"name":"subpkg"}' >
// sub/package.json` (src/extract/walk.js makes that a compartment boundary), then ONE
// ordinary save of sub/b.js:
//   compartmentsDrift => null            # nothing escalates, nothing refuses
//   SYMBOLS  sym:proj:sub/b.js:betaFn:1  # ghost, under the OLD compartment
//            sym:sub:b.js:betaFn:1
// Reachable from `npm init` in a subdirectory, `cargo new`, `go mod init`, adding a
// workspace package, or a `git clone` that brings in a submodule. SELF-HEAL: NEVER, because
// a manifest is not a source file and langForFile filters it out of changedSince.
async function globalPartitionDriftTest() {
  const S = await import('../scripts/lib/state.mjs');
  const G = await import('../scripts/lib/git.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-globaldrift-')));
  const proj = join(work, 'proj');
  const SOURCES = {
    'a.js': 'export function alphaFn(){ return 1; }\n',
    'sub/b.js': 'export function betaFn(){ return 2; }\n',
  };
  mkSourceTree(proj, SOURCES);
  const db = join(proj, '.wiregraph', 'graph.db');
  const manifest = join(proj, 'sub', 'package.json');
  const edited = join(proj, 'sub', 'b.js');
  const compartmentsOf = () => {
    const conn = connect(db, { readonly: true });
    try { return conn.prepare('SELECT name FROM compartments ORDER BY name').all().map((r) => r.name); }
    finally { conn.close(); }
  };
  const betaRows = () => {
    const conn = connect(db, { readonly: true });
    try { return conn.prepare("SELECT compartment, file FROM symbols WHERE name = 'betaFn' ORDER BY compartment").all().map((r) => `${r.compartment}:${r.file}`); }
    finally { conn.close(); }
  };

  await runBuild({ target: proj, project: proj, db, reset: true });
  eq(JSON.stringify(compartmentsOf()), JSON.stringify(['proj']), 'globaldrift: the baseline graph has ONE compartment, the root');
  const stamped = S.readState(proj).compartmentsFingerprint;
  ok(String(stamped['.']).startsWith('g1:'), 'globaldrift: a global project stamps a REAL hash of the boundaries it inferred');

  // --- A MANIFEST APPEARS (npm init in a subdirectory) -------------------------
  writeFileSync(manifest, JSON.stringify({ name: 'subpkg' }) + '\n');
  const drift = S.compartmentsDrift(stamped, S.compartmentsFingerprint([proj]));
  ok(drift !== null, 'globaldrift/add: a new build manifest re-partitions the tree and MOVES the fingerprint (the constant could not move at all)');
  const c = G.changedSince(proj, S.readState(proj).reposLastSha || {});
  eq(c.fullBuildNeeded, true, 'globaldrift/add: ...so the catch-up escalates to a full rebuild');
  has(c.fullBuildReasons.join('; '), 'the compartment partition changed', 'globaldrift/add: ...naming the partition as the reason');
  ok(!c.files.some((f) => f.endsWith('package.json')),
    'globaldrift/add: and the manifest itself is NOT in the changed-file list — which is exactly why this case never self-healed');

  let refused = null;
  try { await runBuild({ target: proj, project: proj, db, files: [edited] }); } catch (e) { refused = e.message; }
  ok(refused !== null, 'globaldrift/add: one ordinary save is REFUSED instead of half-pruning');
  eq(JSON.stringify(betaRows()), JSON.stringify(['proj:sub/b.js']),
    'globaldrift/add: ...so betaFn still exists exactly ONCE, under the compartment the graph was built with');
  has(S.modeLine(S.readState(proj)), 'FULL REBUILD IS PENDING',
    'globaldrift/add: ...and graph_status says a rebuild is pending instead of reporting the mode as if nothing moved');

  await runBuild({ target: proj, project: proj, db, reset: true });
  eq(JSON.stringify(compartmentsOf()), JSON.stringify(['proj', 'sub']), 'globaldrift/add: the full rebuild adopts the new boundary');
  eq(JSON.stringify(betaRows()), JSON.stringify(['sub:b.js']), 'globaldrift/add: ...with betaFn under it exactly once');
  eq(S.compartmentsDrift(S.readState(proj).compartmentsFingerprint, S.compartmentsFingerprint([proj])), null,
    'globaldrift/add: ...and the restamp makes the next update cheap again');

  // --- THE SYMMETRIC CASE: THE MANIFEST IS REMOVED -----------------------------
  const stamped2 = S.readState(proj).compartmentsFingerprint;
  rmSync(manifest, { force: true });
  ok(S.compartmentsDrift(stamped2, S.compartmentsFingerprint([proj])) !== null,
    'globaldrift/remove: deleting the manifest collapses the two compartments back into one, and that moves the fingerprint too');
  refused = null;
  try { await runBuild({ target: proj, project: proj, db, files: [edited] }); } catch (e) { refused = e.message; }
  ok(refused !== null, 'globaldrift/remove: the save is refused in this direction as well');
  eq(JSON.stringify(betaRows()), JSON.stringify(['sub:b.js']), 'globaldrift/remove: ...leaving the graph exactly as the last full build left it');
  await runBuild({ target: proj, project: proj, db, reset: true });
  eq(JSON.stringify(compartmentsOf()), JSON.stringify(['proj']), 'globaldrift/remove: the rebuild collapses it back');
  eq(JSON.stringify(betaRows()), JSON.stringify(['proj:sub/b.js']), 'globaldrift/remove: ...with one betaFn row');

  // --- WHAT THE GUARD PREVENTS, demonstrated ----------------------------------
  // Clearing the stamp is precisely the state the constant produced: a value that cannot
  // move, so the comparison can never fire. The SAME save then corrupts the graph.
  writeFileSync(manifest, JSON.stringify({ name: 'subpkg' }) + '\n');
  S.updateState(proj, { compartmentsFingerprint: null });
  await runBuild({ target: proj, project: proj, db, files: [edited] });
  eq(JSON.stringify(betaRows()), JSON.stringify(['proj:sub/b.js', 'sub:b.js']),
    'globaldrift/corruption: with no usable baseline the very same save leaves betaFn under BOTH compartments — the ghost the guard now prevents');

  rmSync(work, { recursive: true, force: true });
}

// H2 — A PROJECT MOVE MUST NOT DISARM EITHER GUARD.
//
// §14 required the contracts fingerprint to be rename-stable and the code comment claimed
// it had been done ("The old value keyed on ABSOLUTE paths… this now matches
// compartmentsFingerprint"). Only the VALUES were made relative; the map KEY was still the
// absolute root in BOTH fingerprints, so after `mv proj proj2` every key moved,
// fingerprintDrift's `was === undefined` skip fired for every root, and both guards went
// dark:  stamped {".../proj":"k2:35f5…"}  live {".../proj2":"k2:35f5…"}  drift => null.
// The A/B below is the same edit either way — only the move differs.
async function fingerprintRenameKeyTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-fprename-')));
  const proj = join(work, 'proj');
  const spec = 'asyncapi: 3.0.0\ninfo: { title: Rename Wire, version: 1.0.0 }\nchannels:\n  c: { address: /api/thing }\n';
  const build = async (root) => runBuild({ target: root, project: root, reset: true });
  const save = async (root) => {
    let refused = null;
    try { await runBuild({ target: root, project: root, files: [join(root, 'a.js')] }); } catch (e) { refused = e.message; }
    return refused;
  };

  mkSourceTree(proj, { 'a.js': 'export function alphaFn(){ return 1; }\n' });
  mkSourceTree(proj, { 'contracts/w.asyncapi.yaml': spec });
  await build(proj);
  const stampedC = S.readState(proj).compartmentsFingerprint;
  const stampedK = S.readState(proj).contractsFingerprint;
  eq(Object.keys(stampedC).join(','), '.', 'fprename: the compartments map is keyed "." — the project\'s own root, spelled relative');
  eq(Object.keys(stampedK).join(','), '.', 'fprename: ...and so is the contracts map');

  // A — no move. Deleting a spec is a real change and is correctly refused.
  rmSync(join(proj, 'contracts', 'w.asyncapi.yaml'), { force: true });
  ok(await save(proj) !== null, 'fprename/A: WITHOUT a move, deleting a spec correctly REFUSES the next incremental');

  // B — the identical edit, after a project move.
  writeFileSync(join(proj, 'contracts', 'w.asyncapi.yaml'), spec);
  await build(proj);
  // THE MOVE ITSELF IS A PARTITION CHANGE, and this test used to assert the opposite.
  // Nothing in this tree is a compartment boundary, so `a.js` — like every file outside
  // every boundary — is attributed to basename(root) (src/extract/walk.js
  // #compartmentNameFor). The move RENAMES that compartment, so it rewrites the id of
  // every symbol in the graph. Both partition values omitted the root fallback name, so
  // the fingerprint could not see it: one save then attributed `a.js` to `proj2` while
  // pruneFile deleted under `proj2` — a miss against the stored `proj` rows — leaving
  // alphaFn under BOTH compartments, with refresh.log reporting a clean reindex.
  //
  // What the KEY half of this test pins is unchanged and still asserted below: the drift
  // is REPORTED, against `(project root)`, which is only possible because the stamp was
  // looked up under a rename-stable key. Value: not stable, and must not be. Key: stable.
  const proj2 = join(work, 'proj2');
  renameSync(proj, proj2);
  const moveDrift = S.compartmentsDrift(S.readState(proj2).compartmentsFingerprint, S.compartmentsFingerprint([proj2]));
  ok(moveDrift !== null,
    'fprename: the MOVE re-partitions every root-attributed id, so it IS a compartment partition change');
  has(moveDrift, '(project root)',
    'fprename: ...reported under the project-relative KEY — the stamp was looked up, not skipped as "no baseline"');
  eq(S.contractsDrift(S.readState(proj2).contractsFingerprint, S.contractsFingerprint([proj2])), null,
    'fprename: ...and not a contract change either');
  ok(await save(proj2) !== null,
    'fprename: ...so a save right after a move is REFUSED rather than pruning under a compartment the db has never heard of');

  // The escalation the refusal asks for is the remedy, and it CONVERGES: the healed graph
  // is byte-for-byte the attribution a from-scratch build of the same tree produces.
  await build(proj2);
  eq(symbolPartitionOf(join(proj2, '.wiregraph', 'graph.db')), await fromScratchPartition(proj2),
    'fprename: ...and after the full rebuild the graph matches a from-scratch build exactly');
  ok(await save(proj2) === null, 'fprename: ...after which ordinary saves are accepted again');

  rmSync(join(proj2, 'contracts', 'w.asyncapi.yaml'), { force: true });
  ok(S.contractsDrift(S.readState(proj2).contractsFingerprint, S.contractsFingerprint([proj2])) !== null,
    'fprename/B: the deleted spec is still detected AFTER the move (drift was null here — both guards went dark)');
  ok(await save(proj2) !== null, 'fprename/B: ...so the identical edit is REFUSED with the move, exactly as it is without it');

  // The same for the compartment partition, which had the identical key bug.
  writeFileSync(join(proj2, 'contracts', 'w.asyncapi.yaml'), spec);
  await build(proj2);
  const proj3 = join(work, 'proj3');
  renameSync(proj2, proj3);
  // Rebuild FIRST, so the stamp belongs to proj3 and the assertion below is about the
  // manifest and nothing else — otherwise the move's own partition change would satisfy
  // it and this would pin nothing.
  await build(proj3);
  eq(S.compartmentsDrift(S.readState(proj3).compartmentsFingerprint, S.compartmentsFingerprint([proj3])), null,
    'fprename/B: the rebuild after the move restamps under the moved root, so the guard is quiet again');
  mkSourceTree(proj3, { 'sub/pkg.js': 'export function subFn(){ return 1; }\n' });
  writeFileSync(join(proj3, 'sub', 'package.json'), JSON.stringify({ name: 'moved-sub' }) + '\n');
  ok(S.compartmentsDrift(S.readState(proj3).compartmentsFingerprint, S.compartmentsFingerprint([proj3])) !== null,
    'fprename/B: a partition change after a move is detected too');
  ok(await save(proj3) !== null, 'fprename/B: ...and refuses the incremental');

  rmSync(work, { recursive: true, force: true });
}

// M3 — THE STAMPS ARE NOT COUPLED TO THE INFERENCE/METADATA WRITE.
//
// Both stamps used to ride inside the SAME updateState as `inferredSeams:
// clusterSeams(...) + clusterResourceSeams(...)`, wrapped in a bare `catch {}`. Any throw
// out of either inference pass — or out of updateState itself — silently left the OLD
// stamp, so the next save saw drift, escalated to a full rebuild, which threw there again,
// which escalated again: one full rebuild per file save, forever, visible only as repeating
// lines in refresh.log. The failure injected here is real and reachable: a corrupt
// state.json makes updateState quarantine the file and THROW.
async function stampCatchNarrowTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-stampcatch-')));
  const proj = join(work, 'proj');
  mkSourceTree(proj, { 'a.js': 'export function alphaFn(){ return 1; }\n' });
  const db = join(proj, '.wiregraph', 'graph.db');
  await runBuild({ target: proj, project: proj, db, reset: true });

  const statePath = join(proj, '.wiregraph', 'state.json');
  writeFileSync(statePath, '{ this is not json');
  let threw = null;
  try { await runBuild({ target: proj, project: proj, db, reset: true }); } catch (e) { threw = e.message; }
  eq(threw, null, 'stampcatch: a metadata failure never fails the build');
  ok(existsSync(statePath + '.corrupt'), 'stampcatch: the corrupt state was quarantined, so the failure really did happen');

  const st = S.readState(proj) || {};
  ok(st.compartmentsFingerprint && st.compartmentsFingerprint['.'],
    'stampcatch: the partition fingerprint is STAMPED ANYWAY — it is a separate write with its own failure domain');
  ok(st.contractsFingerprint && st.contractsFingerprint['.'], 'stampcatch: ...and so is the spec-set fingerprint');
  eq(S.compartmentsDrift(st.compartmentsFingerprint, S.compartmentsFingerprint([proj])), null,
    'stampcatch: ...so the next update is cheap, instead of escalating to a full rebuild on every single save forever');

  rmSync(work, { recursive: true, force: true });
}

// LEGACY INERTNESS. A project last built by a wiregraph that predates these keys has
// NEITHER of them. Absent must mean "no baseline" and never "changed" — otherwise the
// upgrade force-rebuilds every existing project on its very next catch-up — and reading
// state must not rewrite it.
async function legacyFingerprintInertTest() {
  const S = await import('../scripts/lib/state.mjs');
  const G = await import('../scripts/lib/git.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-fplegacy-')));
  const proj = join(work, 'proj');
  mkSourceTree(proj, { 'a.js': 'export function alphaFn(){ return 1; }\n', 'sub/b.js': 'export function betaFn(){ return 2; }\n' });
  const db = join(proj, '.wiregraph', 'graph.db');
  await runBuild({ target: proj, project: proj, db, reset: true });

  // Strip both keys entirely — exactly the shape a pre-fingerprint state.json has.
  const statePath = join(proj, '.wiregraph', 'state.json');
  const legacy = JSON.parse(readFileSync(statePath, 'utf8'));
  delete legacy.compartmentsFingerprint;
  delete legacy.contractsFingerprint;
  writeFileSync(statePath, JSON.stringify(legacy, null, 2) + '\n');
  const bytes = readFileSync(statePath, 'utf8');

  eq(S.compartmentsDrift(S.readState(proj).compartmentsFingerprint, S.compartmentsFingerprint([proj])), null,
    'fplegacy: an ABSENT compartments stamp is no baseline, never a change');
  eq(S.contractsDrift(S.readState(proj).contractsFingerprint, S.contractsFingerprint([proj])), null,
    'fplegacy: ...and the same for the contracts stamp');
  eq(G.changedSince(proj, S.readState(proj).reposLastSha || {}).fullBuildNeeded, false,
    'fplegacy: ...so the catch-up does NOT escalate');
  ok(!S.modeLine(S.readState(proj)).includes('FULL REBUILD IS PENDING'),
    'fplegacy: ...and graph_status does not claim a rebuild is pending');
  await runBuild({ target: proj, project: proj, db, files: [join(proj, 'sub', 'b.js')] });
  ok(true, 'fplegacy: an incremental is not refused');

  // …AND THAT FIRST SAVE ARMS THE GUARD. Absent-means-no-baseline is right, and on its own
  // it left every project built by an earlier release UNGUARDED FOREVER: nothing but a
  // hand-run full rebuild ever writes a stamp, and the save loop never runs one, so all
  // three corruptions the guards exist to stop reproduced verbatim on the entire installed
  // base. The remedy is opportunistic STAMPING, which is not COMPARING: the value written
  // is the partition the incremental above actually attributed and pruned against, it is
  // written after both refusals, and it FILLS ABSENT KEYS ONLY.
  const after = JSON.parse(readFileSync(statePath, 'utf8'));
  eq(JSON.stringify({ ...after, compartmentsFingerprint: undefined, contractsFingerprint: undefined }),
    JSON.stringify({ ...JSON.parse(bytes), compartmentsFingerprint: undefined, contractsFingerprint: undefined }),
    'fplegacy: ...the save rewrote NOTHING in state.json except the two absent stamps');
  eq(JSON.stringify(after.compartmentsFingerprint), JSON.stringify(S.compartmentsFingerprint([proj])),
    'fplegacy: ...which now hold exactly the partition that incremental used');
  eq(JSON.stringify(after.contractsFingerprint), JSON.stringify(S.contractsFingerprint([proj])),
    'fplegacy: ...and exactly the spec set it used');

  // So the SECOND save is guarded, where before the fix every save forever was not.
  writeFileSync(join(proj, 'sub', 'package.json'), JSON.stringify({ name: 'subpkg' }) + '\n');
  ok(S.compartmentsDrift(S.readState(proj).compartmentsFingerprint, S.compartmentsFingerprint([proj])) !== null,
    'fplegacy: a partition change after that first save is DETECTED — the guard is armed');
  let legacyRefused = null;
  try { await runBuild({ target: proj, project: proj, db, files: [join(proj, 'sub', 'b.js')] }); }
  catch (e) { legacyRefused = e.message; }
  ok(legacyRefused !== null,
    'fplegacy: ...and the save that would have left betaFn under two compartments is refused, on a graph no full rebuild ever stamped');

  rmSync(work, { recursive: true, force: true });
}

// The link collision guard reads the SAME funnel. canLink rejects a candidate that
// would share a compartment name with an existing member, because compartment ids are
// name-only and a collision silently merges two graphs' compartments. Under a
// declaration that guard must see the DECLARED names, not the inferred ones — otherwise
// a declared collision links cleanly and corrupts both graphs.
async function declaredCompartmentLinkGuardTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-decllink-')));
  const alpha = join(work, 'alpha');
  const bravo = join(work, 'bravo');
  const charlie = join(work, 'charlie');
  for (const [root, sub] of [[alpha, 'core'], [bravo, 'core'], [charlie, 'net']]) {
    mkSourceTree(root, { [`${sub}/x.js`]: 'export function xFn(){ return 1; }\n' });
  }
  // Inferred, these three trees have NO boundaries at all — so nothing could collide.
  // Everything below comes from the declarations.
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', alpha, JSON.stringify([{ path: 'core', name: 'shared_core' }]), '--new']);
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', bravo, JSON.stringify([{ path: 'core', name: 'shared_core' }]), '--new']);
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', charlie, JSON.stringify([{ path: 'net', name: 'charlie_net' }]), '--new']);

  const clash = S.canLink(S.readState(alpha), bravo);
  eq(clash.ok, false, 'decllink: a candidate DECLARING a name this graph also declares is rejected');
  has(clash.reason, 'shared_core', 'decllink: the rejection names the colliding DECLARED compartment');

  const fine = S.canLink(S.readState(alpha), charlie);
  eq(fine.ok, true, 'decllink: a candidate whose declared names are disjoint links cleanly');

  rmSync(work, { recursive: true, force: true });
}

// The declare-time report has to name the specs the user ACTUALLY WROTE.
//
// The invalidation scan listed only `.wiregraph/inferred/`, which is links.mjs's
// out-of-source dir for link-inferred seams — the one spec in the project the user did
// NOT write. `/wiregraph-contracts apply` writes into contractsHome(root) =
// `<project>/contracts/`, and that file is the canonical carrier of
// x-wiregraph-producers, sitting alongside every hand-written spec. Those are exactly
// the ones that go DARK when a declared name differs from the walk's basename.
//
// Also pins the M10 guard: `declare` on a directory with no .wiregraph/ used to plant a
// complete, plausible state.json (mode recursive, no db, never built) that findIndexedRoot
// then reads as a real indexed workspace.
async function declareReportTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-declreport-')));
  const proj = join(work, 'engine');
  mkSourceTree(proj, ENGINE_SOURCES);

  // M10: refused on an unindexed project, and NOTHING is written.
  let refused = null;
  try { await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', proj, JSON.stringify([{ path: 'server/ecs', name: 'ecs' }])]); }
  catch (e) { refused = `${e.stdout || ''}${e.stderr || ''}`; }
  ok(refused !== null, 'declreport: `declare` on a project with no .wiregraph/ is REFUSED by default');
  has(refused, 'not an indexed project', 'declreport: ...and says why');
  eq(S.readState(proj), null, 'declreport: ...and plants no half-configured footprint');

  // Three specs: the out-of-source inferred one, the one `apply` wrote into contracts/,
  // and a hand-written sibling. All three record compartment names; all three are suspect.
  mkdirSync(join(proj, 'contracts'), { recursive: true });
  mkdirSync(join(proj, '.wiregraph', 'inferred'), { recursive: true });
  writeFileSync(join(proj, 'contracts', 'wiregraph-inferred.asyncapi.yaml'), 'asyncapi: 3.0.0\n');
  writeFileSync(join(proj, 'contracts', 'payments.asyncapi.yaml'), 'asyncapi: 3.0.0\n');
  writeFileSync(join(proj, '.wiregraph', 'inferred', 'wiregraph-inferred.asyncapi.yaml'), 'asyncapi: 3.0.0\n');

  const { stdout } = await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', proj,
    JSON.stringify([{ path: 'server/ecs', name: 'ecs' }]), '--new']);
  has(stdout, join(proj, '.wiregraph', 'inferred', 'wiregraph-inferred.asyncapi.yaml'), 'declreport: the out-of-source inferred spec is listed');
  has(stdout, join(proj, 'contracts', 'wiregraph-inferred.asyncapi.yaml'), 'declreport: the spec /wiregraph-contracts apply wrote into contracts/ is listed (it was NOT, and it carries x-wiregraph-producers)');
  has(stdout, join(proj, 'contracts', 'payments.asyncapi.yaml'), 'declreport: and so is the HAND-WRITTEN spec next to it');
  has(stdout, 'INVALIDATES', 'declreport: the generic note still prints');

  rmSync(work, { recursive: true, force: true });
}

// THE READ PATH APPLIES THE WRITE PATH'S RULES. state.json is a plain, hand-editable
// file, so every declaration `declare` rejects still REACHES the build by hand edit, a
// merge resolution, or a directory renamed afterwards. The read path used to apply a
// strictly weaker rule set — it skipped entries it could not honour and built the
// remainder — so each of these produced a SUCCESSFUL build with a silently wrong
// partition instead of degrading to inference. Both sides now call one validator
// (src/extract/compartment-decl.js), and an unusable declaration is ignored WHOLESALE.
//
// Every case below is asserted three ways: the read path falls back to INFERENCE (on a
// tree whose inferred answer is provably different), the WRITE path rejects the same
// input (proving it is one rule set), and the fingerprint records the partition actually
// in force, so the mismatch escalates to a full rebuild rather than corrupting the db.
async function declaredCompartmentReadPathTest() {
  const W = await import('../src/extract/walk.js');
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-declread-')));
  const proj = join(work, 'engine');
  mkSourceTree(proj, ENGINE_SOURCES);
  // ONE inferred boundary, so "fell back to inference" is distinguishable from both
  // "honoured the declaration" and "collapsed to nothing".
  writeFileSync(join(proj, 'shared', 'package.json'), '{"name":"shared"}');
  mkdirSync(join(work, 'outside', 'stuff'), { recursive: true });
  writeFileSync(join(work, 'outside', 'stuff', 'o.js'), 'export function outsideFn(){ return 1; }\n');
  symlinkSync(join(proj, 'server', 'sim'), join(proj, 'sim-link'));           // inside the project
  symlinkSync(join(work, 'outside'), join(proj, 'outside-link'));             // outside it
  mkdirSync(join(proj, 'real', 'nested'), { recursive: true });
  writeFileSync(join(proj, 'real', 'nested', 'n.js'), 'export function nestedFn(){ return 1; }\n');
  symlinkSync(join(proj, 'real'), join(proj, 'real-link'));                   // symlinked PARENT

  const INFERRED = JSON.stringify(['shared']);
  eq(JSON.stringify(W.findCompartmentRoots(proj).map((r) => r.name)), INFERRED,
    'declread: with no declaration the tree infers exactly one boundary — the answer every rejection below must fall back to');
  // The fingerprint value of THAT partition, captured before anything is declared. Every
  // rejected declaration below must land back on exactly this value — a stronger assertion
  // than "it equals the literal 'global'", which was true no matter what the walk resolved.
  const INFERRED_FP = S.compartmentsFingerprint([proj])['.'];
  ok(String(INFERRED_FP).startsWith('g1:'), 'declread: the inferred partition has a real hashed value');

  // The CLI is the write path; `validate` is its dry run, same code, writes nothing.
  const writeRejects = async (list) => {
    try { await execFileP(process.execPath, [COMPARTMENTS_CLI, 'validate', proj, JSON.stringify(list)]); return null; }
    catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; }
  };
  // Plant a declaration by HAND, exactly as a user editing state.json would.
  const plant = (compartments) => S.updateState(proj, { mode: 'recursive', compartments });

  const unusable = async (label, compartments, needle) => {
    plant(compartments);
    eq(JSON.stringify(W.findCompartmentRoots(proj).map((r) => r.name)), INFERRED,
      `declread/${label}: the read path IGNORES the whole declaration and falls back to inference`);
    eq(S.compartmentsFingerprint([proj])['.'], INFERRED_FP,
      `declread/${label}: the fingerprint records the partition IN FORCE — the very inference the read path fell back to, not the declaration it refused`);
    has(S.modeLine(S.readState(proj)), 'DECLARATION IS UNUSABLE',
      `declread/${label}: graph_status's Mode line says the declaration was ignored, instead of reciting names that are not in the graph`);
    const err = await writeRejects(compartments);
    ok(err !== null, `declread/${label}: the WRITE path rejects the same input — one rule set, not two`);
    if (needle) has(err, needle, `declread/${label}: and the rejection explains why`);
  };

  // K2. `[]` IS TRUTHY. The read path skipped every ill-formed entry, returned [], and
  // `if (declared) return declared;` honoured that as "declared empty" — so the obvious
  // hand edit (an array of STRINGS, not objects) gave a successful build with the node
  // count unchanged, no warning, and every compartment gone.
  await unusable('junk-strings', ['server/ecs', 'client/net'], 'must be an object with "path" and "name"');

  // K3. Each of these was ACCEPTED by the read path and corrupts the graph.
  await unusable('dup-name', [{ path: 'server/ecs', name: 'core' }, { path: 'server/sim', name: 'core' }], 'is claimed by 2 different roots');
  await unusable('partial-entry', [{ path: 'server/ecs', name: 'ecs' }, { path: 'server/sim' }], '"name" must be a non-empty string');
  await unusable('file-not-dir', [{ path: 'server/ecs/ecs.js', name: 'filecomp' }], 'is not a directory');
  await unusable('id-separator', [{ path: 'server/ecs', name: 'a:b' }], "contains ':'");
  await unusable('missing-path', [{ path: 'server/nope', name: 'nope' }], 'does not exist');
  await unusable('root-name-clash', [{ path: 'server/ecs', name: 'engine' }], 'the fallback compartment for every undeclared file');
  await unusable('not-an-array', 'server/ecs', 'must be a JSON array');

  // H4. SYMLINKED DECLARED ROOTS. validateDeclaration used statSync, which FOLLOWS a
  // symlink, so a symlink-to-dir passed "is a directory" — while walkOneRoot tests
  // Dirent.isDirectory(), which is FALSE for one, so it never descends there. All three
  // shapes validated clean and produced a permanently EMPTY compartment. It also defeats
  // the "outside the project root" rule, which is purely lexical on the stored relative
  // path and cannot see where a symlink points.
  await unusable('symlink-inside', [{ path: 'sim-link', name: 'simlink' }], 'reached through a symlink');
  await unusable('symlink-outside', [{ path: 'outside-link', name: 'outside' }], 'reached through a symlink');
  await unusable('symlinked-parent', [{ path: 'real-link/nested', name: 'nested' }], 'reached through a symlink');

  // NOT over-broad: the real directories behind those symlinks declare fine, and a
  // symlink somewhere else in the tree is irrelevant.
  plant([{ path: 'server/sim', name: 'simreal' }, { path: 'real/nested', name: 'nested' }]);
  eq(JSON.stringify(W.findCompartmentRoots(proj).map((r) => r.name).sort()), JSON.stringify(['nested', 'simreal']),
    'declread: the REAL directories behind those symlinks are declarable — the rejection is about the link, not the target');
  ok(S.compartmentsFingerprint([proj])['.'] !== INFERRED_FP && String(S.compartmentsFingerprint([proj])['.']).startsWith('r1:'),
    'declread: ...and a usable declaration is fingerprinted as DECLARED, never equal to the inference it replaces');

  // The db-level proof for the duplicate NAME, which is the one that corrupts rather than
  // merely loses: compartmentId is name-only, so two roots sharing a name used to collapse
  // into ONE row via INSERT OR REPLACE keeping whichever root landed last — and then a
  // relPath computed against the OTHER root resolved under it, so get_source read the
  // WRONG FILE. Falling back to inference is the whole point: the build is coherent.
  plant([{ path: 'server/ecs', name: 'core' }, { path: 'server/sim', name: 'core' }]);
  const dupDb = join(work, 'dup.db');
  await runBuild({ target: proj, project: proj, db: dupDb, reset: true });
  const conn = connect(dupDb, { readonly: true });
  const comps = conn.prepare('SELECT name FROM compartments ORDER BY name').all().map((r) => r.name);
  eq(JSON.stringify(comps), JSON.stringify(['engine', 'shared']),
    'declread/db: a duplicate-name declaration produces the INFERRED compartments, not one collapsed row holding two roots\' files');
  ok(!comps.includes('core'), 'declread/db: the colliding name never reaches the compartments table at all');
  const dupRows = conn.prepare('SELECT compartment, path, count(*) n FROM files GROUP BY compartment, path HAVING n > 1').all();
  eq(dupRows.length, 0, 'declread/db: and no two files collide on (compartment, path)');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// THE FINGERPRINT COVERS THE DISK, NOT JUST THE DECLARATION TEXT.
//
// Hashing only the stored (path, name) strings left the disk half unguarded, and the
// result was proven db corruption: declare server/ecs + server/sim, full build,
// `mv server/sim server/simulation`, edit a file — changedSince reported
// fullBuildNeeded:false, the incremental was ACCEPTED, and afterwards simStep existed
// under BOTH the new path's compartment and a ghost `sim` row pointing at a directory
// that no longer existed. Deleting a declared directory did the same thing: every file
// silently reattributed to the root and every spec naming that compartment went dark.
//
// Renaming or deleting a source directory is ordinary work. It re-partitions the graph
// exactly as editing the declaration does, so it must escalate to a full rebuild — the
// same failure mode renameGhostCompartmentTest pins for a project rename, tested the
// same way.
async function declaredCompartmentDiskDriftTest() {
  const S = await import('../scripts/lib/state.mjs');
  const G = await import('../scripts/lib/git.mjs');
  const W = await import('../src/extract/walk.js');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-diskdrift-')));
  const proj = join(work, 'engine');
  mkSourceTree(proj, ENGINE_SOURCES);
  const db = join(work, 'graph.db');
  const anyFile = join(proj, 'server', 'ecs', 'ecs.js');

  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', proj,
    JSON.stringify([{ path: 'server/ecs', name: 'ecs' }, { path: 'server/sim', name: 'sim' }]), '--new']);
  await runBuild({ target: proj, project: proj, db, reset: true });
  const stamped = S.readState(proj).compartmentsFingerprint;
  ok(String(stamped['.']).startsWith('r1:'), 'diskdrift: the declared build stamps a real declared fingerprint');
  {
    const conn = connect(db, { readonly: true });
    eq(JSON.stringify(conn.prepare('SELECT name FROM compartments ORDER BY name').all().map((r) => r.name)),
      JSON.stringify(['ecs', 'engine', 'sim']),
      'diskdrift: the baseline graph holds exactly the declared compartments plus the root fallback');
    conn.close();
  }

  // --- RENAME a declared source directory --------------------------------------
  renameSync(join(proj, 'server', 'sim'), join(proj, 'server', 'simulation'));
  ok(String(S.compartmentsFingerprint([proj])['.']).startsWith('g1:'),
    'diskdrift/rename: a declared path that no longer exists makes the declaration UNUSABLE, so the root is back on the inferred partition');
  ok(S.compartmentsDrift(stamped, S.compartmentsFingerprint([proj])) !== null,
    'diskdrift/rename: ...which MOVES the fingerprint, though the declaration TEXT is byte-identical');
  const c = G.changedSince(proj, S.readState(proj).reposLastSha || {});
  eq(c.fullBuildNeeded, true, 'diskdrift/rename: the catch-up escalates to a full rebuild (it reported false before this)');
  has(c.fullBuildReasons.join('; '), 'the compartment partition changed', 'diskdrift/rename: the escalation names the reason');
  let refused = null;
  try { await runBuild({ target: proj, project: proj, db, files: [anyFile] }); } catch (e) { refused = e.message; }
  ok(refused !== null, 'diskdrift/rename: and the incremental is REFUSED outright (it was ACCEPTED before, and corrupted the db)');
  has(refused, 'full rebuild', 'diskdrift/rename: the refusal names the fix');

  // The ghost is what the refusal prevents: a full rebuild is safe by construction, and
  // afterwards no compartment row points at a directory that no longer exists.
  await runBuild({ target: proj, project: proj, db, reset: true });
  {
    const conn = connect(db, { readonly: true });
    const names = conn.prepare('SELECT name FROM compartments ORDER BY name').all().map((r) => r.name);
    ok(!names.includes('sim'), 'diskdrift/rename: after the rebuild there is NO ghost `sim` compartment pointing at the old path');
    const simStep = conn.prepare("SELECT compartment FROM symbols WHERE name = 'simStep'").all().map((r) => r.compartment);
    eq(simStep.length, 1, 'diskdrift/rename: simStep exists under exactly ONE compartment (it used to exist under two)');
    conn.close();
  }

  // --- DELETE a declared source directory --------------------------------------
  renameSync(join(proj, 'server', 'simulation'), join(proj, 'server', 'sim'));
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', proj,
    JSON.stringify([{ path: 'server/ecs', name: 'ecs' }, { path: 'server/sim', name: 'sim' }])]);
  await runBuild({ target: proj, project: proj, db, reset: true });
  const stamped2 = S.readState(proj).compartmentsFingerprint;
  rmSync(join(proj, 'server', 'sim'), { recursive: true, force: true });
  ok(S.compartmentsDrift(stamped2, S.compartmentsFingerprint([proj])) !== null,
    'diskdrift/delete: deleting a declared directory moves the fingerprint too');
  eq(G.changedSince(proj, S.readState(proj).reposLastSha || {}).fullBuildNeeded, true,
    'diskdrift/delete: ...and escalates, instead of silently reattributing every file to the root');

  // --- a compartment that MOVES under a STABLE NAME -----------------------------
  // The mutation this kills: a fingerprint that hashes NAMES ONLY. Same names, same
  // count, different directories — every relPath in the compartment changes, so every
  // id changes, and a names-only hash would not notice.
  mkSourceTree(proj, { 'server/sim/sim.js': 'export function simStep(){ return 2; }\n' });
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', proj, JSON.stringify([{ path: 'server/sim', name: 'sim' }])]);
  await runBuild({ target: proj, project: proj, db, reset: true });
  const beforeMove = S.readState(proj).compartmentsFingerprint;
  renameSync(join(proj, 'server', 'sim'), join(proj, 'server', 'simulation'));
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', proj, JSON.stringify([{ path: 'server/simulation', name: 'sim' }])]);
  eq(JSON.stringify(W.findCompartmentRoots(proj).map((r) => r.name)), JSON.stringify(['sim']),
    'diskdrift/move: the compartment NAME-set is unchanged by the move');
  ok(S.compartmentsDrift(beforeMove, S.compartmentsFingerprint([proj])) !== null,
    'diskdrift/move: a compartment moving DIRECTORY under a stable name still moves the fingerprint (a names-only hash would not notice)');

  rmSync(work, { recursive: true, force: true });
}

// A DECLARED LINKED MEMBER — the case the suite had none of, which is why the
// unmount/unlink regression slipped through.
//
// The fingerprint is a PER-ROOT map compared only over the roots mounted right now, for
// exactly the reason refresh.mjs MERGES reposLastSha rather than replacing it: a member
// that is transiently unmounted, or deliberately excluded by unlink's reduced union,
// must not drop out of a single whole-union hash and forge a partition change out of a
// mount blip.
async function declaredMemberFingerprintTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-declmember-')));
  const alpha = join(work, 'alpha');
  const bravo = join(work, 'bravo');
  mkSourceTree(alpha, { 'core/a.js': 'export function alphaFn(){ return 1; }\n' });
  mkSourceTree(bravo, { 'core/b.js': 'export function bravoFn(){ return 2; }\n' });
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', alpha, JSON.stringify([{ path: 'core', name: 'alpha_core' }]), '--new']);
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', bravo, JSON.stringify([{ path: 'core', name: 'bravo_core' }]), '--new']);

  const both = S.compartmentsFingerprint([alpha, bravo]);
  eq(Object.keys(both).length, 2, 'declmember: the fingerprint carries ONE entry PER ROOT');
  ok(both['.'] !== both[bravo], 'declmember: two roots declaring the SAME path with different names get different values');
  ok(String(both['.']).startsWith('r1:') && String(both[bravo]).startsWith('r1:'), 'declmember: both roots are recorded as declared');
  eq(Object.keys(both).sort().join(','), ['.', bravo].sort().join(','),
    'declmember: the PROJECT root is keyed "." (rename-stable) while a member OUTSIDE it keeps its absolute path — the spelling that is stable for IT');

  // The per-root key is load-bearing: identical declarations under different roots must
  // still be attributed to their own root, so a change in ONE is detected as a change in
  // THAT one. (A union-wide single hash cannot express this, which is the whole bug.)
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', bravo, JSON.stringify([{ path: 'core', name: 'bravo_renamed' }])]);
  const moved = S.compartmentsFingerprint([alpha, bravo]);
  eq(moved['.'], both['.'], 'declmember: re-declaring the MEMBER leaves the project root\'s own value untouched');
  ok(moved[bravo] !== both[bravo], 'declmember: ...and moves the member\'s');
  has(S.compartmentsDrift(both, moved), 'bravo', 'declmember: the drift report names WHICH root moved');

  // M9(c): a member that is not mounted right now is simply not compared.
  eq(S.compartmentsDrift(both, S.compartmentsFingerprint([alpha])), null,
    'declmember: an UNMOUNTED member does not register as a partition change (a mount blip must not force a full rebuild)');
  // M9(d): unlink's deliberately reduced union is the same shape, and stamping MERGES,
  // so the absent peer keeps its baseline instead of being dropped.
  const stampedAfterReduced = { ...both, ...S.compartmentsFingerprint([alpha]) };
  eq(JSON.stringify(stampedAfterReduced), JSON.stringify(both),
    'declmember: a reduced-union build MERGES its stamp, so the excluded peer keeps its baseline');
  eq(S.compartmentsDrift(stampedAfterReduced, S.compartmentsFingerprint([alpha, bravo])) !== null, true,
    'declmember: ...and the kept baseline still detects a real change when the peer comes back');

  rmSync(work, { recursive: true, force: true });
}

// CONTRACTS-DIR PRECEDENCE — children FIRST, the root LAST.
//
// Carried from Phase 1a, pinned here either way because it is silently load-bearing:
// `roots.flatMap(detectContractsDirs)[0]` is what fullBuild records as
// state.contractsDir, which is the dir `/wiregraph-contracts apply` WRITES into, and it
// is also spec precedence (loadAllContracts keeps the first contributor on a title
// collision). The ordering is deliberate — a purpose-named `contracts/` child is a far
// stronger statement of intent than a root that merely happens to hold a spec file — and
// it only became observable for a root that satisfies BOTH tests, which is the case a
// `*-contracts` repo with a `contracts/` subdir hits.
async function contractsDirPrecedenceTest() {
  const { detectContractsDirs } = await import('../src/build.js');
  const { contractsHome } = await import('../src/contracts-dirs.js');
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-cdirs-')));

  // A root that matches BOTH promotion rules: its basename ends in -contracts AND it
  // directly holds a spec — plus a purpose-named child.
  const root = join(work, 'payments-contracts');
  mkdirSync(join(root, 'contracts'), { recursive: true });
  mkdirSync(join(root, 'Asyncapi'), { recursive: true });
  writeFileSync(join(root, 'top.asyncapi.yaml'), 'asyncapi: 3.0.0\n');
  writeFileSync(join(root, 'src.js'), 'export function pcFn(){ return 1; }\n');

  const dirs = detectContractsDirs(root);
  eq(JSON.stringify(dirs.map((d) => relative(root, d) || '.')), JSON.stringify(['Asyncapi', 'contracts', '.']),
    'cdirs: children come FIRST in sorted order, the root LAST — a purpose-named child outranks a root that merely holds a spec');
  eq(contractsHome(root), dirs[0],
    'cdirs: contractsHome (what /wiregraph-contracts apply writes into) is exactly detectContractsDirs()[0] — one function, so the writer and the loader cannot disagree');
  ok(dirs.includes(join(root, 'Asyncapi')), 'cdirs: the name test is case-INSENSITIVE');

  const db = join(work, 'graph.db');
  await runBuild({ target: root, project: root, db, reset: true });
  eq(S.readState(root).contractsDir, join(root, 'Asyncapi'),
    'cdirs: the full build records that same first entry as state.contractsDir');

  // A root with NO child still promotes itself, so the ordering change never lost a case.
  const lone = join(work, 'lone');
  mkdirSync(lone, { recursive: true });
  writeFileSync(join(lone, 'x.asyncapi.yml'), 'asyncapi: 3.0.0\n');
  eq(JSON.stringify(detectContractsDirs(lone)), JSON.stringify([lone]),
    'cdirs: a root that only holds a top-level spec is still its own contracts home');
  eq(JSON.stringify(detectContractsDirs(join(work, 'nope'))), '[]', 'cdirs: an unreadable/missing root yields nothing rather than throwing');

  rmSync(work, { recursive: true, force: true });
}

// THE REFUSAL IS VISIBLE ON EVERY INCREMENTAL ENTRY POINT.
//
// update_graph throws and the agent sees it. The other two were silent:
// refresh.mjs --files threw into main().catch, which wrote one ERROR line to
// refresh.log and exited 0; the MCP read self-heal swallowed it in a bare `catch {}`
// (covered in ensureFreshTests). refresh.mjs now ESCALATES instead — a full rebuild is
// the exact remedy the refusal asks for, is safe by construction, and restamps — and
// logs the decision BEFORE building, so a rebuild that itself throws still leaves a
// record of why it was attempted.
async function refreshPartitionDriftTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-refreshdrift-')));
  const proj = join(work, 'engine');
  mkSourceTree(proj, ENGINE_SOURCES);
  await execFileP(process.execPath, [COMPARTMENTS_CLI, 'declare', proj,
    JSON.stringify([{ path: 'server/ecs', name: 'ecs' }, { path: 'server/sim', name: 'sim' }]), '--new']);
  await execFileP(process.execPath, [REFRESH, '--full'], { env: { ...process.env, CLAUDE_PROJECT_DIR: proj } });
  const firstBuild = S.readState(proj).lastFullBuild;
  ok(firstBuild, 'refreshdrift: the baseline full build landed');

  // Move a declared directory on disk — the declaration text does not change at all.
  renameSync(join(proj, 'server', 'sim'), join(proj, 'server', 'simulation'));
  await execFileP(process.execPath, [REFRESH, '--files', join(proj, 'server', 'ecs', 'ecs.js')],
    { env: { ...process.env, CLAUDE_PROJECT_DIR: proj } });

  const log = readFileSync(join(proj, '.wiregraph', 'refresh.log'), 'utf8');
  has(log, 'escalating to full rebuild (compartment partition changed', 'refreshdrift: the post-edit refresh LOGS the escalation instead of failing silently');
  has(log, 'full rebuild complete (compartment partition changed)', 'refreshdrift: ...and completes it');
  ok(S.readState(proj).lastFullBuild !== firstBuild,
    'refreshdrift: lastFullBuild advanced — the project self-heals instead of wedging until a manual /wiregraph-rebuild');
  const stamped = S.readState(proj).compartmentsFingerprint;
  eq(S.compartmentsDrift(stamped, S.compartmentsFingerprint([proj])), null,
    'refreshdrift: the rebuild restamped, so the next update is cheap again');

  rmSync(work, { recursive: true, force: true });
}

// The documented escape hatch has to EXIST. /wiregraph-init promises, twice, that
// switching modes is "teardown + re-init" — but teardown only removed the directive and
// set posture off, deliberately leaving state.json, and nothing in re-init's global
// branch dropped the declaration. Observed: the user answers GLOBAL, the build still
// partitions on the stale declaration, and step 9's read-back reports Mode: recursive.
// `compartments.mjs clear` existed and was referenced by ZERO command prose.
function modeEscapeHatchTest() {
  const cmd = (n) => readFileSync(join(HERE, '..', 'commands', n), 'utf8');
  const init = cmd('wiregraph-init.md');
  const teardown = cmd('wiregraph-teardown.md');
  has(teardown, 'compartments.mjs clear', 'escapehatch: /wiregraph-teardown actually clears a declaration (it used to leave state.json entirely alone)');
  has(init, 'compartments.mjs clear', 'escapehatch: /wiregraph-init\'s GLOBAL branch clears a stale declaration');
  has(init, 'compartments.mjs declare', 'escapehatch: ...and its recursive branch still declares');
  has(init, '--new', 'escapehatch: init passes --new, the flag that lets declare run on a not-yet-indexed project');
  // M11: the mode question must not be asked on a false premise. A `find -name contracts`
  // is case-SENSITIVE and prunes only node_modules/.git, so `Contracts/` reads as "none"
  // and a `contracts/` under target//vendor//dist inflates the answer to "nested".
  has(init, 'workspace.mjs contracts-dirs', 'escapehatch: step 2a detects contracts dirs with the ENGINE\'s rule, not a hand-rolled find');
  ok(!init.includes("find \"<TARGET>\" -type d"), 'escapehatch: the case-sensitive find that disagreed with isContractsDirName is gone');
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

  // MED-1 regression: a NORMAL repo whose git dir legitimately lives under a directory
  // literally named "worktrees" (git init --separate-git-dir). The old path-string regex
  // saw "/worktrees/" in its gitdir and MISREAD it as a linked-worktree marker, silently
  // dropping the whole repo from indexing. Authoritative detection (its own git-dir ==
  // its common git-dir) reads false. ~/worktrees/ is a common projects folder for exactly
  // the worktree-heavy users this feature serves, so this must hold.
  const sepParent = join(ws, 'worktrees', 'gitdirs');
  mkdirSync(sepParent, { recursive: true });
  const plain = join(ws, 'plain');
  mkdirSync(plain, { recursive: true });
  await execFileP('git', ['init', '-q', '--separate-git-dir', join(sepParent, 'plain'), plain]);
  ok(!W.isLinkedWorktree(plain), 'worktree: isLinkedWorktree is false for a --separate-git-dir repo whose gitdir passes through a "worktrees" dir (MED-1)');

  // A real SUBMODULE (its `.git` file points at <super>/.git/modules/<name>) must read
  // false — its git-dir == its common git-dir — else we would wrongly skip a legitimately
  // separate submodule repo. Built in its OWN super-repo so `main`'s later assertions stay clean.
  const subUp = join(ws, 'sub-upstream');
  mkdirSync(subUp, { recursive: true });
  await execFileP('git', ['-C', subUp, 'init', '-q']);
  await execFileP('git', ['-C', subUp, 'config', 'user.email', 't@t']);
  await execFileP('git', ['-C', subUp, 'config', 'user.name', 't']);
  writeFileSync(join(subUp, 'lib.js'), 'export function libFn(){}\n');
  await execFileP('git', ['-C', subUp, 'add', '-A']);
  await execFileP('git', ['-C', subUp, 'commit', '-q', '-m', 'init']);
  const superR = join(ws, 'super');
  mkdirSync(superR, { recursive: true });
  await execFileP('git', ['-C', superR, 'init', '-q']);
  await execFileP('git', ['-C', superR, 'config', 'user.email', 't@t']);
  await execFileP('git', ['-C', superR, 'config', 'user.name', 't']);
  await execFileP('git', ['-C', superR, '-c', 'protocol.file.allow=always', 'submodule', 'add', subUp, 'libs/foo']);
  ok(!W.isLinkedWorktree(join(superR, 'libs', 'foo')), 'worktree: isLinkedWorktree is false for a real git submodule (git-dir == common-dir)');

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

// link/unlink must carry BOTH inferred formats to disk, not just the AsyncAPI one.
// reinferAndRebuild writes the draft BEFORE the rebuild (fullBuild only MATCHES on-disk
// specs, it never synthesizes) and REMOVES it when the union yields nothing — and the
// removal is the half that rots silently: a stale wiregraph-inferred.resource.yaml left
// in inferred/ after an unlink keeps deriving a seam across a member that is no longer
// part of the graph, and every full-build test still passes because the file is a
// legitimate spec that simply should not be there any more.
async function linkResourceSpecLifecycleTest() {
  const L = await import('../scripts/lib/links.mjs');
  const ws = mkdtempSync(join(tmpdir(), 'cg-linkres-'));
  const a = realpathSync(mkdtempSync(join(ws, 'writer-')));
  const b = realpathSync(mkdtempSync(join(ws, 'reader-')));
  mkdirSync(join(a, '.git'), { recursive: true });
  mkdirSync(join(b, '.git'), { recursive: true });
  // Vendored copies of ONE constant and no route anywhere: the only seam these two
  // graphs can possibly share is a RESOURCE seam.
  writeFileSync(join(a, 'w.js'),
    "import { writeFileSync } from 'node:fs';\n"
    + "const LINKED_STATE_PATH = '/var/run/linked/state.json';\n"
    + "export function linkedWrite(s) { writeFileSync(LINKED_STATE_PATH, s); }\n");
  writeFileSync(join(b, 'r.js'),
    "import { readFileSync } from 'node:fs';\n"
    + "const LINKED_STATE_PATH = '/var/run/linked/state.json';\n"
    + "export function linkedRead() { return readFileSync(LINKED_STATE_PATH, 'utf8'); }\n");
  await initGraph(a);
  await initGraph(b);

  const specOf = (root) => join(root, '.wiregraph', 'inferred', 'wiregraph-inferred.resource.yaml');
  const wireSpecOf = (root) => join(root, '.wiregraph', 'inferred', 'wiregraph-inferred.asyncapi.yaml');
  await L.doLink(a, b);
  ok(existsSync(specOf(a)) && existsSync(specOf(b)),
    'link-res: linking writes the inferred RESOURCE spec into BOTH graphs (a spec that is never written can never be matched)');
  ok(!existsSync(wireSpecOf(a)),
    'link-res: …and no AsyncAPI draft, since there is no wire seam to write one for');
  ok(edgeCount(a, a, 'RESOURCE') > 0, `link-res: the union rebuild derives the cross-member RESOURCE seam (got ${edgeCount(a, a, 'RESOURCE')})`);

  await L.doUnlink(a, b);
  ok(!existsSync(specOf(a)),
    'link-res: unlinking REMOVES the stale inferred resource spec — otherwise it keeps deriving a seam to a member that is gone');
  ok(!existsSync(specOf(b)), 'link-res: …on the peer side too');
  eq(edgeCount(a, a, 'RESOURCE'), 0, 'link-res: and the reduced-union rebuild sheds the seam');
  rmSync(ws, { recursive: true, force: true });
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
  // v5: a normal full build stamps a non-null content hash on every indexed file — the
  // authoritative tiebreaker the content-reconcile confirms a mtime+size MATCH with.
  { const db = connect(db1, { readonly: true }); const rows = db.prepare('SELECT path, hash FROM files').all(); db.close();
    ok(rows.length > 0 && rows.every((r) => typeof r.hash === 'string' && r.hash.length === 40),
      'inv-base hash: every file row carries a non-null 40-char sha1 content hash after a normal build'); }
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

  // ---- Case 5: MED-2 — a SAME-SIZE, mtime-PRESERVED content change under an invalid
  //      baseline MUST still be reindexed. mtime+size alone read "unchanged"; only the
  //      content hash (v5) catches it. This is the fail-on-revert guard: on the pre-fix
  //      code the reconcile returns zero changed files and the stale symbol lingers. ----
  const p5 = realpathSync(mkdtempSync(join(ws, 'samesize-')));
  // symAAAA and symBBBB are the same 7-char length, so the file's byte size is invariant.
  await gitCommit(p5, { 'm.js': 'export function symAAAA(){ return 1; }\n' });
  const m5 = join(p5, 'm.js');
  // Pin the file to an EXACT integer-second mtime so it round-trips through utimesSync with
  // no precision loss — the recorded stamp and the restored stamp then match to the ms, so
  // the FAST path genuinely reads "unchanged" and only the hash can catch the edit.
  const fixed = new Date('2020-01-01T00:00:00Z');
  utimesSync(m5, fixed, fixed);
  await runRefresh(p5, ['--full']); // records mtime=fixed, size, hash(symAAAA) for m.js
  const db5 = join(p5, '.wiregraph', 'graph.db');
  { const db = connect(db5, { readonly: true }); has(Q.findSymbol(db, p5, 'symAAAA'), 'm.js', 'inv-base samesize: symAAAA is indexed before the edit'); db.close(); }
  const st5 = S.readState(p5);
  const fullBefore5 = st5.lastFullBuild;
  // Overwrite with the SAME-LENGTH different content (mtime bumps), then RESTORE the exact
  // recorded mtime — a cp -p / rsync -a / coarse-mtime-FS style change that mtime+size miss.
  writeFileSync(m5, 'export function symBBBB(){ return 1; }\n');
  utimesSync(m5, fixed, fixed);
  // At this point mtime+size match what was indexed, so a mtime/size-only reconcile is
  // blind — only the content hash can catch the change.
  // Amend the baseline commit to carry the new content, then orphan it (the bug trigger).
  await execFileP('git', ['-C', p5, 'commit', '--amend', '--no-edit', '-a', '-q']);
  utimesSync(m5, fixed, fixed); // git may touch the working file on amend — re-pin to be sure
  await orphanHead(p5);
  // Direct reconcile call: with the hash tiebreaker the same-size change IS surfaced.
  const rec5 = B.reconcileRepoByContent(p5, p5);
  ok(rec5.ok === true && rec5.files.includes(m5),
    'inv-base samesize: reconcileRepoByContent flags the same-size, mtime-preserved file by content hash (MED-2)');
  await runRefresh(p5);
  const log5 = readFileSync(S.refreshLogPath(p5), 'utf8');
  has(log5, 'by content (1 file', 'inv-base samesize: exactly the one same-size file was reconciled by content');
  eq(S.readState(p5).lastFullBuild, fullBefore5, 'inv-base samesize: NO whole-project rebuild ran (reconciled surgically)');
  const db5after = connect(db5, { readonly: true });
  has(Q.findSymbol(db5after, p5, 'symBBBB'), 'm.js', 'inv-base samesize: the NEW symbol was reindexed despite matching mtime+size');
  has(Q.findSymbol(db5after, p5, 'symAAAA'), 'No symbol named "symAAAA"', 'inv-base samesize: the OLD symbol is gone after reconcile');
  db5after.close();

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

// --- Phase 1a: RESOURCE contracts -------------------------------------------
// The second contract type: two compartments coupled not by a call or a wire but by
// a SHARED RESOURCE (a file path, a DB table+key, shared memory, a named pipe).
// Roles are writer/reader; semantics are presence/state, not request/reply. The join
// key is the shared CONSTANT NAME, never the path literal.
//
// fixture-resource/ compartments (each becomes its own compartment via a .git dir
// created in the temp copy — the committed fixture holds no .git):
//   common/  the shared constants module (join mechanism 1: both sides import it)
//   alpha/   writer of GAME_STATE_PATH (function-scoped) + LOCK_FILE_PATH; also the
//            producer side of a plain WIRE contract living in the same contracts dir
//   beta/    reader of all three resources; also the wire consumer
//   gamma/   a THIRD, read-only compartment — an extra reader on GAME_STATE_PATH
//   delta/   a SECOND writer of LOCK_FILE_PATH, which is declared single_writer
//   bootw/   MODULE-SCOPE writer of BOOT_FLAG_PATH, with its own VENDORED copy of
//   bootr/   the constant (no shared import) — so the resource contract is the ONLY
//            join and the endpoints are the synthetic <module> symbols (R3)
//   epsilon/ reads the same file but names only the bare STRING LITERAL — missed BY
//            DESIGN (wiregraph is literal-blind); asserted below so the limitation
//            is pinned, not accidental
//   zeta/    declared as BOTH writer and reader of CACHE_INDEX_PATH (gamma is its pure
//            reader) — the ONLY thing that makes buildResourceEdges' intra-compartment
//            guard reachable at all. Without a dual-role compartment in the fixture,
//            deleting that guard changes nothing and no assertion can see it.
//   theta/   references BOOT_FLAG_PATH while the spec declares it as NEITHER writer nor
//            reader — an UNDECLARED PARTICIPANT. It derives no RESOURCE edge, so the
//            edge set cannot show it; only its own finding can.
const RESOURCE_COMPARTMENTS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'common', 'bootw', 'bootr', 'zeta', 'theta'];

function resourceFixture(prefix) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cpSync(FIXTURE_RESOURCE, work, { recursive: true });
  for (const c of RESOURCE_COMPARTMENTS) mkdirSync(join(work, c, '.git'), { recursive: true });
  return work;
}
// Every RESOURCE edge as {sc,sn,dc,dn,t,dir} (src/dst compartment+symbol, token, label).
function resourceEdgeRows(conn, project) {
  return conn.prepare(
    `SELECT sp.compartment sc, sp.name sn, dp.compartment dc, dp.name dn, e.token t, e.direction dir, e.contract ct
       FROM edges e JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
      WHERE e.project=? AND e.type='RESOURCE'`).all(project);
}
const resourceKey = (r) => `${r.t}|${r.sc}:${r.sn}->${r.dc}:${r.dn}`;
function resourceEdgeSet(root, project) {
  const c = connect(join(root, '.wiregraph', 'graph.db'), { readonly: true });
  try { return new Set(resourceEdgeRows(c, project).map(resourceKey)); } finally { c.close(); }
}

async function resourceContractTests() {
  const R = await import('../src/extract/resource-spec.js');
  const project = resourceFixture('cg-resource-');
  const db = join(project, '.wiregraph', 'graph.db');
  await runBuild({ target: project, project, db, reset: true });
  const conn = connect(db, { readonly: true });

  // (1) ONE resource contract for the spec — not zero (silently missed), not one per
  // compartment (unlinked halves).
  const contracts = conn.prepare('SELECT id,name,file FROM contracts WHERE project=? ORDER BY name').all(project);
  const resContract = contracts.find((c) => c.name === 'game-state-files');
  eq(contracts.filter((c) => c.name === 'game-state-files').length, 1,
    `resource(1): exactly ONE contract node for the resource spec (got ${contracts.map((c) => c.name).join(', ') || 'none'})`);
  // `file` is the spec's PROJECT-RELATIVE PATH, not a bare basename. Three nested contracts
  // dirs all holding `wiregraph-inferred.asyncapi.yaml` were indistinguishable by it, and
  // traceContract's shadow gate recovers the governing subtree from it (see h5sibling).
  eq(resContract?.file, 'contracts/game-state.resource.yaml',
    'resource(1): the contract node carries the .resource.yaml spec PATH (kind dispatch — and the path is what makes the scope root recoverable at query time)');

  const toks = new Map(conn.prepare('SELECT token,direction,producers,consumers FROM contract_tokens WHERE project=? AND contract=?')
    .all(project, resContract?.id ?? '').map((r) => [r.token, r]));
  eq(toks.size, 4, `resource(1): all four declared resources became tokens (got ${[...toks.keys()].join(', ') || 'none'})`);

  // (2) Roles: writers -> producers, readers -> consumers. alpha writes, beta reads,
  // gamma is the third read-only compartment (an EXTRA reader), delta a SECOND writer.
  eq(toks.get('GAME_STATE_PATH')?.producers, 'alpha', 'resource(2): writers land in producers (alpha writes GAME_STATE_PATH)');
  eq(toks.get('GAME_STATE_PATH')?.consumers, 'beta,gamma', 'resource(2): readers land in consumers, and a read-only third compartment adds a reader');
  eq(toks.get('LOCK_FILE_PATH')?.producers, 'alpha,delta', 'resource(2): a second writer adds a writer');

  // The semantics/single_writer encoding lives in the free-text direction column and
  // round-trips out of the db losslessly, without colliding with c2s/s2c/null.
  const gsDir = R.decodeResourceDirection(toks.get('GAME_STATE_PATH')?.direction);
  eq(gsDir?.kind, 'path', 'resource: kind round-trips through contract_tokens.direction');
  eq(gsDir?.semantics, 'last-writer-wins', 'resource: semantics round-trips through contract_tokens.direction');
  eq(gsDir?.singleWriter, true, 'resource: single_writer round-trips through contract_tokens.direction');
  eq(R.decodeResourceDirection(toks.get('BOOT_FLAG_PATH')?.direction)?.singleWriter, null,
    'resource: an undeclared single_writer decodes back to null (distinct from false)');

  // (3) The seam itself: writer -> reader RESOURCE edges, cross-compartment, w2r.
  //
  // The set is asserted EXACTLY, not by membership. Every check here used to be
  // `keys.has(...)` or `rEdges.every(...)`, and both are satisfied by any SUPERSET —
  // which is why deleting buildResourceEdges' intra-compartment guard, the one thing
  // standing between this fixture and a pile of phantom same-compartment seams,
  // produced zero failures. An exact set is the only shape that can fail on an EXTRA
  // edge, and phantom edges are the whole risk of a token-matching join.
  const rEdges = resourceEdgeRows(conn, project);
  const keys = new Set(rEdges.map(resourceKey));
  const expectedSeams = [
    // GAME_STATE_PATH: alpha writes; beta and gamma read. TWO reader functions live in
    // beta/reader.js — each gets its own seam, which only holds because every distinct
    // enclosing symbol that mentions a token is attributed, not just the first.
    'GAME_STATE_PATH|alpha:alphaWriteState->beta:betaReadState',
    'GAME_STATE_PATH|alpha:alphaWriteState->beta:betaReadStateRaw',
    'GAME_STATE_PATH|alpha:alphaWriteState->gamma:gammaWatchState',
    // LOCK_FILE_PATH: two declared writers (the single_writer violation), one reader.
    'LOCK_FILE_PATH|alpha:alphaTakeLock->beta:betaLockHeld',
    'LOCK_FILE_PATH|delta:deltaTakeLock->beta:betaLockHeld',
    // BOOT_FLAG_PATH: the VENDORED pair, both sides at module scope.
    'BOOT_FLAG_PATH|bootw:<module>->bootr:<module>',
    // CACHE_INDEX_PATH: zeta is declared BOTH writer and reader; gamma is its pure reader.
    // Only zeta -> gamma is a seam. Every zeta -> zeta pair is intra-compartment and must
    // be SKIPPED — internal state the call graph already covers, not a contract. Both zeta
    // symbols land on the writer side because the whole COMPARTMENT is a declared writer,
    // which is what makes the compartment guard (rather than the earlier w.id === r.id
    // check) the thing actually doing the work here.
    'CACHE_INDEX_PATH|zeta:zetaCacheWrite->gamma:gammaCacheRead',
    'CACHE_INDEX_PATH|zeta:zetaCacheRead->gamma:gammaCacheRead',
  ].sort();
  eq(JSON.stringify([...keys].sort()), JSON.stringify(expectedSeams),
    'resource(3): EXACTLY these writer->reader seams — no missing half, and no phantom extras');
  eq(rEdges.length, expectedSeams.length,
    `resource(3): and exactly ${expectedSeams.length} rows, so a duplicated seam cannot hide inside the set (got ${rEdges.length})`);
  ok(!rEdges.some((r) => r.dc === 'alpha' || r.sc === 'beta'),
    'resource(3): no reversed reader->writer edge (roles are directional)');
  ok(rEdges.every((r) => r.dir === 'w2r'),
    `resource(3): every RESOURCE edge is labelled w2r, never c2s (got ${[...new Set(rEdges.map((r) => r.dir))].join(', ') || 'none'})`);
  ok(rEdges.every((r) => r.sc !== r.dc), 'resource(3): resource seams are cross-compartment only');

  // C1 — attribution, at the REFERENCES level where the seam is actually decided.
  // alpha/writer.js and beta/reader.js use a NAMED import, so the first word-bounded
  // occurrence of GAME_STATE_PATH in each file is the import statement at module scope.
  // Taking only that occurrence gave the edge to <module> and left the functions that
  // really use the constant with none — both endpoints collapsed onto <module>, and
  // path_between(writer, reader) answered "No path found" for a seam sitting in the
  // edges table. The import line is not a use, and every other enclosing symbol is.
  const gsRefs = conn.prepare(
    `SELECT s.compartment c, s.name n FROM edges e JOIN symbols s ON s.id=e.src
      WHERE e.project=? AND e.type='REFERENCES' AND e.token='GAME_STATE_PATH' ORDER BY s.compartment, s.name`)
    .all(project).map((r) => `${r.c}:${r.n}`);
  eq(JSON.stringify(gsRefs), JSON.stringify([
    'alpha:alphaWriteState', 'beta:betaReadState', 'beta:betaReadStateRaw', 'gamma:gammaWatchState',
    // NOTE what is absent: `common:<module>`, the constants module's own DEFINITION site
    // (`export const GAME_STATE_PATH = …`). 1a excluded import statements but not
    // definitions, because nothing knew where a constant was defined; 1b-ii feeds
    // matchContracts the extractor's own const-definition index, so a declaration no
    // longer counts as a use. Harmless here only because `common/` is neither a declared
    // writer nor a declared reader — phantomSeamDefinitionSiteTest covers the case where
    // it IS, which is where the phantom seam half was actually minted.
  ]), `resource(C1): every enclosing symbol that USES the constant is attributed, and neither an import line nor the DEFINITION site (got ${gsRefs.join(', ') || 'none'})`);

  // (3) path_between traverses the resource node with NO direct call edge — the whole
  // point of the type. Both a FUNCTION-scoped pair and a MODULE-scoped pair (the
  // latter only works because <module> may now be a BFS seed/goal).
  const callsAlphaBeta = conn.prepare(
    `SELECT count(*) n FROM edges e JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
      WHERE e.project=? AND e.type='CALLS' AND sp.compartment='alpha' AND dp.compartment='beta'`).get(project).n;
  eq(callsAlphaBeta, 0, 'resource(3): there is NO direct call edge between the writer and reader compartments');
  const fnPath = Q.pathBetween(conn, project, 'alphaWriteState', 'betaReadState');
  // Not "some path exists" — the path must NAME THE CONTRACT. Both modules import the
  // shared constants module, so alpha:<module> --IMPORTS--> common:<module>
  // <--IMPORTS-- beta:<module> is a competing 2-hop route; when the references collapsed
  // onto <module> that tie was resolvable either way, and the IMPORTS answer says only
  // "these two files share a dependency" — it never names the resource they share.
  has(fnPath, 'game-state-files', 'resource(C18): path_between(function-scoped) routes through the RESOURCE CONTRACT node, not a shared-import path');
  ok(!fnPath.includes('IMPORTS') && !fnPath.includes('constants.js'),
    `resource(C18): the answer is the contract seam, not the shared constants module — got:\n${fnPath}`);
  has(fnPath, 'betaReadState', 'resource(3): path_between(function-scoped) reaches the reader');
  ok(!fnPath.includes('CALLS'), `resource(3): the writer->reader path uses no CALLS edge — got:\n${fnPath}`);
  const modPath = Q.pathBetween(conn, project, '<module>', '<module>', 'bootw', 'bootr');
  has(modPath, 'game-state-files', 'resource(3): path_between(MODULE-scoped) routes through the resource contract node (R3)');
  has(modPath, 'bootr:boot.js', 'resource(3): path_between(MODULE-scoped) reaches the reader side');

  // find_symbol/get_source keep the old filtered behavior — only path_between opts in.
  has(Q.findSymbol(conn, project, '<module>'), 'No symbol named', 'resource(R3): find_symbol still hides the synthetic <module> symbol');

  // (4) The join key is the CONSTANT, not the literal: epsilon reads the same path but
  // only as a bare string, so it is MISSED. Documented, intended, and pinned here.
  const refComps = new Set(conn.prepare(
    "SELECT DISTINCT s.compartment c FROM edges e JOIN symbols s ON s.id=e.src WHERE e.project=? AND e.type='REFERENCES'")
    .all(project).map((r) => r.c));
  ok(refComps.has('alpha') && refComps.has('beta'), 'resource(4): constant-naming compartments are matched');
  ok(!refComps.has('epsilon'),
    `resource(4): a compartment naming only the bare string literal is MISSED by design (got [${[...refComps].join(', ')}])`);

  // (5) A declared single-writer resource with two writers is a flagged VIOLATION,
  // never a silent merge.
  //
  // ORTHOGONAL to the drift verdict, and the precedence is PINNED IN BOTH DIRECTIONS
  // below. As a fourth mutually-exclusive verdict it suppressed whichever of the two
  // findings lost: checked first (as it was), a resource whose constant NO code
  // references reported `unreferenced: 0` and never showed 🔴 DRIFT — the tool's
  // strongest signal traded for a declaration-hygiene complaint; checked last, the
  // violation would vanish on any drifted resource instead. Swapping the order produced
  // zero failures, so neither direction was pinned at all.
  eq(Q.classifyContractToken(new Set(['alpha', 'beta']), toks.get('LOCK_FILE_PATH')), 'satisfied',
    'resource(5): the drift verdict is unaffected by a single-writer violation');
  ok(Q.singleWriterViolation(toks.get('LOCK_FILE_PATH')),
    'resource(5): the violation is reported as its own orthogonal flag');
  ok(!Q.singleWriterViolation(toks.get('GAME_STATE_PATH')),
    'resource(5): single_writer with ONE declared writer is not a violation');
  ok(!Q.singleWriterViolation(toks.get('BOOT_FLAG_PATH')),
    'resource(5): a resource that never declared single_writer is not a violation');
  // Both findings on ONE token, in both orders. A violating resource that NOTHING
  // references must report unreferenced AND in violation.
  const lockMeta = toks.get('LOCK_FILE_PATH');
  eq(Q.classifyContractToken(new Set(), lockMeta), 'unreferenced',
    'resource(5): a violating resource that no code references is still UNREFERENCED (drift is not suppressed)');
  ok(Q.singleWriterViolation(lockMeta),
    'resource(5): …and is still in violation at the same time (the violation is not suppressed either)');
  eq(Q.classifyContractToken(new Set(['alpha']), lockMeta), 'one-sided',
    'resource(5): a violating resource with only its writer side present is still ONE-SIDED');

  // C12 — classifyContractToken is EXPORTED and its predecessor did `new Set(meta.producers)`,
  // which accepted any iterable. Narrowing that to "Array or non-empty string" silently
  // answered hasRoles === false for an outside caller passing a Set — the role-aware
  // branch skipped entirely, falling back to the count heuristic. No in-repo caller does
  // it; the exported contract is the point.
  // The probe must be a case where the ROLE-AWARE branch and the role-less COUNT
  // fallback DISAGREE, or it proves nothing: two compartments referencing the token but
  // both on the SAME role side is "one-sided" to the role-aware branch and "satisfied"
  // (n >= 2) to the fallback. Anything else passes with the roles thrown away.
  const twoProducers = { producers: new Set(['alpha', 'delta']), consumers: new Set(['beta']) };
  eq(Q.classifyContractToken(new Set(['alpha', 'delta']), twoProducers), 'one-sided',
    'resource(C12): roles handed over as a SET are still READ as roles — two same-role compartments are a gap, not a seam');
  eq(Q.classifyContractToken(new Set(['alpha', 'beta']), twoProducers), 'satisfied',
    'resource(C12): …and a genuine producer+consumer pair still classifies as satisfied');
  eq(Q.classifyContractToken(new Set(['alpha', 'delta']), { producers: 'alpha,delta', consumers: 'beta' }), 'one-sided',
    'resource(C12): a raw comma-joined CSV row is still split, never read one character at a time');
  eq(Q.classifyContractToken(new Set(['alpha', 'delta']), { producers: ['alpha', 'delta'], consumers: ['beta'] }), 'one-sided',
    'resource(C12): and the ordinary Array shape is unchanged');
  // (5b) M9 — the UNDECLARED PARTICIPANT, which replaces an "observed single-writer
  // breach" that could not see the case that mattered. That check intersected the
  // referencing compartments with the DECLARED writer list, so observed was a subset of
  // declared by construction: an UNDECLARED second writer — the only thing a user cannot
  // already read off the spec — was invisible to it. wiregraph does not detect WRITES, so
  // "two writers are really writing" is not knowable; "a compartment touches this
  // resource and the spec does not mention it" is, exactly.
  eq(JSON.stringify(Q.undeclaredParticipants(new Set(['bootw', 'bootr', 'theta']), toks.get('BOOT_FLAG_PATH'))),
    JSON.stringify(['theta']),
    'resource(5b/M9): a compartment that references the resource but is declared neither writer nor reader is surfaced');
  eq(JSON.stringify(Q.undeclaredParticipants(new Set(['bootw', 'bootr']), toks.get('BOOT_FLAG_PATH'))), JSON.stringify([]),
    'resource(5b/M9): …and a fully declared reference set surfaces nothing');
  eq(JSON.stringify(Q.undeclaredParticipants(new Set(['alpha', 'delta', 'beta']), lockMeta)), JSON.stringify([]),
    'resource(5b/M9): two declared writers both referencing the constant is NOT an undeclared participant (it is the declared violation, already reported)');
  // WIRE tokens are untouched: this is a resource-contract finding, keyed on the resource
  // direction encoding, so an AsyncAPI channel with a third referencing compartment
  // reports exactly what it did before.
  eq(JSON.stringify(Q.undeclaredParticipants(new Set(['x']), { producers: 'alpha', consumers: 'beta', direction: 'c2s' })), JSON.stringify([]),
    'resource(5b/M9): a WIRE token is not subject to the resource undeclared-participant check');

  const trace = Q.traceContract(conn, project, 'game-state');
  has(trace, '1 single-writer violation', 'resource(5): trace_contract counts the violation in its headline');
  // theta references BOOT_FLAG_PATH and the spec accounts for neither role.
  has(trace, '1 with undeclared participant', 'resource(5b/M9): trace_contract counts the undeclared participant in its headline');
  has(trace, 'UNDECLARED', 'resource(5b/M9): …and flags it distinctly from the declared VIOLATION');
  has(trace, 'neither writer nor reader', 'resource(5b/M9): the detail line says what is missing from the spec');
  has(trace, 'cannot tell a write from a read', 'resource(5b/M9): …and says plainly that wiregraph has no write detection, rather than implying one');
  ok(!trace.includes('OBSERVED-BREACH'),
    'resource(5b/M9): the old observed-breach claim — a detection wiregraph does not have — is gone');
  eq(Q.contractDriftByName(conn, project, false).get('game-state-files')?.undeclared, 1,
    'resource(5b/M9): contractDriftByName counts undeclared participants on their own key');
  has(trace, 'LOCK_FILE_PATH', 'resource(5): trace_contract names the violating resource');
  has(trace, 'alpha, delta', 'resource(5): trace_contract names both declared writers');
  const drift = Q.contractDriftByName(conn, project, false);
  eq(drift.get('game-state-files')?.violations, 1, 'resource(5): contractDriftByName counts the violation');
  eq(drift.get('game-state-files')?.status, 'violation', 'resource(5): contractDriftByName reports a violation status');
  eq(drift.get('game-state-files')?.unreferenced, 0,
    'resource(5): …while the drift counters stay independent of it (the violating token still classified as satisfied)');
  // Wire wording must not leak into a resource report.
  ok(!trace.includes('consumer half missing') && !trace.includes('producer half missing'),
    'resource: a resource report never speaks producer/consumer halves');

  // (6) NO wire regression: the AsyncAPI spec sitting in the SAME contracts dir still
  // infers its route seam exactly as before, through the new extension dispatch.
  const wires = conn.prepare(
    `SELECT sp.compartment sc, dp.compartment dc, e.token t FROM edges e
       JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
      WHERE e.project=? AND e.type='WIRE'`).all(project);
  eq(wires.length, 1, `resource(6): the co-located wire contract still derives exactly its own WIRE edge (got ${wires.length})`);
  eq(wires[0]?.sc, 'alpha', 'resource(6): the wire seam is still oriented producer -> consumer');
  eq(wires[0]?.dc, 'beta', 'resource(6): the wire seam still lands on the consumer compartment');
  eq(wires[0]?.t, '/api/resource-ping', 'resource(6): the wire seam still keys on the route token');
  const wireDrift = drift.get('resource-fixture-wire');
  eq(wireDrift?.status, 'ok', 'resource(6): the wire contract is still classified exactly as before');
  // …including its SHAPE. contractDriftByName rows are embedded verbatim into
  // export-html's DATA blob, so a `violations: 0` key on every row would change the
  // bytes of every generated visualization for every wire-only project — output churn
  // for a feature they do not use. Omitted when zero; the key order is unchanged too.
  ok(!('violations' in (wireDrift || {})),
    `resource(6/C11): a contract with no violations carries NO violations key, so wire-only export output is byte-identical (got ${JSON.stringify(wireDrift)})`);
  eq(JSON.stringify(Object.keys(wireDrift || {})), JSON.stringify(['total', 'satisfied', 'oneSided', 'unreferenced', 'status']),
    'resource(6/C11): and the surviving keys are in their original order');

  conn.close();
  rmSync(project, { recursive: true, force: true });
}

// R1 — the INCREMENTAL path. `type='WIRE'` is a hardcoded literal in BOTH the
// per-file prune (pruneFile's delWireOf) and the project-wide re-derive
// (rederiveWireEdges). If resource derivation is not plumbed into both, every
// resource seam is deleted on the first file save after a full build and never
// rebuilt — WHILE EVERY FULL-BUILD TEST STILL PASSES. So this test is not optional
// coverage: it is the only thing that catches that failure.
async function resourceIncrementalSeamTest() {
  const project = resourceFixture('cg-resinc-');
  await runBuild({ target: project, project, reset: true });
  const full = resourceEdgeSet(project, project);
  ok(full.size >= 4, `resource-inc: resource seams present after the full build (got ${full.size})`);

  // (a) touch the WRITER: a body-only edit routed through the incremental path.
  writeFileSync(join(project, 'alpha', 'writer.js'),
    "import { writeFileSync } from 'node:fs';\n" +
    "import * as shared from '../common/constants.js';\n" +
    'export function alphaWriteState(state) {\n' +
    '  writeFileSync(shared.GAME_STATE_PATH, JSON.stringify({ ...state, v: 2 }));\n' +
    '  return state;\n' +
    '}\n' +
    "export async function alphaPing() { return fetch('/api/resource-ping', { method: 'POST' }); }\n");
  await runBuild({ target: project, project, files: [join(project, 'alpha', 'writer.js')] });
  const afterEdit = resourceEdgeSet(project, project);
  ok(afterEdit.size >= 4,
    `resource-inc(a): resource seams SURVIVE an incremental edit to the writer (got ${afterEdit.size}: ${[...afterEdit].join(' , ') || 'none'})`);
  ok(setEq(afterEdit, full), `resource-inc(a): the incremental resource seam set EQUALS the full build's (inc ${[...afterEdit].join(' , ') || 'none'} | full ${[...full].join(' , ') || 'none'})`);
  // The re-derive REPLACES the project's derived seams (delete-all-then-reinsert). If
  // the delete still covered only WIRE, every untouched pair would be re-inserted
  // alongside its surviving row — a duplicate the Set comparison above cannot see.
  eq(edgeCount(project, project, 'RESOURCE'), afterEdit.size,
    'resource-inc(a): the re-derive REPLACES the resource seams rather than duplicating them');
  eq(edgeCount(project, project, 'WIRE'), 1, 'resource-inc(a): the co-located WIRE seam also survives the same incremental pass');

  // (b) touch an UNRELATED file in a compartment that touches no contract.
  writeFileSync(join(project, 'epsilon', 'other.js'), 'export function noop() { return 1; }\n');
  await runBuild({ target: project, project, files: [join(project, 'epsilon', 'other.js')] });
  ok(setEq(resourceEdgeSet(project, project), full), 'resource-inc(b): an unrelated incremental edit leaves the resource seams intact');

  // (c) touch a MODULE-SCOPE side: the vendored bootw/bootr pair, whose endpoints are
  // <module> symbols, must re-derive too.
  writeFileSync(join(project, 'bootw', 'boot.js'),
    "import { writeFileSync } from 'node:fs';\n" +
    "const BOOT_FLAG_PATH = '/var/run/game/booted.flag';\n" +
    "writeFileSync(BOOT_FLAG_PATH, 'up2');\n");
  await runBuild({ target: project, project, files: [join(project, 'bootw', 'boot.js')] });
  ok(resourceEdgeSet(project, project).has('BOOT_FLAG_PATH|bootw:<module>->bootr:<module>'),
    'resource-inc(c): a module-scope resource seam survives an incremental edit to the writer file');

  // (d) DELETE the reader: the seam is one-sided now, so it must leave NO dangling edge.
  rmSync(join(project, 'beta', 'reader.js'), { force: true });
  await runBuild({ target: project, project, files: [join(project, 'beta', 'reader.js')] });
  const afterDelete = resourceEdgeSet(project, project);
  ok(!afterDelete.has('GAME_STATE_PATH|alpha:alphaWriteState->beta:betaReadState'),
    'resource-inc(d): deleting the reader drops its resource seam');
  const c = connect(join(project, '.wiregraph', 'graph.db'), { readonly: true });
  const symIds = new Set(c.prepare('SELECT id FROM symbols WHERE project=?').all(project).map((r) => r.id));
  const dangling = c.prepare("SELECT src,dst FROM edges WHERE project=? AND type='RESOURCE'").all(project)
    .filter((r) => !symIds.has(r.src) || !symIds.has(r.dst));
  c.close();
  eq(dangling.length, 0, 'resource-inc(d): no RESOURCE edge references a vanished symbol');
  ok(afterDelete.has('GAME_STATE_PATH|alpha:alphaWriteState->gamma:gammaWatchState'),
    'resource-inc(d): the surviving reader keeps its seam');

  rmSync(project, { recursive: true, force: true });
}

// --- Phase 1b-ii: RESOURCE seam INFERENCE ------------------------------------
// fixture-resource-infer/ compartments (each gets a .git in the temp copy):
//   shared/       defines SHARED_STATE_PATH and NEVER uses it — the constants module
//   svc-writer/   } import it and use it: only ONE compartment defines the constant, so
//   svc-reader/   } definitions alone find one compartment and no seam. Mechanism 1.
//   vend-a/       } their OWN copy of VENDORED_LOCK_PATH, same name AND same value, with
//   vend-b/       } no cross-compartment import at all. Mechanism 2.
//   py-a/ py-b/   the vendored join in a language that emits NO import candidates, so
//                 mechanism 1 cannot fire even in principle
//   mismatch-a/   } same NAME, DIFFERENT value — a shared spelling, not a shared
//   mismatch-b/   } resource. MUST be rejected.
//   local-a/      } an identical FUNCTION-LOCAL const in two compartments — the measured
//   local-b/      } false-positive shape, excluded at extraction (module scope required)
//   msg-a/ msg-b/ an identical shared MESSAGE string: a shared spelling of prose, not a
//                 resource identifier (the one FP the scan proposed on wiregraph itself)
//   major-a/      } two agree on /var/spool/infer/q, one holds a stale copy — the seam is
//   major-b/      } emitted for the MAJORITY and the outlier is excluded and REPORTED,
//   major-stale/  } instead of one divergent copy killing the seam for everybody (M11)
//   literal-only/ reads the same file as svc-* but names ONLY the bare string literal —
//                 missed BY DESIGN (§11 item 4: the join key is the constant, not the value)
//   solo/         defined and used in one compartment: internal state, not a seam
const FIXTURE_RESOURCE_INFER = join(HERE, 'fixture-resource-infer');
function resourceInferFixture(prefix) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cpSync(FIXTURE_RESOURCE_INFER, work, { recursive: true });
  for (const d of readdirSync(work)) mkdirSync(join(work, d, '.git'), { recursive: true });
  return work;
}

async function resourceInferenceTests() {
  const I = await import('../src/contracts/infer.js');
  const R = await import('../src/extract/resource-spec.js');
  const YAML = (await import('yaml')).default;
  const work = resourceInferFixture('cg-resinfer-');

  const { candidates, comments } = I.extractSignals(work);
  const rejected = [];
  const seams = I.clusterResourceSeams(candidates, work, { comments, rejected }) || [];
  const byTok = new Map(seams.map((s) => [s?.token, s]));
  const found = seams.map((s) => s?.token).join(', ') || 'none';

  // --- BOTH join mechanisms, in separate compartment pairs ------------------
  eq(byTok.get('SHARED_STATE_PATH')?.layout, 'shared-module',
    `resource-infer(shared): a constant DEFINED once and REFERENCED from two compartments is a seam (got ${found})`);
  eq(JSON.stringify(byTok.get('SHARED_STATE_PATH')?.compartments), JSON.stringify(['svc-reader', 'svc-writer']),
    `resource-infer(shared): the seam names the two USING compartments (got ${JSON.stringify(byTok.get('SHARED_STATE_PATH')?.compartments)})`);
  // Definitions alone cannot find this one: only `shared` defines it. Pinning the
  // definer set proves the second compartment came from REFERENCE discovery, not from a
  // second definition.
  eq(JSON.stringify(byTok.get('SHARED_STATE_PATH')?.definers), JSON.stringify(['shared']),
    'resource-infer(shared): exactly ONE compartment defines it — the other participants are found by reference');
  eq(JSON.stringify(byTok.get('SHARED_STATE_PATH')?.corroborated), JSON.stringify(['svc-reader', 'svc-writer']),
    `resource-infer(shared): the IMPORTS edge corroborates both sides (got ${JSON.stringify(byTok.get('SHARED_STATE_PATH')?.corroborated)})`);

  eq(byTok.get('VENDORED_LOCK_PATH')?.layout, 'vendored',
    `resource-infer(vendored): per-compartment copies of the same name+value are a seam (got ${found})`);
  eq(JSON.stringify(byTok.get('VENDORED_LOCK_PATH')?.compartments), JSON.stringify(['vend-a', 'vend-b']),
    'resource-infer(vendored): both vendored compartments participate');
  eq(JSON.stringify(byTok.get('VENDORED_LOCK_PATH')?.corroborated), JSON.stringify([]),
    'resource-infer(vendored): …with NO import corroboration available — mechanism 2 stands alone (§11: not optional)');
  eq(byTok.get('PY_QUEUE_PATH')?.layout, 'vendored',
    `resource-infer(vendored): and in Python, which emits no import candidates at all (got ${found})`);

  // --- what MUST be rejected -------------------------------------------------
  ok(!byTok.has('CONFLICT_CACHE_PATH'),
    `resource-infer(reject): the same constant NAME with DIFFERENT values in two compartments is NOT a seam (got ${found})`);
  ok(!byTok.has('LOCAL_SCRATCH_PATH'),
    `resource-infer(reject): an identical FUNCTION-LOCAL const in two compartments is not a seam — module scope is required at extraction (got ${found})`);
  ok(!byTok.has('SOLO_STATE_PATH'),
    `resource-infer(reject): a constant used in ONE compartment is internal state, not a seam (got ${found})`);
  ok(!byTok.has('OPERATOR_HINT_TEXT'),
    `resource-infer(reject): a shared human-readable MESSAGE is a shared string, not a shared resource — a resource id has no whitespace in it (got ${found})`);
  // The definition site is not a use: `shared/` declares the name and touches nothing.
  ok(!(byTok.get('SHARED_STATE_PATH')?.compartments || []).includes('shared'),
    'resource-infer(reject): the compartment that only DEFINES the constant is not a participant');
  // M11 — one stale copy must not kill the seam for the compartments that DO agree.
  eq(JSON.stringify(byTok.get('MAJORITY_QUEUE_PATH')?.compartments), JSON.stringify(['major-a', 'major-b']),
    `resource-infer(majority): two compartments agreeing plus one stale copy still yields a seam, for the agreeing majority (got ${found})`);
  eq(byTok.get('MAJORITY_QUEUE_PATH')?.value, '/var/spool/infer/q',
    'resource-infer(majority): …on the majority value');
  eq(JSON.stringify(byTok.get('MAJORITY_QUEUE_PATH')?.outliers),
    JSON.stringify([{ compartment: 'major-stale', value: '/var/spool/infer/q-old' }]),
    `resource-infer(majority): …and the divergent copy is carried as a reported OUTLIER (got ${JSON.stringify(byTok.get('MAJORITY_QUEUE_PATH')?.outliers)})`);
  ok(rejected.some((r) => r.startsWith('MAJORITY_QUEUE_PATH: major-stale disagrees')),
    `resource-infer(majority): …and named in the declined report, not dropped silently (got ${JSON.stringify(rejected)})`);
  ok(rejected.some((r) => r.startsWith('CONFLICT_CACHE_PATH: 2 different values with no majority')),
    'resource-infer(reject): a genuine TIE has no majority to pick, so it is still dropped whole — with a reason');
  // §11 item 4, on the inference side: literal-only/ reads the very same file and is
  // MISSED, because the join key is the CONSTANT and not its value.
  ok(!(byTok.get('SHARED_STATE_PATH')?.compartments || []).includes('literal-only'),
    `resource-infer(literal): a compartment naming only the bare string literal is not a participant (got ${JSON.stringify(byTok.get('SHARED_STATE_PATH')?.compartments)})`);
  eq(seams.length, 4, `resource-infer: exactly four seams, so nothing extra slipped in (got ${found})`);

  // --- the wire path is untouched by any of this ----------------------------
  eq((I.clusterSeams(candidates) || []).length, 0,
    'resource-infer: const candidates still mint ZERO wire seams — the two clusterers stay separate');

  // --- the emitted draft passes the loader's OWN validator ------------------
  const yaml = I.synthesizeResourceSpec(seams);
  const vlog = [];
  const desc = R.parseResourceSpec(YAML.parse(yaml), 'wiregraph-inferred.resource.yaml', (m) => vlog.push(m));
  eq(desc?.kind, 'resource', `resource-infer(emit): the synthesized spec parses as a resource contract (log: ${vlog.join(' | ') || 'none'})`);
  eq(JSON.stringify(desc?.tokens), JSON.stringify(['MAJORITY_QUEUE_PATH', 'PY_QUEUE_PATH', 'SHARED_STATE_PATH', 'VENDORED_LOCK_PATH']),
    `resource-infer(emit): every inferred id survives validation — no id is rejected for "/", whitespace, distinctiveness or duplication (got ${JSON.stringify(desc?.tokens)})`);
  // H7 — the emitted draft must load with ZERO warnings. Total role overlap is the
  // DEFINED shape of a draft (roles unresolved), so warning about it means one ⚠ per
  // resource on every build forever, in the same marker as a genuine problem.
  ok(!vlog.some((m) => m.includes('⚠')),
    `resource-infer(emit/H7): the generated draft loads with zero warnings (got ${vlog.join(' | ') || 'none'})`);
  has(yaml, 'x-wiregraph-inferred: true',
    'resource-infer(emit/H7): …because it carries the generated-draft marker that suppresses exactly that warning');
  // A DISTINCT title from the AsyncAPI draft's. loadAllContracts refuses a title
  // collision that spans formats by keeping the AsyncAPI side and SKIPPING the resource
  // side, so sharing 'wiregraph-inferred' would silently discard every inferred seam.
  eq(desc?.name, 'wiregraph-inferred-resources', 'resource-infer(emit): the resource draft has its own title');
  ok(desc?.name !== 'wiregraph-inferred', 'resource-infer(emit): …distinct from the AsyncAPI draft title (a cross-format collision drops the resource spec)');
  // single_writer is never INVENTED: it is a declared DISCIPLINE, and guessing one
  // manufactures violations out of nothing. Asserted on the DECODED value (null =
  // undeclared, distinct from a declared false), not on the file text — the header
  // comment mentions the field by name to tell the reviewer to add it where it holds.
  eq(R.decodeResourceDirection(desc?.direction?.SHARED_STATE_PATH)?.singleWriter, null,
    `resource-infer(emit): the draft declares NO single-writer discipline (got ${JSON.stringify(desc?.direction?.SHARED_STATE_PATH)})`);
  eq(R.decodeResourceDirection(desc?.direction?.SHARED_STATE_PATH)?.kind, 'path',
    'resource-infer(emit): kind is read off the constant value shape and is a valid format kind');
  has(yaml, 'WRITERS/READERS ARE UNRESOLVED',
    'resource-infer(emit): the draft says out loud that roles are unresolved, rather than guessing a direction');
  // Roles: every participant on BOTH sides. An honest "I could not tell" — a guessed
  // direction does not degrade a resource seam, it INVERTS it.
  const shared = (desc?.wireRoles || new Map()).get('SHARED_STATE_PATH');
  eq(JSON.stringify([...(shared?.producers || [])].sort()), JSON.stringify(['svc-reader', 'svc-writer']),
    'resource-infer(emit): every participating compartment is listed as a writer');
  eq(JSON.stringify([...(shared?.consumers || [])].sort()), JSON.stringify(['svc-reader', 'svc-writer']),
    'resource-infer(emit): …and as a reader — the symmetric superset the reviewer prunes');

  rmSync(work, { recursive: true, force: true });
}

// TASK 6 / C2 — the definition site is not a use. 1a excluded IMPORT lines from minting
// REFERENCES, but `export const X = "…"` is not an import, so the constants module's own
// declaration still minted one. When that module sits inside a DECLARED WRITER
// compartment (the ordinary case: a service owns the constants it publishes), the
// declaration manufactures a second writer endpoint and a phantom seam half from a file
// that touches nothing. 1a could not close it — nothing knew where a constant was
// defined. This is the test it could not write.
async function phantomSeamDefinitionSiteTest() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-phantomdef-')));
  for (const d of ['alpha', 'beta']) mkdirSync(join(work, d, '.git'), { recursive: true });
  // The constants module lives INSIDE the declared writer compartment.
  writeFileSync(join(work, 'alpha', 'constants.js'),
    "export const PHANTOM_STATE_PATH = '/var/run/phantom/state.json';\n");
  writeFileSync(join(work, 'alpha', 'writer.js'),
    "import { writeFileSync } from 'node:fs';\n"
    + "import { PHANTOM_STATE_PATH } from './constants.js';\n"
    + 'export function phantomWrite(s) { writeFileSync(PHANTOM_STATE_PATH, s); }\n');
  writeFileSync(join(work, 'beta', 'reader.js'),
    "import { readFileSync } from 'node:fs';\n"
    + "import { PHANTOM_STATE_PATH } from '../alpha/constants.js';\n"
    + "export function phantomRead() { return readFileSync(PHANTOM_STATE_PATH, 'utf8'); }\n");
  mkdirSync(join(work, 'contracts'), { recursive: true });
  writeFileSync(join(work, 'contracts', 'phantom.resource.yaml'),
    'title: phantom-state\nresources:\n  - id: PHANTOM_STATE_PATH\n    kind: path\n'
    + '    semantics: last-writer-wins\n    writers: [alpha]\n    readers: [beta]\n');

  const db = join(work, '.wiregraph', 'graph.db');
  await runBuild({ target: work, project: work, db, reset: true });

  const refsOf = () => {
    const c = connect(db, { readonly: true });
    try {
      return c.prepare(
        `SELECT s.compartment cc, s.file f, s.name n FROM edges e JOIN symbols s ON s.id=e.src
          WHERE e.project=? AND e.type='REFERENCES' AND e.token='PHANTOM_STATE_PATH'
          ORDER BY s.compartment, s.file, s.name`).all(work).map((r) => `${r.cc}:${r.f}:${r.n}`);
    } finally { c.close(); }
  };
  const resourceEdges = () => {
    const c = connect(db, { readonly: true });
    try {
      return c.prepare(
        `SELECT sp.name sn, dp.name dn FROM edges e JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
          WHERE e.project=? AND e.type='RESOURCE' ORDER BY sp.name, dp.name`).all(work).map((r) => `${r.sn}->${r.dn}`);
    } finally { c.close(); }
  };

  eq(JSON.stringify(refsOf()), JSON.stringify(['alpha:writer.js:phantomWrite', 'beta:reader.js:phantomRead']),
    `phantom-def: the constants module's own DEFINITION mints no REFERENCES — a declaration is not a use (got ${refsOf().join(', ') || 'none'})`);
  eq(JSON.stringify(resourceEdges()), JSON.stringify(['phantomWrite->phantomRead']),
    `phantom-def: so the seam has exactly ONE writer endpoint, not a phantom <module> half (got ${resourceEdges().join(', ') || 'none'})`);

  // The nudge gate counts RESOURCE seams too. This project has no route or topic
  // anywhere, so under a wire-only count it would report zero inferrable seams and
  // /wiregraph-contracts — which has something real to offer it — would never be
  // suggested. It is counted with the SAME exclusion set /wiregraph-contracts applies,
  // though: a seam the user has already written down by hand is not one still to infer.
  // Here the spec above declares PHANTOM_STATE_PATH, so the answer is zero — and it is
  // zero for the RIGHT reason, which the paired build below pins.
  const S = await import('../scripts/lib/state.mjs');
  eq(S.readState(work)?.inferredSeams, 0,
    `phantom-def: a seam already declared by hand is not counted as one left to infer (got ${S.readState(work)?.inferredSeams})`);
  const spec = join(work, 'contracts', 'phantom.resource.yaml');
  const specYaml = readFileSync(spec, 'utf8');
  rmSync(spec);
  await runBuild({ target: work, project: work, db, reset: true });
  eq(S.readState(work)?.inferredSeams, 1,
    `phantom-def: …and with nothing declared the same resource-only project DOES report one (got ${S.readState(work)?.inferredSeams})`);
  writeFileSync(spec, specYaml);
  await runBuild({ target: work, project: work, db, reset: true });

  // The INCREMENTAL path re-mints REFERENCES for the files it touches, with its own
  // const-definition index. Saving the constants module itself is precisely the edit that
  // would resurrect the phantom edge if only the full build knew the rule.
  appendFileSync(join(work, 'alpha', 'constants.js'), '// touched\n');
  await runBuild({ target: work, project: work, db, files: [join(work, 'alpha', 'constants.js')] });
  eq(JSON.stringify(refsOf()), JSON.stringify(['alpha:writer.js:phantomWrite', 'beta:reader.js:phantomRead']),
    `phantom-def: …and saving the constants module does not resurrect it on the incremental path (got ${refsOf().join(', ') || 'none'})`);
  eq(JSON.stringify(resourceEdges()), JSON.stringify(['phantomWrite->phantomRead']),
    'phantom-def: the derived seam is unchanged after the incremental re-derive');

  rmSync(work, { recursive: true, force: true });
}

// End to end through the CLI the command actually runs: scan (no writes) -> apply
// (writes both formats into the contracts home) -> rebuild -> the graph carries a
// resource contract whose ids the loader ACCEPTED and whose seams derive RESOURCE edges.
// A spec its own validator rejects would show up here as a contract with no tokens.
async function resourceInferenceCliTest() {
  const CONTRACTS = join(HERE, '..', 'scripts', 'contracts.mjs');
  const work = resourceInferFixture('cg-resinfer-cli-');
  const specPath = join(work, 'contracts', 'wiregraph-inferred.resource.yaml');

  const scan = await execFileP('node', [CONTRACTS, 'scan', work]);
  has(scan.stdout, 'RESOURCE seam(s)', 'resource-cli scan: reports the resource seams alongside the wire ones');
  has(scan.stdout, 'SHARED_STATE_PATH', 'resource-cli scan: names the shared-module seam');
  has(scan.stdout, 'VENDORED_LOCK_PATH', 'resource-cli scan: names the vendored seam');
  has(scan.stdout, 'No cross-compartment WIRE seams', 'resource-cli scan: still reports the wire side, which is empty here');
  ok(!scan.stdout.split('Named constants considered and DECLINED')[0].includes('CONFLICT_CACHE_PATH'),
    'resource-cli scan: the same-name/different-value pair is not PROPOSED as a seam');
  has(scan.stdout, 'Named constants considered and DECLINED',
    'resource-cli scan: …and the constants it declined are reported with reasons, not dropped silently');
  has(scan.stdout, 'CONFLICT_CACHE_PATH: 2 different values with no majority',
    'resource-cli scan: the declined list says WHY, naming both values');
  has(scan.stdout, 'MAJORITY_QUEUE_PATH: major-stale disagrees',
    'resource-cli scan: a divergent copy that did NOT kill the seam is still named as an outlier');
  ok(!existsSync(specPath), 'resource-cli scan: is a dry run — no spec written');

  const apply = await execFileP('node', [CONTRACTS, 'apply', work]);
  has(apply.stdout, '4 resource(s)', 'resource-cli apply: reports what it wrote');
  has(apply.stdout, 'BOTH writer and reader', 'resource-cli apply: tells the user the roles still need pruning');
  ok(existsSync(specPath), 'resource-cli apply: writes contracts/wiregraph-inferred.resource.yaml');
  ok(!existsSync(join(work, 'contracts', 'wiregraph-inferred.asyncapi.yaml')),
    'resource-cli apply: writes NO AsyncAPI draft when there are no wire seams');

  await runBuild({ target: work, project: work, reset: true });
  const c = connect(join(work, '.wiregraph', 'graph.db'), { readonly: true });
  const toks = c.prepare(
    `SELECT ct.token t FROM contract_tokens ct JOIN contracts co ON co.id=ct.contract
      WHERE ct.project=? AND co.name='wiregraph-inferred-resources' ORDER BY ct.token`).all(work).map((r) => r.t);
  eq(JSON.stringify(toks), JSON.stringify(['MAJORITY_QUEUE_PATH', 'PY_QUEUE_PATH', 'SHARED_STATE_PATH', 'VENDORED_LOCK_PATH']),
    `resource-cli: the applied draft LOADS — every id accepted by the same validator that would reject it (got ${toks.join(', ') || 'none'})`);
  const pairs = new Set(c.prepare(
    `SELECT sp.compartment sc, dp.compartment dc, e.token t FROM edges e
       JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
      WHERE e.project=? AND e.type='RESOURCE'`).all(work).map((r) => `${r.t}|${r.sc}->${r.dc}`));
  ok(pairs.has('SHARED_STATE_PATH|svc-writer->svc-reader'), `resource-cli: the shared-module seam derives a RESOURCE edge (got ${[...pairs].join(', ') || 'none'})`);
  ok(pairs.has('VENDORED_LOCK_PATH|vend-a->vend-b'), 'resource-cli: the vendored seam derives one too');
  ok(pairs.has('PY_QUEUE_PATH|py-a->py-b'), 'resource-cli: and the Python vendored pair');
  ok(pairs.has('MAJORITY_QUEUE_PATH|major-a->major-b'), 'resource-cli: and the majority seam');
  ok(![...pairs].some((p) => p.includes('major-stale')),
    `resource-cli: …with the stale divergent copy in no seam at all (got ${[...pairs].join(', ') || 'none'})`);
  // Roles are unresolved, so the seam is symmetric until the user prunes the lists —
  // stated in the draft header and pinned here so it is a decision, not a surprise.
  ok(pairs.has('SHARED_STATE_PATH|svc-reader->svc-writer'),
    'resource-cli: with roles unresolved the seam derives in BOTH directions (the symmetric superset, not a guessed direction)');
  ok(![...pairs].some((p) => p.includes('shared->') || p.includes('->shared')),
    `resource-cli: the constants module compartment is in no seam at all (got ${[...pairs].join(', ') || 'none'})`);
  // §11 acceptance item 3, for an INFERRED spec. It held live for the HAND-WRITTEN
  // fixture and was only ever asserted there, so nothing pinned that a spec wiregraph
  // WROTE ITSELF is traversable — which is the case every user actually hits.
  const vendPath = Q.pathBetween(c, work, 'vendATakeLock', 'vendBLockHeld');
  has(vendPath, 'wiregraph-inferred-resources',
    `resource-cli(§11.3): path_between routes through the INFERRED resource contract node (got:\n${vendPath})`);
  ok(!vendPath.includes('CALLS'),
    `resource-cli(§11.3): …with no direct call edge between the two compartments (got:\n${vendPath})`);
  const callsVend = c.prepare(
    `SELECT count(*) n FROM edges e JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
      WHERE e.project=? AND e.type='CALLS' AND sp.compartment='vend-a' AND dp.compartment='vend-b'`).get(work).n;
  eq(callsVend, 0, 'resource-cli(§11.3): …and there genuinely is none in the graph');
  c.close();
  rmSync(work, { recursive: true, force: true });
}

// The resource FORMAT itself: the direction encoding, the validation rules, and R2
// (both formats load through ONE mergeContracts pass, and a cross-format title
// collision is refused loudly rather than silently unioned).
async function resourceSpecFormatTests() {
  const R = await import('../src/extract/resource-spec.js');
  const C = await import('../src/extract/contracts.js');

  // Direction encoding: round-trips losslessly, and never collides with the existing
  // 'c2s' / 's2c' / null values the wire path writes into the same column.
  for (const meta of [
    { kind: 'path', semantics: 'presence-as-state', singleWriter: true },
    { kind: 'db', semantics: 'last-writer-wins', singleWriter: false },
    { kind: 'shm', semantics: 'append-log', singleWriter: null },
    { kind: 'pipe', semantics: 'presence-as-state' },
  ]) {
    const enc = R.encodeResourceDirection(meta);
    const dec = R.decodeResourceDirection(enc);
    eq(dec?.kind, meta.kind, `resource-dir: kind round-trips (${meta.kind})`);
    eq(dec?.semantics, meta.semantics, `resource-dir: semantics round-trips (${meta.semantics})`);
    eq(dec?.singleWriter, meta.singleWriter ?? null, `resource-dir: single_writer round-trips (${String(meta.singleWriter)})`);
    ok(enc !== 'c2s' && enc !== 's2c', `resource-dir: the encoding cannot collide with a wire direction (${enc})`);
  }
  // A value containing the encoding's own delimiters survives intact.
  const tricky = R.decodeResourceDirection(R.encodeResourceDirection({ kind: 'path', semantics: 'a;b=c' }));
  eq(tricky?.semantics, 'a;b=c', 'resource-dir: delimiters inside a value are escaped and round-trip');
  // Every legacy value decodes to null, so existing callers are untouched.
  for (const v of ['c2s', 's2c', null, undefined, '', 'anything-else']) {
    eq(R.decodeResourceDirection(v), null, `resource-dir: a non-resource direction decodes to null (${JSON.stringify(v)})`);
  }

  // Validation. A token containing "/" takes matchContracts' route-shaped
  // pathTokenRegex branch, which is wrong for a filesystem path — so a path literal
  // as an id must be REJECTED with a message that says what to use instead.
  const logs = [];
  const log = (m) => logs.push(m);
  const spec = R.parseResourceSpec({
    title: 'validation',
    resources: [
      { id: '/var/run/x.json', kind: 'path', writers: ['a'], readers: ['b'] },
      { id: 'HAS SPACE', writers: ['a'], readers: ['b'] },
      { id: 'BAD_KIND_TOK', kind: 'socket', writers: ['a'], readers: ['b'] },
      { id: 'BAD_SEMANTICS_TOK', kind: 'path', semantics: 'eventual', writers: ['a'], readers: ['b'] },
      { id: 'NO_ROLES_TOK', kind: 'path' },
      { id: 'GOOD_RESOURCE_TOK', kind: 'db', semantics: 'append-log', writers: ['a'], readers: ['b'] },
      { id: 'GOOD_RESOURCE_TOK', kind: 'db', writers: ['c'], readers: ['d'] },
    ],
  }, 'v.resource.yaml', log);
  eq(spec?.tokens.length, 1, `resource-validate: only the valid resource survives (got ${(spec?.tokens || []).join(', ') || 'none'})`);
  eq(spec?.tokens[0], 'GOOD_RESOURCE_TOK', 'resource-validate: the valid resource is kept');
  eq(spec?.kind, 'resource', 'resource-validate: the descriptor is tagged kind=resource');
  eq(spec?.name, 'validation', 'resource-validate: title becomes the contract name');
  has(logs.join('\n'), 'contains "/"', 'resource-validate: a "/"-bearing id is rejected with a clear reason');
  has(logs.join('\n'), 'CONSTANT NAME', 'resource-validate: the rejection says an id must be the constant name');
  has(logs.join('\n'), 'unknown kind "socket"', 'resource-validate: an unknown kind is rejected by name');
  has(logs.join('\n'), 'unknown semantics "eventual"', 'resource-validate: unknown semantics are rejected by name');
  has(logs.join('\n'), 'neither writers nor readers', 'resource-validate: a role-less resource is rejected');
  has(logs.join('\n'), 'declared twice', 'resource-validate: a duplicate id within one spec is rejected');
  // The parser returns the SAME descriptor shape the AsyncAPI parser does, so nothing
  // downstream of mergeContracts needs a branch.
  for (const k of ['id', 'name', 'file', 'tokens', 'direction', 'wireRoles']) {
    ok(k in (spec || {}), `resource-validate: the descriptor carries the shared field "${k}"`);
  }
  eq([...(spec?.wireRoles?.get('GOOD_RESOURCE_TOK')?.producers || [])].join(','), 'a',
    'resource-validate: writers map to wireRoles.producers');
  eq([...(spec?.wireRoles?.get('GOOD_RESOURCE_TOK')?.consumers || [])].join(','), 'b',
    'resource-validate: readers map to wireRoles.consumers');
  eq(R.parseResourceSpec({ title: 'empty', resources: [] }, 'e.resource.yaml', log), null,
    'resource-validate: a spec with no usable resources yields no contract');

  // C3 — resource ids go through the SAME distinctiveness gate as every AsyncAPI token.
  // This was the one path into the token index with no such check: an id becomes
  // `\bid\b` in matchContracts and runs against every source file in every compartment,
  // so `id` is not a weak signal, it is a firehose — REFERENCES everywhere and up to
  // MAX_PAIRS_PER_TOKEN phantom writer->reader seams per token. All three below were
  // accepted with zero warnings.
  const dlog = [];
  const dspec = R.parseResourceSpec({
    title: 'distinct',
    resources: [
      { id: 'id', writers: ['a'], readers: ['b'] },        // matches essentially every file
      { id: 'PATH', writers: ['a'], readers: ['b'] },      // a ubiquitous infra env var
      { id: 'SHORT', writers: ['a'], readers: ['b'] },     // too short/generic to be a key
      { id: 'state', writers: ['a'], readers: ['b'] },     // on the low-signal STOP list
      { id: 'GAME_STATE_PATH', writers: ['a'], readers: ['b'] },
    ],
  }, 'd.resource.yaml', (m) => dlog.push(m));
  eq(JSON.stringify(dspec?.tokens), JSON.stringify(['GAME_STATE_PATH']),
    `resource-validate(C3): a non-distinctive resource id is REJECTED (got ${(dspec?.tokens || []).join(', ') || 'none'})`);
  has(dlog.join('\n'), 'd.resource.yaml', 'resource-validate(C3): the rejection names the file');
  has(dlog.join('\n'), '"id" is not distinctive', 'resource-validate(C3): …and names the offending id');
  has(dlog.join('\n'), 'phantom seams', 'resource-validate(C3): …and says what would go wrong');
  const distinctRejected = dlog.filter((m) => m.includes('not distinctive')).length;
  eq(distinctRejected, 4, `resource-validate(C3): every non-distinctive id is reported, not just the first (got ${distinctRejected})`);

  // C6 — validation gaps that were all silent. Each one produces a graph that looks
  // declared and behaves as if it were not, so a warning is the difference between a
  // five-second fix and an afternoon reading edge tables.
  const vlog = [];
  const vspec = R.parseResourceSpec({
    resources: [ // NO title at all -> falls back to the filename, which must be said out loud
      { id: 'SELF_LOOP_TOK', writers: ['a'], readers: ['a', 'b'] },
      { id: 'NO_WRITER_TOK', single_writer: true, readers: ['b'] },
      { id: 'FINE_TOKEN_HERE', writers: ['a'], readers: ['b'] },
    ],
  }, 'untitled.resource.yaml', (m) => vlog.push(m));
  eq(vspec?.name, 'untitled', 'resource-validate(C6): a title-less spec falls back to the filename');
  has(vlog.join('\n'), "no 'title:'", 'resource-validate(C6): …and SAYS SO — §12 makes distinct titles load-bearing');
  has(vlog.join('\n'), 'BOTH writer and reader',
    'resource-validate(C6): a compartment on both sides is flagged (every such pair is skipped, so the resource contributes nothing)');
  has(vlog.join('\n'), 'single_writer: true but lists NO writers',
    'resource-validate(C6): single_writer with an empty writers list is rejected as unenforceable');
  ok(!(vspec?.tokens || []).includes('NO_WRITER_TOK'),
    'resource-validate(C6): …and that resource is dropped rather than half-declared');
  ok((vspec?.tokens || []).includes('SELF_LOOP_TOK'),
    'resource-validate(C6): the both-sides case is a WARNING, not a rejection — the other half may still be a real seam');

  // C6 — decodeResourceDirection must fail LOUDLY. Both silent-wrong behaviours it
  // replaces turned a declared TRUE into an effective FALSE and took the whole
  // single-writer violation report down with it, with no signal anywhere.
  const badEsc = R.decodeResourceDirection('res:kind=path;semantics=%E0%A4%A;single_writer=1');
  ok(badEsc?.errors?.length, 'resource-dir(C6): a malformed percent-escape is RECORDED, not swallowed');
  eq(badEsc?.singleWriter, true, 'resource-dir(C6): …and does not take the fields that DID decode down with it');
  const badFlag = R.decodeResourceDirection('res:kind=path;semantics=presence-as-state;single_writer=true');
  eq(badFlag?.singleWriter, null,
    'resource-dir(C6): an unrecognised single_writer value decodes to UNKNOWN (null), never silently to false');
  ok(badFlag?.errors?.some((e) => e.includes('UNKNOWN')), 'resource-dir(C6): …and says the declared discipline is unknown');
  eq(R.decodeResourceDirection(R.encodeResourceDirection({ kind: 'path', semantics: 'presence-as-state' }))?.errors, null,
    'resource-dir(C6): a well-formed value reports no errors');

  // R2 — ONE merge pass, and a cross-format title collision is refused. mergeContracts
  // keeps only the FIRST contributor's file/kind, so a silent union would produce a
  // node whose `file` names one format while its tokens hold both formats' — and the
  // store's per-contract delTok would let a second load pass wipe the first's tokens.
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-rescollide-')));
  const dirA = join(ws, 'a'), dirB = join(ws, 'b');
  mkdirSync(dirA, { recursive: true }); mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, 'shared.asyncapi.yaml'),
    'asyncapi: 3.0.0\n' +
    'info: { title: shared-title, version: 1.0.0 }\n' +
    'channels:\n  c:\n    address: /api/collide-route\n');
  writeFileSync(join(dirB, 'shared.resource.yaml'),
    'title: shared-title\nresources:\n  - id: COLLIDING_RESOURCE_TOK\n    kind: path\n    writers: [a]\n    readers: [b]\n');
  const clog = [];
  const g = new Graph(ws);
  const merged = C.loadAllContracts(g, [dirA, dirB], (m) => clog.push(m));
  eq(merged.length, 1, `resource-collide: the colliding later spec is SKIPPED, not merged (got ${merged.length} contract(s))`);
  eq(merged[0]?.kind, 'asyncapi', 'resource-collide: the ASYNCAPI spec wins the cross-format collision');
  ok(!merged[0]?.tokens.includes('COLLIDING_RESOURCE_TOK'),
    `resource-collide: the skipped spec's tokens do NOT leak into the surviving node (got ${(merged[0]?.tokens || []).join(', ')})`);
  has(clog.join('\n'), 'title collision', 'resource-collide: the collision is logged');
  has(clog.join('\n'), 'shared.asyncapi.yaml', 'resource-collide: the warning names the first file');
  has(clog.join('\n'), 'shared.resource.yaml', 'resource-collide: the warning names the second file');

  // C7 — the OTHER direction, which was untested and which order-based "keep the first"
  // got badly wrong: with the resource spec read first, a single hand-written resource
  // spec discarded the ENTIRE AsyncAPI spec sharing its title, every channel of it. The
  // link-inferred spec is the sharpest case — its title is a fixed default, so any user
  // resource spec can collide with it by accident and silently delete every inferred
  // seam in the project. The incumbent format wins, whatever the read order.
  const rlog = [];
  const mergedRF = C.loadAllContracts(new Graph(ws), [dirB, dirA], (m) => rlog.push(m));
  eq(mergedRF.length, 1, `resource-collide(C7): still exactly one contract with the resource spec read FIRST (got ${mergedRF.length})`);
  eq(mergedRF[0]?.kind, 'asyncapi',
    'resource-collide(C7): the AsyncAPI spec survives even when the resource spec is read first — the format decides, not the order');
  ok(mergedRF[0]?.tokens.includes('/api/collide-route'),
    `resource-collide(C7): …and keeps ITS OWN tokens rather than being discarded wholesale (got ${(mergedRF[0]?.tokens || []).join(', ')})`);
  has(rlog.join('\n'), 'Keeping the AsyncAPI spec', 'resource-collide(C7): the warning says which one it kept');

  // Same-format collisions must STILL merge — that is existing, tested behavior
  // (a hand-applied spec and the link-inferred one share the same default title).
  writeFileSync(join(dirB, 'other.asyncapi.yaml'),
    'asyncapi: 3.0.0\n' +
    'info: { title: shared-title, version: 1.0.0 }\n' +
    'channels:\n  c:\n    address: /api/second-route\n');
  const merged2 = C.loadAllContracts(new Graph(ws), [dirA, dirB], () => {});
  eq(merged2.length, 1, 'resource-collide: two AsyncAPI specs sharing a title still collapse to one node');
  ok(merged2[0]?.tokens.includes('/api/collide-route') && merged2[0]?.tokens.includes('/api/second-route'),
    `resource-collide: same-format specs still UNION their tokens (got ${(merged2[0]?.tokens || []).join(', ')})`);
  rmSync(ws, { recursive: true, force: true });

  // C4 — two DIFFERENTLY-TITLED resource specs declaring the SAME resource id. A
  // resource id is the join key; declaring it twice mints REFERENCES to two contract
  // nodes for one constant and derives the same writer->reader pair twice under two
  // names. Before the derived-edge dedup key learned about `contract`, one of the two
  // was silently dropped at insert time — the loser reported status `ok` with no edges
  // at all, and WHICH one lost came down to directory read order.
  const dws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-resdup-')));
  mkdirSync(dws, { recursive: true });
  writeFileSync(join(dws, 'a-first.resource.yaml'),
    'title: dup-first\nresources:\n  - id: DUP_STATE_PATH\n    writers: [a]\n    readers: [b]\n  - id: KEPT_FIRST_TOK\n    writers: [a]\n    readers: [b]\n');
  writeFileSync(join(dws, 'b-second.resource.yaml'),
    'title: dup-second\nresources:\n  - id: DUP_STATE_PATH\n    writers: [c]\n    readers: [d]\n  - id: KEPT_SECOND_TOK\n    writers: [c]\n    readers: [d]\n');
  const dupLog = [];
  const dupMerged = C.loadAllContracts(new Graph(dws), [dws], (m) => dupLog.push(m));
  const dupById = new Map(dupMerged.map((c) => [c.name, c]));
  eq(dupMerged.length, 2, `resource-dup(C4): both contracts still load (got ${dupMerged.length})`);
  eq(JSON.stringify(dupById.get('dup-first')?.tokens.sort()), JSON.stringify(['DUP_STATE_PATH', 'KEPT_FIRST_TOK']),
    'resource-dup(C4): the first declarer keeps the id');
  eq(JSON.stringify(dupById.get('dup-second')?.tokens.sort()), JSON.stringify(['KEPT_SECOND_TOK']),
    'resource-dup(C4): the duplicate is dropped from the second spec, and ONLY the duplicate');
  has(dupLog.join('\n'), 'DUP_STATE_PATH', 'resource-dup(C4): the rejection names the duplicated id');
  has(dupLog.join('\n'), 'ALREADY declared by', 'resource-dup(C4): …and says who declared it first');
  has(dupLog.join('\n'), 'a-first.resource.yaml', 'resource-dup(C4): …naming that file');
  // Read order must not decide the outcome: readContractsDir sorts its entries, so the
  // FIRST alphabetically wins on every filesystem rather than whichever readdir returned
  // first — the loser used to vary by creation order and by machine.
  const dupMerged2 = C.loadAllContracts(new Graph(dws), [dws], () => {});
  eq(JSON.stringify(dupMerged2.map((c) => c.name + ':' + [...c.tokens].sort().join('+'))),
    JSON.stringify(dupMerged.map((c) => c.name + ':' + [...c.tokens].sort().join('+'))),
    'resource-dup(C4): the outcome is deterministic across loads (dir entries are sorted)');
  rmSync(dws, { recursive: true, force: true });

  // C8 — the store-level backstop. Whatever loadAllContracts does, a Contract node must
  // never be quietly re-registered under a DIFFERENT kind: addContract is first-wins, so
  // the second registration would be dropped (tokenMeta and all), leaving a node whose
  // `file` names one format while its tokens are half of one and none of the other.
  const kg = new Graph('/tmp/kindguard');
  kg.addContract({ id: 'contract:x', name: 'x', kind: 'asyncapi', file: 'x.asyncapi.yaml', tokenMeta: [] });
  let kindThrew = null;
  try { kg.addContract({ id: 'contract:x', name: 'x', kind: 'resource', file: 'x.resource.yaml', tokenMeta: [] }); }
  catch (e) { kindThrew = e.message; }
  ok(kindThrew, 'addContract(C8): re-registering an id with a DIFFERENT kind throws instead of silently dropping it');
  has(kindThrew || '', 'x.resource.yaml', 'addContract(C8): the error names the offending file');
  let sameKindThrew = null;
  try { kg.addContract({ id: 'contract:x', name: 'x', kind: 'asyncapi', file: 'other.asyncapi.yaml', tokenMeta: [] }); }
  catch (e) { sameKindThrew = e.message; }
  ok(!sameKindThrew, 'addContract(C8): a SAME-kind re-registration is still the ordinary first-wins no-op');

  // A contracts dir holding ONLY resource specs must be discovered as a contracts home.
  const B = await import('../src/build.js');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cg-reshome-')));
  mkdirSync(join(home, 'contracts'), { recursive: true });
  writeFileSync(join(home, 'contracts', 'only.resource.yaml'),
    'title: only-resources\nresources:\n  - id: ONLY_RESOURCE_TOK\n    writers: [a]\n    readers: [b]\n');
  ok(B.detectContractsDirs(join(home, 'contracts')).includes(join(home, 'contracts')),
    'resource-home: a dir holding only *.resource.yaml is itself detected as a contracts home (by NAME)');

  // C9 — but a bare *.resource.yaml must NOT promote an ARBITRARY root. `*.resource.yaml`
  // is not a wiregraph-exclusive filename (Crossplane, kustomize and k8s tooling emit it),
  // so accepting it made any such repo its own contracts dir. Measured consequences:
  // `state.contractsDir` flips from null to the repo ROOT, which permanently silences the
  // /wiregraph-contracts nudge (session-start.mjs gates on `seams > 0 && !contractsDir`),
  // and `/wiregraph-contracts apply` writes the inferred spec to the repo root.
  const stray = realpathSync(mkdtempSync(join(tmpdir(), 'cg-stray-')));
  writeFileSync(join(stray, 'xrd.resource.yaml'), 'apiVersion: apiextensions.crossplane.io/v1\nkind: CompositeResourceDefinition\n');
  eq(JSON.stringify(B.detectContractsDirs(stray)), JSON.stringify([]),
    `resource-home(C9): an unrelated *.resource.yaml does NOT make an arbitrary root a contracts home (got ${B.detectContractsDirs(stray).join(', ') || 'none'})`);
  // …and for a repo that already HAS contracts/, the purpose-named child must come
  // FIRST: `roots.flatMap(detectContractsDirs)[0]` is what fullBuild records as
  // state.contractsDir, i.e. the dir /wiregraph-contracts writes into.
  mkdirSync(join(stray, 'contracts'), { recursive: true });
  writeFileSync(join(stray, 'top.asyncapi.yaml'), 'asyncapi: 3.0.0\ninfo: { title: Top, version: 1.0.0 }\nchannels: {}\n');
  const strayDirs = B.detectContractsDirs(stray);
  eq(strayDirs[0], join(stray, 'contracts'),
    `resource-home(C9): a contracts/ child outranks the root itself (got ${strayDirs.join(', ') || 'none'})`);
  ok(strayDirs.includes(stray), 'resource-home(C9): …without dropping the root, which still holds a top-level AsyncAPI spec');
  rmSync(stray, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

// C4 (the store half) — TWO contracts that legitimately derive the SAME seam. Two
// differently-titled specs can name the same channel/resource between the same two
// symbols; that is two findings under two contract names, not one edge seen twice.
// The loader's dedup key used to be (type, src, dst, token) with no contract term, so
// the second addEdge was silently DROPPED — the losing contract then reported status
// `ok` with no edges at all, and `export-gexf --contract <it>` printed "no edges" for a
// seam that plainly exists. Which one lost came down to directory read order.
//
// Exercised through ASYNCAPI specs: duplicate RESOURCE ids are now refused at load
// (see resource-dup above), so the store-level key needs its own proof.
async function duplicateContractSeamTest() {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-dupseam-')));
  for (const [d, f, body] of [
    ['caller', 'call.js', "export async function callDupRoute() { return fetch('/api/dup-seam-route'); }\n"],
    ['handler', 'serve.js', "export function serveDupRoute(app) { app.get('/api/dup-seam-route', (q, s) => s.json({})); }\n"],
  ]) {
    mkdirSync(join(ws, d, '.git'), { recursive: true });
    writeFileSync(join(ws, d, f), body);
  }
  mkdirSync(join(ws, 'contracts'), { recursive: true });
  const spec = (title) => 'asyncapi: 3.0.0\n'
    + `info: { title: ${title}, version: 1.0.0 }\n`
    + 'channels:\n  c:\n    address: /api/dup-seam-route\n'
    + '    x-wiregraph-producers: [caller]\n    x-wiregraph-consumers: [handler]\n';
  writeFileSync(join(ws, 'contracts', 'one.asyncapi.yaml'), spec('dup-seam-alpha'));
  writeFileSync(join(ws, 'contracts', 'two.asyncapi.yaml'), spec('dup-seam-beta'));

  await runBuild({ target: ws, project: ws, reset: true });
  const c = connect(join(ws, '.wiregraph', 'graph.db'), { readonly: true });
  const rows = c.prepare("SELECT contract FROM edges WHERE project=? AND type='WIRE' AND token=? ORDER BY contract")
    .all(ws, '/api/dup-seam-route').map((r) => r.contract);
  eq(JSON.stringify(rows), JSON.stringify(['dup-seam-alpha', 'dup-seam-beta']),
    `dup-seam(C4): BOTH contracts keep their derived seam — neither is silently dropped by the dedup key (got ${rows.join(', ') || 'none'})`);
  c.close();

  // …and the INCREMENTAL re-derive uses the same key, so a file save must not delete one
  // of them. rederiveWireEdges replaces the project's seams wholesale, so a key without
  // the contract term would collapse the pair on the first edit after a clean build.
  writeFileSync(join(ws, 'caller', 'call.js'),
    "export async function callDupRoute() { return fetch('/api/dup-seam-route', { method: 'GET' }); }\n");
  await runBuild({ target: ws, project: ws, files: [join(ws, 'caller', 'call.js')] });
  const c2 = connect(join(ws, '.wiregraph', 'graph.db'), { readonly: true });
  const rows2 = c2.prepare("SELECT contract FROM edges WHERE project=? AND type='WIRE' AND token=? ORDER BY contract")
    .all(ws, '/api/dup-seam-route').map((r) => r.contract);
  c2.close();
  eq(JSON.stringify(rows2), JSON.stringify(['dup-seam-alpha', 'dup-seam-beta']),
    `dup-seam(C4): and the incremental re-derive keeps both too (got ${rows2.join(', ') || 'none'})`);
  rmSync(ws, { recursive: true, force: true });
}

// C17 — pruneFile, called DIRECTLY. `delWireOf` inside it is one SQL statement whose
// edge-type list decides whether a stale derived seam survives a file save. Narrowing it
// back to `type='WIRE'` breaks nothing else in the suite, because the surrounding
// incremental path immediately re-derives everything and papers over the difference.
//
// It matters because build.js wraps that re-derive in try/catch and degrades to "seam
// left dark" on failure: with a WIRE-only prune, a FAILED re-derive leaves a stale
// RESOURCE edge on disk asserting a writer->reader seam whose reader no longer references
// the constant — and it survives every later incremental until someone does a full
// rebuild. Reproducing that end to end needs fault injection; calling pruneFile directly
// needs ten lines.
async function pruneFileDerivedEdgeTest() {
  const S = await import('../src/store/sqlite.js');
  const project = resourceFixture('cg-prune-');
  await runBuild({ target: project, project, reset: true });

  const db = connect(join(project, '.wiregraph', 'graph.db'), {});
  const count = (type) => db.prepare('SELECT count(*) n FROM edges WHERE project=? AND type=?').get(project, type).n;
  ok(count('RESOURCE') > 0 && count('WIRE') > 0, `prune(C17): the build produced both seam types (RESOURCE=${count('RESOURCE')}, WIRE=${count('WIRE')})`);

  // The writer's file. Its symbols carry BOTH a RESOURCE seam (GAME_STATE_PATH) and a
  // WIRE seam (/api/resource-ping), so one prune must clear both.
  const touching = db.prepare(
    `SELECT e.type type FROM edges e JOIN symbols s ON s.id=e.src
      WHERE e.project=? AND s.compartment='alpha' AND s.file='writer.js' AND e.type IN ('WIRE','RESOURCE')`).all(project);
  ok(touching.some((r) => r.type === 'RESOURCE') && touching.some((r) => r.type === 'WIRE'),
    `prune(C17): alpha/writer.js is an endpoint of both a RESOURCE and a WIRE seam (got ${touching.map((r) => r.type).join(', ') || 'none'})`);

  // keepIds must be NON-EMPTY — that is the branch delWireOf lives on. For a DELETED
  // symbol, pruneFile drops every edge of every type via delEdgesOf, so the edge-type
  // list is never consulted; only a SURVIVING symbol (the ordinary body-only edit, which
  // is the overwhelmingly common incremental) goes through delOutgoing + delWireOf. A
  // test that passed [] would exercise neither and pass no matter what the list said.
  const keepIds = db.prepare('SELECT id FROM symbols WHERE project=? AND compartment=? AND file=?')
    .all(project, 'alpha', 'writer.js').map((r) => r.id);
  ok(keepIds.length >= 2, `prune(C17): the file has surviving symbols to prune around (got ${keepIds.length})`);
  S.pruneFile(db, project, 'alpha', 'writer.js', keepIds);
  const left = db.prepare(
    `SELECT e.type type FROM edges e
      WHERE e.project=? AND e.type IN ('WIRE','RESOURCE') AND (e.src LIKE 'sym:alpha:writer.js:%' OR e.dst LIKE 'sym:alpha:writer.js:%')`)
    .all(project);
  eq(left.length, 0,
    `prune(C17): pruneFile deletes EVERY derived seam touching a SURVIVING symbol — RESOURCE as well as WIRE (left ${left.map((r) => r.type).join(', ') || 'none'})`);
  // The rest of the project's seams are untouched — the prune is per-file, not a wipe.
  ok(count('RESOURCE') > 0, `prune(C17): seams that do not touch the pruned file survive (RESOURCE=${count('RESOURCE')})`);
  db.close();
  rmSync(project, { recursive: true, force: true });
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
await langFixtureTests('java', FIXTURE_JAVA, 'App.java');
await langFixtureTests('kotlin', FIXTURE_KOTLIN, 'App.kt');
await langFixtureTests('rust', FIXTURE_RUST, 'app.rs');
await rustTests();
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
await constCandidateTests();
await atomicStateTest();
await potentialTest();
await importsTest();
await exportHtmlTests();
await exportContractEdgesTest();
await exportHtmlEscapingTest();
await schemaGuardTest();
await refreshSchemaGateTest();
await refreshSchemaGateFanOutTest();
await mcpSchemaGateFanOutTest();
await mcpSchemaGateProbeTest();
await mcpSchemaGateUnitTests();
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
await compartmentBoundaryTest();
await nearestAncestorAttributionTest();
await declaredCompartmentsTest();
await declaredCompartmentValidationTest();
await compartmentsFingerprintTest();
await stampFollowsWriteTest();
await globalPartitionDriftTest();
await fingerprintRenameKeyTest();
await stampCatchNarrowTest();
await legacyFingerprintInertTest();
await declaredCompartmentReadPathTest();
await declareReportTest();
await declaredCompartmentDiskDriftTest();
await declaredMemberFingerprintTest();
await contractsDirPrecedenceTest();
await refreshPartitionDriftTest();
modeEscapeHatchTest();
await declaredCompartmentLinkGuardTest();
await nestedWorktreeTests();
await inferAcrossTest();
await idIndependenceTest();
await unionBuildTest();
await linkMutualAutoInitTest();
await linkResourceSpecLifecycleTest();
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

// --- K1: the definition-site exclusion keys on POSITION, not on the line -------
// A line key drops every USE of a constant that happens to share its definition line.
// Measured, with a HAND-WRITTEN 1a spec: `export const SESSION_LOCK_PATH = '…'; export
// function fn3a() { return SESSION_LOCK_PATH; }` reported "1 REFERENCES / 0 RESOURCE
// edges; 1 one-sided resource" — the declared WRITER half vanished and trace_contract
// blamed the user's code for a defect in the matcher. The name node's own offset has
// none of that ambiguity, and the four neighbouring shapes the line key also broke (two
// constants on one line, a mention in a trailing comment, a `\`-continued C #define, an
// `export { X } from` barrel) are pinned here alongside it.
async function definitionSitePositionTest() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-defpos-')));
  for (const d of ['alpha', 'beta', 'cwriter', 'creader']) mkdirSync(join(work, d, '.git'), { recursive: true });

  writeFileSync(join(work, 'alpha', 'const.js'),
    // THE regression: declaration and use on ONE line.
    "export const SESSION_LOCK_PATH = '/var/run/sess.lock'; export function fn3a() { return SESSION_LOCK_PATH; }\n"
    // TWO constants declared on one line — a line key excludes both names everywhere on it.
    + "export const TWIN_ONE_PATH = '/var/run/one', TWIN_TWO_PATH = '/var/run/two';\n"
    + 'export function useTwins() { return [TWIN_ONE_PATH, TWIN_TWO_PATH]; }\n'
    // A mention of the name in a trailing comment ON the definition line.
    + "export const NOTED_LOCK_PATH = '/var/run/noted.lock'; // NOTED_LOCK_PATH is the boot lock\n"
    + 'export function useNoted() { return NOTED_LOCK_PATH; }\n');
  // A re-export BARREL. `export { X } from './y'` is module wiring, not a use, and is
  // excluded as an import line — not by the definition-site rule, which never sees it.
  writeFileSync(join(work, 'alpha', 'index.js'),
    "export { SESSION_LOCK_PATH } from './const.js';\n");
  writeFileSync(join(work, 'beta', 'read.js'),
    "import { readFileSync } from 'node:fs';\n"
    + "import { SESSION_LOCK_PATH, TWIN_ONE_PATH, TWIN_TWO_PATH, NOTED_LOCK_PATH } from '../alpha/const.js';\n"
    + 'export function betaRead() {\n'
    + "  return [SESSION_LOCK_PATH, TWIN_ONE_PATH, TWIN_TWO_PATH, NOTED_LOCK_PATH].map((p) => readFileSync(p, 'utf8'));\n"
    + '}\n');
  // A `\`-continued #define: the declaration spans two lines and its value is not a
  // single quoted run, so it is a value-unknown DEFINITION whose name offset is still exact.
  writeFileSync(join(work, 'cwriter', 'defs.c'),
    '#define WRAPPED_LOCK_PATH "/var/run/" \\\n'
    + '  "wrapped.lock"\n'
    + 'const char *cwriter_use(void) { return WRAPPED_LOCK_PATH; }\n');
  writeFileSync(join(work, 'creader', 'read.c'),
    '#include "../cwriter/defs.c"\n'
    + 'const char *creader_use(void) { return WRAPPED_LOCK_PATH; }\n');

  mkdirSync(join(work, 'contracts'), { recursive: true });
  writeFileSync(join(work, 'contracts', 'k1.resource.yaml'),
    'title: k1-locks\nresources:\n'
    + '  - id: SESSION_LOCK_PATH\n    writers: [alpha]\n    readers: [beta]\n'
    + '  - id: TWIN_ONE_PATH\n    writers: [alpha]\n    readers: [beta]\n'
    + '  - id: TWIN_TWO_PATH\n    writers: [alpha]\n    readers: [beta]\n'
    + '  - id: NOTED_LOCK_PATH\n    writers: [alpha]\n    readers: [beta]\n'
    + '  - id: WRAPPED_LOCK_PATH\n    writers: [cwriter]\n    readers: [creader]\n');

  const db = join(work, '.wiregraph', 'graph.db');
  await runBuild({ target: work, project: work, db, reset: true });
  const c = connect(db, { readonly: true });
  const refs = c.prepare(
    `SELECT e.token t, s.compartment cc, s.file f, s.name n FROM edges e JOIN symbols s ON s.id=e.src
      WHERE e.project=? AND e.type='REFERENCES' ORDER BY e.token, s.compartment, s.file, s.name`)
    .all(work).map((r) => `${r.t}|${r.cc}:${r.f}:${r.n}`);
  const seams = c.prepare(
    `SELECT e.token t, sp.name sn, dp.name dn FROM edges e JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
      WHERE e.project=? AND e.type='RESOURCE' ORDER BY e.token, sp.name, dp.name`)
    .all(work).map((r) => `${r.t}|${r.sn}->${r.dn}`);
  c.close();

  // The whole point: the USE on the definition line is a reference; the DECLARATION is not.
  ok(refs.includes('SESSION_LOCK_PATH|alpha:const.js:fn3a'),
    `defpos(K1): a USE on the definition's own line still mints a REFERENCES (got ${refs.join(', ') || 'none'})`);
  ok(!refs.some((r) => r === 'SESSION_LOCK_PATH|alpha:const.js:<module>'),
    `defpos(K1): …while the declaration itself still mints none (got ${refs.join(', ') || 'none'})`);
  ok(seams.includes('SESSION_LOCK_PATH|fn3a->betaRead'),
    `defpos(K1): so the declared WRITER half survives and the seam derives (got ${seams.join(', ') || 'none'})`);
  // Two constants on one line: both uses survive, both declarations are excluded.
  ok(refs.includes('TWIN_ONE_PATH|alpha:const.js:useTwins') && refs.includes('TWIN_TWO_PATH|alpha:const.js:useTwins'),
    `defpos(K1): two constants declared on ONE line both keep their uses (got ${refs.join(', ') || 'none'})`);
  ok(!refs.some((r) => r.startsWith('TWIN_ONE_PATH|alpha:const.js:<module>') || r.startsWith('TWIN_TWO_PATH|alpha:const.js:<module>')),
    'defpos(K1): …and neither declaration mints one');
  // A trailing comment naming the constant on the definition line is prose (K2), so the
  // only alpha-side reference is the real use.
  eq(JSON.stringify(refs.filter((r) => r.startsWith('NOTED_LOCK_PATH|alpha'))),
    JSON.stringify(['NOTED_LOCK_PATH|alpha:const.js:useNoted']),
    `defpos(K1): a mention in a trailing comment on the definition line adds nothing (got ${refs.filter((r) => r.startsWith('NOTED_LOCK_PATH|alpha')).join(', ') || 'none'})`);
  // The barrel re-export is module wiring, not a use.
  ok(!refs.some((r) => r.includes('alpha:index.js')),
    `defpos(K1): an \`export { X } from './y'\` barrel mints no reference (got ${refs.join(', ') || 'none'})`);
  // A `\`-continued #define: definition excluded, use kept, seam derived.
  ok(seams.includes('WRAPPED_LOCK_PATH|cwriter_use->creader_use'),
    `defpos(K1): a \\-continued C #define keeps its use and derives its seam (got ${seams.join(', ') || 'none'})`);
  ok(!refs.includes('WRAPPED_LOCK_PATH|cwriter:defs.c:<module>'),
    'defpos(K1): …while the #define itself is still not a use');

  rmSync(work, { recursive: true, force: true });
}

// --- K2: a COMMENT is not a reference -----------------------------------------
// Reference discovery scans raw file text, so a compartment that mentions the constant
// only in prose became a full participant. Measured: one
// `// TODO(someday): this module should eventually learn about LEDGER_STATE_PATH.`
// produced 3 compartments and 6 RESOURCE edges, 4 of them fictional, while
// trace_contract reported the contract 1/1 satisfied. The ranges come from the file's
// own tree-sitter parse, which is why a `//` inside a STRING is still code.
async function commentIsNotAReferenceTest() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-comment-')));
  for (const d of ['alpha', 'beta', 'gamma', 'client', 'server']) mkdirSync(join(work, d, '.git'), { recursive: true });

  writeFileSync(join(work, 'alpha', 'write.js'),
    "import { writeFileSync } from 'node:fs';\n"
    + "export const LEDGER_STATE_PATH = '/var/run/ledger/state.json';\n"
    + 'export function alphaWrite(s) { writeFileSync(LEDGER_STATE_PATH, s); }\n');
  writeFileSync(join(work, 'beta', 'read.js'),
    "import { readFileSync } from 'node:fs';\n"
    + "import { LEDGER_STATE_PATH } from '../alpha/write.js';\n"
    + "export function betaRead() { return readFileSync(LEDGER_STATE_PATH, 'utf8'); }\n");
  // gamma NEVER touches the resource. It only talks about it — in a line comment and in
  // a block comment. It is declared as a reader, so if the mention counted it would
  // become a full participant and mint fictional seams from alpha.
  writeFileSync(join(work, 'gamma', 'todo.js'),
    '// TODO(someday): this module should eventually learn about LEDGER_STATE_PATH.\n'
    + '/* also LEDGER_STATE_PATH, in a block comment */\n'
    + 'export function gammaNoop() { return 1; }\n');
  // The WIRE path rides the same scanner. A route named in a comment is documentation.
  writeFileSync(join(work, 'client', 'call.js'),
    '// calls /api/ledger on the server\n'
    + "export async function clientCall() { return fetch('/api/ledger'); }\n"
    + "export function notAComment() { return 'https://example.test//api/ledger-ish'; }\n");
  writeFileSync(join(work, 'server', 'serve.js'),
    "import express from 'express';\nconst app = express();\n"
    + "app.get('/api/ledger', (req, res) => res.json({}));\n");

  mkdirSync(join(work, 'contracts'), { recursive: true });
  writeFileSync(join(work, 'contracts', 'ledger.resource.yaml'),
    'title: ledger-state\nresources:\n  - id: LEDGER_STATE_PATH\n    kind: path\n'
    + '    writers: [alpha]\n    readers: [beta, gamma]\n');
  writeFileSync(join(work, 'contracts', 'ledger.asyncapi.yaml'),
    "asyncapi: 3.0.0\ninfo:\n  title: ledger-wire\n  version: '1.0.0'\n"
    + 'channels:\n  ledger:\n    address: /api/ledger\n'
    + "    x-wiregraph-producers: [client]\n    x-wiregraph-consumers: [server]\n");

  const db = join(work, '.wiregraph', 'graph.db');
  await runBuild({ target: work, project: work, db, reset: true });
  const c = connect(db, { readonly: true });
  const refs = c.prepare(
    `SELECT e.token t, s.compartment cc, s.name n FROM edges e JOIN symbols s ON s.id=e.src
      WHERE e.project=? AND e.type='REFERENCES' ORDER BY e.token, s.compartment, s.name`)
    .all(work).map((r) => `${r.t}|${r.cc}:${r.n}`);
  const resEdges = c.prepare(
    `SELECT sp.compartment sc, dp.compartment dc FROM edges e JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
      WHERE e.project=? AND e.type='RESOURCE'`).all(work).map((r) => `${r.sc}->${r.dc}`);
  const trace = Q.traceContract(c, work, 'ledger-state');
  c.close();

  ok(!refs.some((r) => r.includes('gamma')),
    `comment(K2): a constant mentioned ONLY in comments mints no REFERENCES (got ${refs.join(', ') || 'none'})`);
  eq(JSON.stringify([...new Set(resEdges)].sort()), JSON.stringify(['alpha->beta']),
    `comment(K2): so the seam has exactly its real halves, with no fictional edges to the commenting compartment (got ${resEdges.join(', ') || 'none'})`);
  // The declared gamma reader is now visibly MISSING rather than silently satisfied —
  // which is the honest report: the spec claims a reader whose code does not read.
  has(trace, 'LEDGER_STATE_PATH', 'comment(K2): trace_contract still reports the resource');
  // WIRE: the route named in a comment does not steal an edge for <module>.
  ok(!refs.includes('/api/ledger|client:<module>'),
    `comment(K2/wire): a route named in a COMMENT mints no module-scope reference (got ${refs.join(', ') || 'none'})`);
  ok(refs.includes('/api/ledger|client:clientCall'),
    'comment(K2/wire): …while the real call site still does');
  // A `//` inside a STRING is not a comment — the ranges come from the parse, not a regex.
  ok(refs.includes('/api/ledger|client:notAComment'),
    `comment(K2): a token inside a STRING that itself contains "//" is still code (got ${refs.join(', ') || 'none'})`);

  rmSync(work, { recursive: true, force: true });
}

// --- H4/H5: what qualifies as a resource VALUE --------------------------------
// The old rule ("no whitespace in the value") let through every dominant false-positive
// class and rejected genuine paths, because it ran on the RAW SOURCE SLICE: escapes
// defeated it and a macOS path with a space could never pass it.
async function resourceValueRuleTests() {
  const I = await import('../src/contracts/infer.js');
  const P = await import('../src/extract/parse.js');

  // H5 — the value is DECODED before any test runs on it.
  eq(P.decodeConstValue('Run\\tthe\\tthing\\tto\\tfix\\tit.'), 'Run\tthe\tthing\tto\tfix\tit.',
    'value(H5): escapes are decoded, so a whitespace test sees the real string');
  eq(P.decodeConstValue('/var/run/caf\\u00e9.json'), '/var/run/café.json', 'value(H5): \\uNNNN decodes');
  eq(P.decodeConstValue('/var/run/caf\\u{e9}.json'), '/var/run/café.json', 'value(H5): \\u{…} decodes');
  eq(P.decodeConstValue('a\\x2Fb'), 'a/b', 'value(H5): \\xNN decodes');
  eq(P.decodeConstValue('C:\\\\logs\\\\app.log'), 'C:\\logs\\app.log', 'value(H5): a Windows path survives with its separators');
  // NFC: the same path written decomposed and precomposed must be ONE value, or the
  // vendored name+value join sees two and drops the seam.
  eq(P.decodeConstValue('/var/run/cafe\u0301.json'), P.decodeConstValue('/var/run/caf\u00e9.json'),
    'value(H5): NFD and NFC spellings of the same path normalise to one value');
  // A template literal with an interpolation is NOT a constant: two compartments with
  // different `BASE` share only its source text.
  eq(P.decodeConstValue('${BASE}/state.json'), null,
    'value(H5): an interpolated template literal has no constant value at all');

  // H4 — the shape rule.
  const bad = (n, v, why) => ok(I.whyNotResourceValue(n, v), `value(H4): rejected — ${why} (${n} = ${JSON.stringify(v)})`);
  const good = (n, v, why) => eq(I.whyNotResourceValue(n, v), null, `value(H4): accepted — ${why} (${n} = ${JSON.stringify(v)})`);
  bad('__version__', '0.0.1', 'a version string');
  bad('DEFAULT_MODEL', 'gpt-4o-mini', 'a model id');
  bad('EVENT_KIND_CREATED', 'created', 'an enum member');
  bad('DEFAULT_ENCODING', 'utf8', 'a codec name');
  bad('_UA', 'Argus/0.1 (local memory assistant)', 'a user-agent — even though it contains a slash, it carries no scheme but is prose');
  bad('BILLING_API_BASE', 'https://api.example.com/v1/billing', 'a URL — a wire concern, not a resource');
  bad('WS_ENDPOINT', 'wss://example.test/socket', 'a websocket URL');
  bad('BANNER_TEXT', 'line one\nline two', 'prose with a newline');
  good('SESSION_LOCK_PATH', '/var/run/sess.lock', 'a path');
  good('STATE_FILE', 'C:\\ProgramData\\Acme\\state.json', 'a Windows path');
  good('SUPPORT_STATE_PATH', '/Users/me/Library/Application Support/Acme/state.json',
    'a macOS path WITH SPACES — invisible by construction under the old whitespace rule');
  good('EVENTS_TABLE', 'events_v2', 'a DB table: no separator, but the NAME says TABLE');
  good('WORK_QUEUE', 'jobs.pending', 'a queue name');
  good('gameStatePath', 'state.json', 'camelCase is word-split too');
  good('INDEX_CACHE_DB', 'index.sqlite', 'a DB word at the end');
  // Word-boundary aware, not a substring test.
  ok(!I.isResourceShapedName('PROFILE_NAME'), 'value(H4): PROFILE does not count as a FILE word');
  ok(!I.isResourceShapedName('DEBUG_LEVEL'), 'value(H4): DEBUG does not count as a DB word');
  ok(I.isResourceShapedName('sessionLockPath'), 'value(H4): camelCase splits into words');
  ok(I.isResourceShapedName('EVENTS_TABLE'), 'value(H4): TABLE is a resource word');
  // _UA has a slash but is prose; it is caught by the space-and-no-name-shape branch only
  // because the name is not resource-shaped. Pin the reason so the branch is not
  // accidentally widened.
  ok(String(I.whyNotResourceValue('_UA', 'Argus/0.1 (local memory assistant)')).includes('/'),
    'value(H4): a slash-bearing user-agent is still rejected somewhere — the reason is reported, not silent');

  // End to end: two compartments sharing a macOS path DO join; two sharing a version
  // string do NOT.
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-valrule-')));
  for (const d of ['mac-a', 'mac-b', 'ver-a', 'ver-b', 'tpl-a', 'tpl-b']) mkdirSync(join(work, d, '.git'), { recursive: true });
  const macPath = "export const SUPPORT_STATE_PATH = '/Users/me/Library/Application Support/Acme/state.json';\n";
  writeFileSync(join(work, 'mac-a', 'a.js'), macPath + 'export function macA() { return SUPPORT_STATE_PATH; }\n');
  writeFileSync(join(work, 'mac-b', 'b.js'), macPath + 'export function macB() { return SUPPORT_STATE_PATH; }\n');
  writeFileSync(join(work, 'ver-a', 'a.js'), "export const PKG_VERSION = '0.0.1';\nexport function verA() { return PKG_VERSION; }\n");
  writeFileSync(join(work, 'ver-b', 'b.js'), "export const PKG_VERSION = '0.0.1';\nexport function verB() { return PKG_VERSION; }\n");
  // Same template SOURCE, different BASE — the value is not constant, so no seam.
  writeFileSync(join(work, 'tpl-a', 'a.js'), "const BASE = '/srv/a';\nexport const TPL_STATE_PATH = `${BASE}/state.json`;\nexport function tplA() { return TPL_STATE_PATH; }\n");
  writeFileSync(join(work, 'tpl-b', 'b.js'), "const BASE = '/srv/b';\nexport const TPL_STATE_PATH = `${BASE}/state.json`;\nexport function tplB() { return TPL_STATE_PATH; }\n");

  const { candidates, comments } = I.extractSignals(work);
  const seams = I.clusterResourceSeams(candidates, work, { comments });
  const toks = seams.map((s) => s.token).sort();
  eq(JSON.stringify(toks), JSON.stringify(['SUPPORT_STATE_PATH']),
    `value(H4/H5): only the genuine shared PATH is proposed — not a version string, and not a template whose interpolation differs (got ${toks.join(', ') || 'none'})`);
  rmSync(work, { recursive: true, force: true });
}

// --- K3: value-unknown definitions EXCLUDE the compartment --------------------
// `values` held only EXTRACTED definitions, so a compartment whose own copy of the
// constant is computed produced no candidate at all and was treated as a pure USER —
// joining a seam on a value it does not use.
async function valueUnknownExclusionTest() {
  const I = await import('../src/contracts/infer.js');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-unknown-')));
  for (const d of ['idx-a', 'idx-b', 'idx-env', 'idx-let']) mkdirSync(join(work, d, '.git'), { recursive: true });
  const real = "export const INDEX_CACHE_PATH = '/var/cache/idx/index.db';\n";
  writeFileSync(join(work, 'idx-a', 'a.js'), real + 'export function idxA() { return INDEX_CACHE_PATH; }\n');
  writeFileSync(join(work, 'idx-b', 'b.js'), real + 'export function idxB() { return INDEX_CACHE_PATH; }\n');
  // Its own copy, computed. Same name, and a value wiregraph cannot read.
  writeFileSync(join(work, 'idx-env', 'e.js'),
    "export const INDEX_CACHE_PATH = process.env.INDEX_CACHE || '/somewhere/else/entirely.db';\n"
    + 'export function idxEnv() { return INDEX_CACHE_PATH; }\n');
  // A module-scope `let` REBINDING — the same hole in a different shape.
  writeFileSync(join(work, 'idx-let', 'l.js'),
    "let INDEX_CACHE_PATH = '/var/cache/idx/index.db';\n"
    + "INDEX_CACHE_PATH = '/tmp/override.db';\n"
    + 'export function idxLet() { return INDEX_CACHE_PATH; }\n');

  const { candidates, comments } = I.extractSignals(work);
  const rejected = [];
  const seams = I.clusterResourceSeams(candidates, work, { comments, rejected });
  const s = seams.find((x) => x.token === 'INDEX_CACHE_PATH');
  eq(JSON.stringify(s?.compartments), JSON.stringify(['idx-a', 'idx-b']),
    `unknown(K3): a compartment that DEFINES the name with a value wiregraph cannot read is excluded, not joined (got ${JSON.stringify(s?.compartments)})`);
  ok(rejected.some((r) => r.includes('idx-env') && r.includes('cannot read')),
    `unknown(K3): …and the exclusion is reported with a reason (got ${JSON.stringify(rejected)})`);
  ok(rejected.some((r) => r.includes('idx-let')),
    'unknown(K3): a module-scope let/var rebinding is excluded on the same evidence');
  rmSync(work, { recursive: true, force: true });
}

// --- H6: two same-format resource specs sharing a title MERGE ------------------
// `/wiregraph-contracts apply` writes into contracts/ and `/wiregraph-link` writes the
// same default-titled draft into .wiregraph/inferred/. The AsyncAPI pair merges; the
// resource pair used to log a collision and SKIP one, so a linked multi-repo graph that
// also ran apply lost every cross-member inferred resource seam.
async function resourceSpecTitleMergeTest() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-resmerge-')));
  for (const d of ['alpha', 'beta', 'gamma', 'delta']) mkdirSync(join(work, d, '.git'), { recursive: true });
  writeFileSync(join(work, 'alpha', 'a.js'), "export const HOME_STATE_PATH = '/var/run/home.json';\nexport function aw() { return HOME_STATE_PATH; }\n");
  writeFileSync(join(work, 'beta', 'b.js'), "import { HOME_STATE_PATH } from '../alpha/a.js';\nexport function br() { return HOME_STATE_PATH; }\n");
  writeFileSync(join(work, 'gamma', 'g.js'), "export const PEER_STATE_PATH = '/var/run/peer.json';\nexport function gw() { return PEER_STATE_PATH; }\n");
  writeFileSync(join(work, 'delta', 'd.js'), "import { PEER_STATE_PATH } from '../gamma/g.js';\nexport function dr() { return PEER_STATE_PATH; }\n");

  // SAME title in both dirs, exactly as the two writers produce.
  const spec = (id, w, r) => `title: wiregraph-inferred-resources\nresources:\n  - id: ${id}\n    kind: path\n    writers: [${w}]\n    readers: [${r}]\n`;
  mkdirSync(join(work, 'contracts'), { recursive: true });
  writeFileSync(join(work, 'contracts', 'wiregraph-inferred.resource.yaml'), spec('HOME_STATE_PATH', 'alpha', 'beta'));
  mkdirSync(join(work, '.wiregraph', 'inferred'), { recursive: true });
  writeFileSync(join(work, '.wiregraph', 'inferred', 'wiregraph-inferred.resource.yaml'), spec('PEER_STATE_PATH', 'gamma', 'delta'));

  const db = join(work, '.wiregraph', 'graph.db');
  await runBuild({ target: work, project: work, db, reset: true });
  const c = connect(db, { readonly: true });
  const toks = c.prepare(
    `SELECT ct.token t FROM contract_tokens ct JOIN contracts co ON co.id=ct.contract
      WHERE ct.project=? AND co.name='wiregraph-inferred-resources' ORDER BY ct.token`).all(work).map((r) => r.t);
  const pairs = c.prepare(
    `SELECT sp.compartment sc, dp.compartment dc, e.token t FROM edges e
       JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
      WHERE e.project=? AND e.type='RESOURCE' ORDER BY e.token`).all(work).map((r) => `${r.t}|${r.sc}->${r.dc}`);
  c.close();
  eq(JSON.stringify(toks), JSON.stringify(['HOME_STATE_PATH', 'PEER_STATE_PATH']),
    `resmerge(H6): two same-format resource specs sharing a title MERGE into one contract, exactly as the AsyncAPI pair does (got ${toks.join(', ') || 'none'})`);
  eq(JSON.stringify(pairs), JSON.stringify(['HOME_STATE_PATH|alpha->beta', 'PEER_STATE_PATH|gamma->delta']),
    `resmerge(H6): so BOTH seams derive — the cross-member half is not skipped (got ${pairs.join(', ') || 'none'})`);

  // The cross-FORMAT guard is kept, and its warning must identify BOTH files by PATH.
  // `c.file` is a BASENAME, so the old message named the same string twice and the user
  // could not tell which two files collided.
  const C = await import('../src/extract/contracts.js');
  writeFileSync(join(work, 'contracts', 'wiregraph-inferred.asyncapi.yaml'),
    "asyncapi: 3.0.0\ninfo:\n  title: wiregraph-inferred-resources\n  version: '1.0.0'\nchannels:\n  x:\n    address: /api/collide\n");
  const logs = [];
  C.loadAllContracts(new Graph(work), [join(work, 'contracts'), join(work, '.wiregraph', 'inferred')], (m) => logs.push(m));
  const collision = logs.find((m) => m.includes('title collision'));
  ok(collision, `resmerge(H6): a CROSS-format title collision is still refused (got ${logs.join(' | ')})`);
  ok(collision && collision.includes(join(work, 'contracts', 'wiregraph-inferred.asyncapi.yaml')),
    `resmerge(H6): …and the warning names the colliding files by PATH, not by a bare basename (got ${collision})`);
  ok(collision && collision.includes(join(work, '.wiregraph', 'inferred', 'wiregraph-inferred.resource.yaml')),
    'resmerge(H6): …including the one in the other directory, which a basename could never distinguish');

  rmSync(work, { recursive: true, force: true });
}

// --- H7: the total-overlap warning, pinned in BOTH directions -----------------
// The emitted draft is ALWAYS total-overlap, so warning about it meant one ⚠ per
// resource on every build, forever, in the same marker as a genuine problem. Silencing
// it outright would be just as wrong: for a HAND-WRITTEN spec, naming every compartment
// on both sides really is a mistake. Both mutations — collapsing the wording split and
// silencing the warning entirely — used to produce ZERO failures.
async function totalOverlapWarningTest() {
  const R = await import('../src/extract/resource-spec.js');
  const YAML = (await import('yaml')).default;
  const parse = (doc) => { const l = []; R.parseResourceSpec(doc, 'x.resource.yaml', (m) => l.push(m)); return l; };

  const total = { title: 't', resources: [{ id: 'SHARED_STATE_PATH', writers: ['a', 'b'], readers: ['a', 'b'] }] };
  const handWritten = parse(total);
  ok(handWritten.some((m) => m.includes('⚠') && m.includes('BOTH writer and reader')),
    `overlap(H7): a HAND-WRITTEN spec with total role overlap still warns (got ${handWritten.join(' | ') || 'none'})`);
  has(handWritten.join('\n'), 'derives a seam for every cross-compartment pair',
    'overlap(H7): …with the TOTAL-overlap wording, which says edges ARE still derived');

  const draft = parse({ ...total, 'x-wiregraph-inferred': true });
  eq(draft.filter((m) => m.includes('⚠')).length, 0,
    `overlap(H7): the SAME content marked as a generated draft loads with zero warnings (got ${draft.join(' | ') || 'none'})`);

  // The PARTIAL case keeps its own, different wording — there one compartment really is
  // doubling as its own reader, and the resource may derive nothing at all.
  const partial = parse({ title: 't', resources: [{ id: 'SHARED_STATE_PATH', writers: ['a', 'b'], readers: ['a'] }] });
  has(partial.join('\n'), 'derives NO edges',
    `overlap(H7): a PARTIAL overlap keeps the distinct "derives NO edges" wording (got ${partial.join(' | ') || 'none'})`);
  ok(!partial.join('\n').includes('derives a seam for every cross-compartment pair'),
    'overlap(H7): …and the two messages are genuinely different, so collapsing them fails');
  // …and a partial overlap in a generated draft still warns: the marker suppresses the
  // ONE expected shape, not every role complaint.
  const partialDraft = parse({ title: 't', 'x-wiregraph-inferred': true, resources: [{ id: 'SHARED_STATE_PATH', writers: ['a', 'b'], readers: ['a'] }] });
  ok(partialDraft.some((m) => m.includes('⚠')),
    `overlap(H7): the marker suppresses ONLY the total-overlap shape (got ${partialDraft.join(' | ') || 'none'})`);

  // And the emitter really does write the marker, so the two halves cannot drift.
  const I = await import('../src/contracts/infer.js');
  const yaml = I.synthesizeResourceSpec([{ kind: 'resource', token: 'A_STATE_PATH', value: '/var/run/a.json', compartments: ['a', 'b'], definers: ['a'], corroborated: [], layout: 'shared-module' }]);
  eq(YAML.parse(yaml)['x-wiregraph-inferred'], true, 'overlap(H7): synthesizeResourceSpec writes the marker the loader keys on');
}

// --- M8: the fan-out cap does not truncate silently ---------------------------
// Symmetric writer/reader lists — the shape inference emits — legitimately cross into
// k(k-1) compartment pairs, so a flat per-TOKEN cap of 25 bit on real seams: 2
// compartments x 4 symbols produced 25 edges where 32 were expected, and 3 x 6 left 15
// of 18 symbols with no outgoing seam at all, dropped in arbitrary iteration order and
// unlogged. Budget per COMPARTMENT PAIR, round-robin within it, and log every drop.
async function fanOutCapTest() {
  const build = async (nComps, nSyms, prefix) => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    const comps = Array.from({ length: nComps }, (_, i) => `c${i}`);
    for (const d of comps) {
      mkdirSync(join(work, d, '.git'), { recursive: true });
      const fns = Array.from({ length: nSyms }, (_, j) => `export function ${d}fn${j}() { return FANOUT_STATE_PATH; }`);
      writeFileSync(join(work, d, 'x.js'), `export const FANOUT_STATE_PATH = '/var/run/fanout.json';\n${fns.join('\n')}\n`);
    }
    mkdirSync(join(work, 'contracts'), { recursive: true });
    writeFileSync(join(work, 'contracts', 'f.resource.yaml'),
      `title: fanout\nresources:\n  - id: FANOUT_STATE_PATH\n    kind: path\n    writers: [${comps.join(', ')}]\n    readers: [${comps.join(', ')}]\n`);
    const db = join(work, '.wiregraph', 'graph.db');
    // Through the build CLI, so the truncation notice is asserted where a user would
    // actually see it (build.js logs to stderr) rather than through an injected hook.
    const out = await execFileP('node', [BUILD, work, '--project', work, '--db', db, '--reset']);
    const lines = [out.stderr || '', out.stdout || ''];
    const c = connect(db, { readonly: true });
    const rows = c.prepare(
      `SELECT sp.name sn, dp.name dn FROM edges e JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
        WHERE e.project=? AND e.type='RESOURCE'`).all(work);
    c.close();
    rmSync(work, { recursive: true, force: true });
    return { rows, log: lines.join('\n'), comps };
  };

  // 2 compartments x 4 symbols: 2 ordered compartment pairs x 16 = 32 legitimate seams.
  // The old per-token cap emitted 25 and dropped 7 without a word.
  const a = await build(2, 4, 'cg-fanout2-');
  eq(a.rows.length, 32, `fanout(M8): 2 compartments x 4 symbols derives all 32 cross-compartment seams (got ${a.rows.length})`);
  ok(!a.log.includes('fan-out cap'), 'fanout(M8): …and nothing is reported as capped, because nothing was');

  // 3 compartments x 6 symbols: 6 ordered pairs x 36 = 216 wanted, 25 allowed per pair.
  // The cap still applies — but it must be REPORTED, and it must not starve whole symbols.
  const b = await build(3, 6, 'cg-fanout3-');
  const sources = new Set(b.rows.map((r) => r.sn));
  eq(b.rows.length, 150, `fanout(M8): the cap is a budget PER COMPARTMENT PAIR — 6 pairs x 25 (got ${b.rows.length})`);
  eq(sources.size, 18, `fanout(M8): and round-robin gives EVERY symbol an outgoing seam, instead of exhausting the budget on the first few (got ${sources.size} of 18)`);
  has(b.log, 'fan-out cap', 'fanout(M8): the truncation is LOGGED — the design principle is no silent caps');
  has(b.log, 'RESOURCE edge(s) NOT derived', 'fanout(M8): …saying how many edges were dropped');
  has(b.log, 'hit the fan-out cap', 'fanout(M8): …and the summary line counts them');
}

// --- M12: resourceKindFor is exercised, not decorative ------------------------
// It could be replaced by `() => 'path'` with zero failures: shm/pipe had no test and
// `db` is not inferable from a literal at all.
async function resourceKindTest() {
  const I = await import('../src/contracts/infer.js');
  const R = await import('../src/extract/resource-spec.js');
  eq(I.resourceKindFor('/dev/shm/game-region'), 'shm', 'kind(M12): a /dev/shm value is shared memory');
  eq(I.resourceKindFor('/var/run/app.sock'), 'pipe', 'kind(M12): a .sock value is a pipe/socket');
  eq(I.resourceKindFor('/var/run/app.fifo'), 'pipe', 'kind(M12): …as is a .fifo');
  eq(I.resourceKindFor('/dev/ttyS0'), 'pipe', 'kind(M12): …and a /dev node');
  eq(I.resourceKindFor('/var/run/game/state.json'), 'path', 'kind(M12): an ordinary path is a path');
  eq(I.resourceKindFor('events_v2'), 'path', 'kind(M12): a table name is NOT inferable as db — path is the honest default');
  for (const k of ['shm', 'pipe', 'path']) ok(R.RESOURCE_KINDS.includes(k), `kind(M12): ${k} is a kind the loader accepts`);
  // …and it reaches the emitted spec, so the mapping is not merely internal.
  const yaml = I.synthesizeResourceSpec([
    { kind: 'resource', token: 'REGION_SHM_PATH', value: '/dev/shm/region', compartments: ['a', 'b'], definers: ['a', 'b'], corroborated: [], layout: 'vendored' },
    { kind: 'resource', token: 'CTRL_SOCK_PATH', value: '/var/run/ctrl.sock', compartments: ['a', 'b'], definers: ['a', 'b'], corroborated: [], layout: 'vendored' },
  ]);
  const YAML = (await import('yaml')).default;
  const byId = new Map(YAML.parse(yaml).resources.map((r) => [r.id, r.kind]));
  eq(byId.get('REGION_SHM_PATH'), 'shm', 'kind(M12): the inferred kind lands in the emitted draft');
  eq(byId.get('CTRL_SOCK_PATH'), 'pipe', 'kind(M12): …for both readable kinds');
}

// =============================================================================
// PHASE 3 — RECURSIVE CONTRACTS DISCOVERY + SUBTREE SCOPING
// =============================================================================
// test/fixture-nested/ is the motivating structure from the design doc:
//
//   contracts/            outer: netcli <-> netsrv, plus harness <-> netsrv
//   server/contracts/     inner: ecs -> sim -> netsrv   (RE-DECLARES /api/state)
//   client/contracts/     inner: world_state -> netcli
//   vendor/contracts/     under IGNORE_DIRS — must never be discovered
//   dist/contracts/       likewise
//
// It has a root manifest plus nested package.json manifests at two depths, so it is a
// legal fixture in BOTH modes, and every cross-mention needed to prove scoping is real:
// server/netsrv names /ui/frame (client-only), client/world_state names /internal/tick
// (server-only), and /api/state is declared by an outer AND an inner contract.
const FIXTURE_NESTED = join(HERE, 'fixture-nested');

// Copy the fixture and, unless `mode` is omitted, declare recursive mode + the
// compartments. Returns the realpath'd root.
function nestedProject(work, { recursive = true } = {}) {
  const root = realpathSync(work);
  cpSync(FIXTURE_NESTED, root, { recursive: true });
  if (recursive) {
    mkdirSync(join(root, '.wiregraph'), { recursive: true });
    writeFileSync(join(root, '.wiregraph', 'state.json'), JSON.stringify({
      project: root, indexedRoots: [root], links: [], reposLastSha: {}, autoUpdate: 'balanced',
      mode: 'recursive',
      compartments: [
        { path: 'server/ecs', name: 'ecs' }, { path: 'server/sim', name: 'sim' },
        { path: 'server/netsrv', name: 'netsrv' }, { path: 'client/netcli', name: 'netcli' },
        { path: 'client/world_state', name: 'world_state' }, { path: 'harness', name: 'harness' },
      ],
    }, null, 2));
  }
  return root;
}

// (contract name, token) -> sorted list of referencing compartments. The single shape
// every scoping assertion below keys on: a token matching where it must not is exactly a
// compartment appearing in a list it does not belong in.
function refMap(db, project) {
  const m = new Map();
  const rows = db.prepare(
    "SELECT c.name cname, e.token tok, s.compartment comp FROM edges e "
    + 'JOIN symbols s ON s.id = e.src JOIN contracts c ON c.id = e.dst '
    + "WHERE e.project = ? AND e.type = 'REFERENCES'",
  ).all(project);
  for (const r of rows) {
    const k = `${r.cname}|${r.tok}`;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(r.comp);
  }
  return new Map([...m].map(([k, v]) => [k, [...v].sort()]));
}
const refsFor = (m, key) => JSON.stringify(m.get(key) ?? []);

// --- discovery ---------------------------------------------------------------
// Depth, IGNORE_DIRS, ordering, and the untouched global path.
async function recursiveDiscoveryTest() {
  const { detectContractsDirs } = await import('../src/build.js');
  const work = mkdtempSync(join(tmpdir(), 'cg-rdisco-'));
  const root = nestedProject(work);
  const rel = (dirs) => dirs.map((d) => relative(root, d) || '.');

  // GLOBAL (no options at all — the call shape every legacy caller uses) is DEPTH 1.
  eq(JSON.stringify(rel(detectContractsDirs(root))), JSON.stringify(['contracts']),
    'rdisco: global mode is UNCHANGED — depth 1, so the nested dirs are invisible to it');

  const dirs = detectContractsDirs(root, { recursive: true });
  eq(JSON.stringify(rel(dirs)), JSON.stringify(['contracts', 'client/contracts', 'server/contracts']),
    'rdisco: recursive mode finds every nested contracts dir, SHALLOWEST first then lexicographic');

  // IGNORE_DIRS. Both of these hold a real, parseable spec, so nothing but the filter
  // keeps them out — and the depth-1 scan never needed the filter, which is exactly why
  // it is easy to omit when adding recursion.
  const { IGNORE_DIRS } = await import('../src/extract/lang.js');
  ok(IGNORE_DIRS.has('vendor') && IGNORE_DIRS.has('dist'), 'rdisco: the fixture probes two REAL IGNORE_DIRS entries');
  ok(existsSync(join(root, 'vendor/contracts/vendored.asyncapi.yaml')), 'rdisco: …and the vendored spec is really on disk');
  ok(!rel(dirs).includes('vendor/contracts'), 'rdisco: recursion SKIPS IGNORE_DIRS — vendor/contracts is not a contracts home');
  ok(!rel(dirs).includes('dist/contracts'), 'rdisco: …nor is dist/contracts');

  // Arbitrary depth, not "one more level". A contracts dir four deep is still found.
  mkdirSync(join(root, 'server/ecs/sub/deeper/contracts'), { recursive: true });
  ok(rel(detectContractsDirs(root, { recursive: true })).includes('server/ecs/sub/deeper/contracts'),
    'rdisco: depth is UNBOUNDED — a contracts dir 4 levels down is found');
  eq(JSON.stringify(rel(detectContractsDirs(root))), JSON.stringify(['contracts']),
    'rdisco: …and adding it changed nothing for global mode');

  // A symlinked contracts dir is still MATCHED in recursive mode (the deliberate
  // inconsistency with declared-compartment validation, preserved from Phase 2) — while
  // DESCENT refuses to follow links, so a symlink cycle cannot hang the scan.
  const realCon = join(root, 'harness', 'shared-contracts');
  mkdirSync(realCon, { recursive: true });
  symlinkSync(realCon, join(root, 'client', 'linked-contracts'));
  symlinkSync(root, join(root, 'harness', 'loop')); // a cycle, if descent followed links
  const withLinks = rel(detectContractsDirs(root, { recursive: true }));
  ok(withLinks.includes('client/linked-contracts'), 'rdisco: a SYMLINKED contracts dir is followed (matched), as in global mode');
  ok(withLinks.includes('harness/shared-contracts'), 'rdisco: …and its real target is found on its own too');
  ok(withLinks.length < 20, 'rdisco: a symlink CYCLE does not blow up the scan — descent uses isDirectory(), never a link');

  rmSync(work, { recursive: true, force: true });
}

// /wiregraph-init step 2a classifies the repo's contracts structure BEFORE asking which
// mode the user wants, so its scan must be the ENGINE's, not an approximation — this is
// the third place the contracts-dir rule has lived, and the previous two drifted.
async function initContractsStructureTest() {
  const { detectContractsDirs } = await import('../src/build.js');
  const work = mkdtempSync(join(tmpdir(), 'cg-rstruct-'));
  const root = nestedProject(work, { recursive: false });
  const run = async (t) => (await execFileP('node', [join(HERE, '..', 'scripts', 'lib', 'workspace.mjs'), 'contracts-dirs', t])).stdout;

  const out = await run(root);
  has(out, 'structure: nested (dirs=3)', 'rstruct: the nested fixture classifies as NESTED with exactly the three real dirs');
  ok(!out.includes('vendor/contracts') && !out.includes('dist/contracts'),
    'rstruct: …and the IGNORE_DIRS specs are excluded, so the mode question is not asked on an inflated count');
  const listed = out.split('\n').filter((l) => l.startsWith('  - ')).map((l) => l.slice(4)).sort();
  eq(JSON.stringify(listed), JSON.stringify(detectContractsDirs(root, { recursive: true }).map((d) => relative(root, d) || '.').sort()),
    'rstruct: the init helper reports EXACTLY what a recursive build discovers — one implementation, nothing to drift');

  const flat = join(work, 'flat');
  mkdirSync(join(flat, 'contracts'), { recursive: true });
  has(await run(flat), 'structure: root-only (dirs=1)', 'rstruct: a single depth-1 dir is ROOT-ONLY');
  mkdirSync(join(work, 'bare'), { recursive: true });
  has(await run(join(work, 'bare')), 'structure: none (dirs=0)', 'rstruct: no contracts dir anywhere is NONE');

  // H6 — THE CANONICAL NESTED LAYOUT, which is the motivating structure of this whole
  // feature: `server/contracts` + `client/contracts` and NO root `contracts/`. That gives
  // depths={1}, so the old test (`size > 1 || some(x > 1)`) said root-only and /wiregraph
  // -init asked the mode question on a false premise. The existing cases only covered
  // {0,1}, {0} and {} — every one of which the broken test happened to get right.
  const canon = join(work, 'canon');
  mkdirSync(join(canon, 'server', 'contracts'), { recursive: true });
  mkdirSync(join(canon, 'client', 'contracts'), { recursive: true });
  has(await run(canon), 'structure: nested (dirs=2)',
    'rstruct: two SECOND-level contracts dirs with no root one is NESTED — the design\'s own motivating layout');
  const deepOnly = join(work, 'deeponly');
  mkdirSync(join(deepOnly, 'a', 'b', 'contracts'), { recursive: true });
  has(await run(deepOnly), 'structure: nested (dirs=1)', 'rstruct: …and a single dir two levels down is nested too, not root-only');

  rmSync(work, { recursive: true, force: true });
}

// --- scoping ------------------------------------------------------------------
// The feature itself: a contracts dir governs its parent's subtree and nothing else.
async function contractScopingTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-rscope-'));
  const root = nestedProject(work);
  const db = join(work, 'graph.db');
  await runBuild({ target: root, project: root, db, reset: true });
  const conn = connect(db, { readonly: true });
  const m = refMap(conn, root);

  eq(conn.prepare('SELECT count(*) n FROM contracts WHERE project = ?').get(root).n, 3,
    'rscope: all three nested specs load as three DISTINCT contract nodes');

  // 1. A token declared ONLY by client/contracts must not match code under server/ —
  //    even though server/netsrv/net.js names /ui/frame verbatim.
  eq(refsFor(m, 'Client Inner Wire|/ui/frame'), JSON.stringify(['netcli', 'world_state']),
    'rscope: /ui/frame (client/contracts) matches ONLY inside client/ — netsrv names it and is correctly excluded');
  ok(readFileSync(join(root, 'server/netsrv/net.js'), 'utf8').includes('/ui/frame'),
    'rscope: …and that exclusion is real: the server file does contain the literal');

  // 2. Symmetrically for the server-side contract.
  eq(refsFor(m, 'Server Inner Wire|/internal/tick'), JSON.stringify(['ecs', 'sim']),
    'rscope: /internal/tick (server/contracts) matches ONLY inside server/ — world_state names it and is excluded');
  ok(readFileSync(join(root, 'client/world_state/ws.js'), 'utf8').includes('/internal/tick'),
    'rscope: …likewise real: the client file does contain the literal');

  // 3. LONGEST PREFIX WINS. /api/state is declared by BOTH the outer contracts/ (scope =
  //    the whole tree) and server/contracts/ (scope = server/). Under server/ the inner
  //    one owns it; everywhere else the outer one does. Neither sees both.
  eq(refsFor(m, 'Server Inner Wire|/api/state'), JSON.stringify(['netsrv', 'sim']),
    'rscope: longest prefix — under server/, the INNER contract owns the shared route');
  eq(refsFor(m, 'Nested Outer Wire|/api/state'), JSON.stringify(['harness', 'netcli']),
    'rscope: …and the OUTER contract keeps exactly the halves outside that subtree');

  // 4. An outer token no inner contract re-declares still reaches the whole tree, so the
  //    outer scope really is the root and not merely "the files nothing else claimed".
  eq(refsFor(m, 'Nested Outer Wire|/harness/probe'), JSON.stringify(['harness', 'netsrv']),
    'rscope: an outer-only token still spans the WHOLE tree, netsrv included');

  // 5. WIRE derivation follows the scoped REFERENCES with no scope logic of its own.
  const wire = conn.prepare("SELECT contract, token FROM edges WHERE project=? AND type='WIRE' ORDER BY contract, token").all(root)
    .map((r) => `${r.contract}|${r.token}`);
  eq(JSON.stringify(wire), JSON.stringify([
    'Client Inner Wire|/ui/frame', 'Nested Outer Wire|/harness/probe',
    'Server Inner Wire|/api/state', 'Server Inner Wire|/internal/tick',
  ]), 'rscope: every derived WIRE seam is intra-scope; the outer /api/state seam is honestly reported as a GAP, not silently double-counted');

  // 6. The specs under IGNORE_DIRS never became contract nodes, and the tokens only they
  //    declare mint nothing even though harness names both.
  eq(conn.prepare("SELECT count(*) n FROM contracts WHERE project=? AND name IN ('Vendored Leak','Dist Leak')").get(root).n, 0,
    'rscope: no contract node from vendor/ or dist/');
  eq(conn.prepare("SELECT count(*) n FROM edges WHERE project=? AND type='REFERENCES' AND token IN ('/vendored/only','/dist/only')").get(root).n, 0,
    'rscope: …and their tokens mint no REFERENCES, though harness names them verbatim');

  // 7. state.contractsDirs (PLURAL) records all three; the singular stays the outermost.
  const S = await import('../scripts/lib/state.mjs');
  const st = S.readState(root);
  eq(JSON.stringify((st.contractsDirs || []).map((d) => relative(root, d))),
    JSON.stringify(['contracts', 'client/contracts', 'server/contracts']),
    'rscope: the full build stamps contractsDirs (plural) — one per governed subtree');
  eq(st.contractsDir, join(root, 'contracts'),
    'rscope: …and contractsDir (singular) stays the OUTERMOST one, which is what /wiregraph-contracts writes into');
  has(S.modeLine(st), 'contracts SCOPED to 3 dir(s)', 'rscope: graph_status Mode: reports the scoping, not just the compartments');

  conn.close();
  rmSync(work, { recursive: true, force: true });
}

// --- the two DELIBERATELY unscoped sources ------------------------------------
// `--contracts <dir>` is a CLI/CI override with no natural scope, and
// `.wiregraph/inferred/` sits outside every source subtree. Both must keep matching
// EVERYTHING even in recursive mode, or a scripted caller's build quietly changes meaning
// and every link-inferred cross-member seam goes dark.
async function unscopedContractSourcesTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-runscoped-'));
  const root = nestedProject(work);

  // (a) --contracts pointed at the CLIENT's dir. If it were scoped to dirname() the
  //     server half could never match; unscoped, /ui/frame matches on both sides.
  const dbA = join(work, 'a.db');
  await runBuild({ target: root, project: root, db: dbA, reset: true, contracts: join(root, 'client/contracts') });
  let conn = connect(dbA, { readonly: true });
  let m = refMap(conn, root);
  eq(refsFor(m, 'Client Inner Wire|/ui/frame'), JSON.stringify(['netcli', 'netsrv', 'world_state']),
    'runscoped: --contracts is ALWAYS unscoped — netsrv matches a client-dir token, exactly as it would in global mode');
  eq(conn.prepare('SELECT count(*) n FROM contracts WHERE project=?').get(root).n, 1,
    'runscoped: …and --contracts still overrides discovery entirely (one contract, not four)');
  conn.close();

  // (b) .wiregraph/inferred/ — the link-inferred spec. Written into the project's own
  //     .wiregraph/, i.e. OUTSIDE every source subtree, so dirname() would scope it to
  //     .wiregraph/ and it would match nothing at all.
  mkdirSync(join(root, '.wiregraph', 'inferred'), { recursive: true });
  writeFileSync(join(root, '.wiregraph', 'inferred', 'wiregraph-inferred.asyncapi.yaml'),
    'asyncapi: 3.0.0\ninfo: { title: Link Inferred, version: 1.0.0 }\nchannels:\n'
    + '  f: { address: /ui/frame, x-wiregraph-producers: [world_state], x-wiregraph-consumers: [netsrv] }\n');
  const dbB = join(work, 'b.db');
  await runBuild({ target: root, project: root, db: dbB, reset: true });
  conn = connect(dbB, { readonly: true });
  m = refMap(conn, root);
  eq(refsFor(m, 'Link Inferred|/ui/frame'), JSON.stringify(['netcli', 'netsrv', 'world_state']),
    'runscoped: .wiregraph/inferred/ is ALWAYS unscoped — it matches across every subtree');
  eq(refsFor(m, 'Client Inner Wire|/ui/frame'), JSON.stringify(['netcli', 'world_state']),
    'runscoped: …and an unscoped contract does not WIDEN the scoped one that shares its token');
  ok(conn.prepare("SELECT count(*) n FROM edges WHERE project=? AND type='WIRE' AND contract='Link Inferred'").get(root).n > 0,
    'runscoped: the link-inferred seam actually lights up rather than going dark');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// --- the distinct-title requirement -------------------------------------------
// contractId is `contract:<info.title>` and mergeContracts UNIONs tokens across specs
// sharing an id — so two NESTED specs with the same title collapse into one node whose
// scope covers both subtrees, and scoping silently becomes a no-op. The rule is keyed on
// the SCOPE, which is what lets it coexist with Phase 1b's same-format merge.
async function distinctContractTitleTest() {
  const C = await import('../src/extract/contracts.js');
  const { Graph } = await import('../src/model.js');
  const work = mkdtempSync(join(tmpdir(), 'cg-rtitle-'));
  const A = join(work, 'server', 'contracts'), B = join(work, 'client', 'contracts');
  mkdirSync(A, { recursive: true }); mkdirSync(B, { recursive: true });
  const spec = (title, addr) => `asyncapi: 3.0.0\ninfo: { title: ${title}, version: 1.0.0 }\nchannels:\n  c: { address: ${addr} }\n`;
  writeFileSync(join(A, 'a.asyncapi.yaml'), spec('Shared Title', '/server/alpha'));
  writeFileSync(join(B, 'b.asyncapi.yaml'), spec('Shared Title', '/client/beta'));

  const logs = [];
  const log = (s) => logs.push(s);
  const merged = C.loadAllContracts(new Graph('p'), [
    { dir: A, scopeRoot: join(work, 'server') }, { dir: B, scopeRoot: join(work, 'client') },
  ], log);
  eq(merged.length, 1, 'rtitle: two DIFFERENTLY-SCOPED specs sharing a title collapse to one id — so the later one must be skipped, not merged');
  eq(JSON.stringify(merged[0].tokens), JSON.stringify(['/server/alpha']),
    'rtitle: the FIRST (outer/earlier) spec is kept and the later one is SKIPPED — no token union across scopes');
  const warn = logs.find((l) => l.includes('title collision ACROSS SCOPES')) || '';
  has(warn, join(A, 'a.asyncapi.yaml'), 'rtitle: the warning names the kept spec by FULL PATH');
  has(warn, join(B, 'b.asyncapi.yaml'), 'rtitle: …and the skipped one by full path too — two same-named files in different dirs must be distinguishable');
  ok(warn.indexOf(join(A, 'a.asyncapi.yaml')) !== warn.indexOf(join(B, 'b.asyncapi.yaml')),
    'rtitle: …and the two paths are genuinely different strings (the Phase 1b basename defect)');

  // COMPOSITION 1 — SAME scope still MERGES. Two specs in one contracts dir govern
  // identical territory, so there is no scope to lose and the union is right.
  writeFileSync(join(A, 'a2.asyncapi.yaml'), spec('Shared Title', '/server/gamma'));
  const sameScope = C.loadAllContracts(new Graph('p'), [{ dir: A, scopeRoot: join(work, 'server') }], () => {});
  eq(JSON.stringify(sameScope[0].tokens.sort()), JSON.stringify(['/server/alpha', '/server/gamma']),
    'rtitle: SAME-scope collisions still MERGE (Phase 1b) — identical territory, so the union loses nothing');

  // COMPOSITION 2 — an UNSCOPED partner still MERGES. This is the routine case Phase 1b
  // fixed: `/wiregraph-contracts apply` writes the default-titled draft into contracts/
  // while /wiregraph-link writes the SAME title into .wiregraph/inferred/. Skipping the
  // later one there cost a linked multi-repo graph every cross-member seam.
  const INF = join(work, '.wiregraph', 'inferred');
  mkdirSync(INF, { recursive: true });
  writeFileSync(join(INF, 'wiregraph-inferred.asyncapi.yaml'), spec('Shared Title', '/inferred/delta'));
  const withInferred = C.loadAllContracts(new Graph('p'), [
    { dir: A, scopeRoot: join(work, 'server') }, { dir: INF, scopeRoot: null },
  ], () => {});
  ok(withInferred[0].tokens.includes('/inferred/delta') && withInferred[0].tokens.includes('/server/alpha'),
    'rtitle: an UNSCOPED partner (.wiregraph/inferred/) still MERGES — unscoped matches everywhere, so absorbing a scoped sibling can only widen');

  // COMPOSITION 3 — the CROSS-FORMAT guard runs first and is untouched: AsyncAPI wins,
  // the resource spec is skipped, and only then does the scope rule see what is left.
  const R = join(work, 'res', 'contracts');
  mkdirSync(R, { recursive: true });
  writeFileSync(join(R, 'r.resource.yaml'),
    'title: Shared Title\nresources:\n  - { id: SHARED_STATE_PATH, kind: path, writers: [x], readers: [y] }\n');
  const crossLogs = [];
  const cross = C.loadAllContracts(new Graph('p'), [
    { dir: A, scopeRoot: join(work, 'server') }, { dir: R, scopeRoot: join(work, 'res') },
  ], (s) => crossLogs.push(s));
  eq(cross[0].kind, 'asyncapi', 'rtitle: cross-FORMAT collision is still resolved by format first — AsyncAPI is the incumbent and wins');
  ok(crossLogs.some((l) => l.includes('must be unique ACROSS formats')),
    'rtitle: …and it still reports itself as a cross-format collision, not as a scope one');

  // GLOBAL MODE never reaches the rule: every scope root there is null, so the two specs
  // that collide above merge exactly as they always did.
  const globalMerged = C.loadAllContracts(new Graph('p'), [A, B], () => {});
  ok(globalMerged[0].tokens.includes('/server/alpha') && globalMerged[0].tokens.includes('/client/beta'),
    'rtitle: GLOBAL MODE IS UNCHANGED — bare-string (unscoped) dirs merge on a title collision, as before');

  rmSync(work, { recursive: true, force: true });
}

// --- THE SCHEMA BET -----------------------------------------------------------
// Scope is applied at MATCH time, so nothing is persisted and SCHEMA_VERSION stays 5.
// That is only sound if the incremental re-derive can never build a group a full build
// would not: rederiveWireEdges groups the db's REFERENCES rows by contractId|token with no
// scope of its own, so it is correct exactly when every stored row is already
// scope-correct. This asserts the property end to end — full build, edit a file in the
// DEEPEST scope, incremental, and the derived seams must be byte-identical.
async function recursiveIncrementalParityTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = mkdtempSync(join(tmpdir(), 'cg-rparity-'));
  const root = nestedProject(work);
  const db = join(work, 'graph.db');

  const derived = (path) => {
    const c = connect(path, { readonly: true });
    const rows = c.prepare(
      "SELECT type, src, dst, token, contract FROM edges WHERE project=? AND type IN ('WIRE','RESOURCE') ORDER BY type, contract, token, src, dst",
    ).all(root);
    const refs = c.prepare(
      "SELECT s.compartment comp, e.dst, e.token FROM edges e JOIN symbols s ON s.id=e.src "
      + "WHERE e.project=? AND e.type='REFERENCES' ORDER BY e.dst, e.token, comp",
    ).all(root);
    c.close();
    return JSON.stringify({ rows, refs });
  };

  await runBuild({ target: root, project: root, db, reset: true });
  const afterFull = derived(db);
  eq(SCHEMA_VERSION, 5, 'rparity: SCHEMA_VERSION is still 5 — scope needed no column');

  // Edit a file in the innermost scope in a way that changes nothing semantically, then
  // re-index it incrementally. pruneFile drops its REFERENCES and every derived seam
  // touching it; rederiveWireEdges must rebuild exactly what the full build had.
  const edited = join(root, 'server', 'netsrv', 'net.js');
  appendFileSync(edited, '\nexport function netsrvTail() { return 1; }\n');
  await runBuild({ target: root, project: root, db, files: [edited] });
  // The appended symbol references no token, so the scoped REFERENCES and every derived
  // seam must come back byte-identical.
  eq(derived(db), afterFull,
    'rparity: THE SCHEMA BET HOLDS — an incremental re-derive reproduces the full build\'s scoped seams exactly');

  // …and a genuine full rebuild over the edited tree agrees with the incremental, which
  // is the property that would break if a cross-scope group could form.
  const db2 = join(work, 'full2.db');
  await runBuild({ target: root, project: root, db: db2, reset: true });
  eq(derived(db), derived(db2),
    'rparity: …and a FULL REBUILD of the edited tree produces the same set, so no cross-scope group leaked in');

  // The full build stamps the contracts-dir SET (see contractsFingerprintTest), and there
  // is deliberately NO on-disk discovery cache any more: the incremental has to resolve the
  // set live to compare it against that stamp, so a cache could only ever answer with the
  // stamp itself. Its removal also took a bare writeFileSync in .wiregraph/ with it.
  ok(!existsSync(join(root, '.wiregraph', 'contracts-dirs.json')),
    'rparity: no discovery cache file — the fingerprint comparison needs a live resolve anyway, so the cache was dead weight whose staleness guard was vacuous on a MOVE');
  const stampedSet = S.readState(root).contractsFingerprint;
  ok(stampedSet && String(stampedSet['.']).startsWith('k2:'),
    'rparity: …and the full build stamped a real (scoped) contracts-dir-set fingerprint for this root, keyed RELATIVE to the project');

  // DELETING a contracts dir moves the set, so the very next incremental REFUSES rather
  // than re-deriving over rows minted while it still existed.
  rmSync(join(root, 'client', 'contracts'), { recursive: true, force: true });
  let refused = null;
  try { await runBuild({ target: root, project: root, db, files: [edited] }); }
  catch (e) { refused = e.message; }
  has(refused || '', 'contract specs in force changed since the last full build',
    'rparity: deleting a contracts dir REFUSES the incremental — its REFERENCES rows were minted under a set that no longer exists');
  const conn = connect(db, { readonly: true });
  ok(conn.prepare("SELECT count(*) n FROM edges WHERE project=? AND type='WIRE' AND contract='Client Inner Wire'").get(root).n > 0,
    'rparity: …and it refused BEFORE mutating anything, so the graph is exactly as the last full build left it');
  conn.close();
  await runBuild({ target: root, project: root, db, reset: true });
  const conn2 = connect(db, { readonly: true });
  eq(conn2.prepare("SELECT count(*) n FROM edges WHERE project=? AND type='WIRE' AND contract='Client Inner Wire'").get(root).n, 0,
    'rparity: …and the full rebuild the refusal asks for is the remedy — the deleted dir\'s seam goes with it');
  conn2.close();
  ok(S.readState(root), 'rparity: state survived the whole sequence');

  rmSync(work, { recursive: true, force: true });
}

// --- GLOBAL MODE IS UNCHANGED --------------------------------------------------
// The same fixture with NO `mode` key. Depth-1 discovery, unscoped matching, inferred
// compartments — every one of the cross-mentions that scoping suppresses must match here,
// because that is what today's engine does and legacy projects must not move.
async function nestedFixtureGlobalModeTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-rglobal-'));
  const root = nestedProject(work, { recursive: false });
  const db = join(work, 'graph.db');
  await runBuild({ target: root, project: root, db, reset: true });
  const conn = connect(db, { readonly: true });

  eq(conn.prepare('SELECT count(*) n FROM contracts WHERE project=?').get(root).n, 1,
    'rglobal: only the DEPTH-1 contracts/ dir is discovered — the nested ones stay invisible');
  const m = refMap(conn, root);
  eq(refsFor(m, 'Nested Outer Wire|/api/state'), JSON.stringify(['harness', 'netcli', 'netsrv', 'sim']),
    'rglobal: matching is UNSCOPED — every compartment that names the token matches, including the ones scoping would exclude');
  eq(refsFor(m, 'Nested Outer Wire|/harness/probe'), JSON.stringify(['harness', 'netsrv']),
    'rglobal: …and the outer-only token behaves exactly as before');

  const S = await import('../scripts/lib/state.mjs');
  const st = S.readState(root);
  eq(st.contractsDir, join(root, 'contracts'), 'rglobal: contractsDir (singular) is the depth-1 dir, unchanged');
  eq(JSON.stringify((st.contractsDirs || []).map((d) => relative(root, d))), JSON.stringify(['contracts']),
    'rglobal: contractsDirs (plural) is filled in global mode too, so the nudge gate needs no mode branch');
  has(S.modeLine(st), 'global — compartments inferred', 'rglobal: the Mode: line is the legacy one');
  // A global-mode root stamps a REAL fingerprint of the specs it resolved, not a constant.
  // It used to hash to the literal 'global' on the theory that "unscoped means nothing to
  // detect" — true about SCOPE, false about STALENESS, and global mode is the DEFAULT and
  // the mode `apply` writes into. The BEHAVIOURAL consequences are pinned by
  // globalContractsStalenessTest below; this just pins that a value exists and moves with
  // the specs rather than being pinned to a literal.
  ok(String(st.contractsFingerprint['.']).startsWith('k2:'),
    'rglobal: a global-mode root stamps a REAL fingerprint of the specs it resolved — no constant exemption for the default mode');
  const gBefore = S.contractsFingerprint([root])['.'];
  writeFileSync(join(root, 'contracts', 'second.asyncapi.yaml'),
    'asyncapi: 3.0.0\ninfo: { title: Second Global Wire, version: 1.0.0 }\nchannels:\n  z: { address: /second/only }\n');
  ok(S.contractsFingerprint([root])['.'] !== gBefore,
    'rglobal: …and adding a spec to that dir MOVES it, where the old constant could not move at all');
  rmSync(join(root, 'contracts', 'second.asyncapi.yaml'), { force: true });
  eq(S.contractsFingerprint([root])['.'], gBefore,
    'rglobal: …and removing it again returns to the same value — the hash is of content, not of a counter');

  conn.close();
  rmSync(work, { recursive: true, force: true });
}

// --- THE RESOLVED CONTRACT SPEC FINGERPRINT -----------------------------------
// The schema bet (§5) says scope is applied at MATCH time and persisted nowhere, and that
// this is sound because the stored rows are already scope-correct. It is sound only while
// the SPECS in force are the ones that minted them: pruneFile deletes rows for the EDITED
// file only, and rederiveWireEdges then groups EVERY REFERENCES row in the db by
// contractId|token with no scope of its own. This is the guard, built exactly as Phase 2's
// compartmentsFingerprint is, and SCHEMA_VERSION stays 5.
//
// ITS SUBJECT IS THE SPECS, NOT THE DIRS. The first version hashed the resolved
// `{dir, scopeRoot}` pairs, and `scopeRoot` is a pure function of `dir` — so the pair
// carried nothing the dir list did not, and mutating the hash down to `[dir]` alone failed
// zero tests. The three assertions below that a dir-set hash cannot satisfy are the point.
async function contractsFingerprintUnitTest() {
  const S = await import('../scripts/lib/state.mjs');
  const { rootContractsEntries } = await import('../src/contracts-dirs.js');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-kfp-')));
  // A real tree, because the subject is now file CONTENT — there is nothing to hash in a
  // hand-made entry list.
  const specOf = (title, addr) => `asyncapi: 3.0.0\ninfo: { title: ${title}, version: 1.0.0 }\nchannels:\n  c: { address: ${addr} }\n`;
  const R = join(work, 'r');
  const put = (rel, body) => { mkdirSync(dirname(join(R, rel)), { recursive: true }); writeFileSync(join(R, rel), body); };
  const fpOf = (root = R, opts = {}) => S.contractsFingerprint([root], opts)['.'];

  // ABSENT MEANS NO BASELINE, NEVER "CHANGED". Every project built before this key existed
  // has no stamp; reading that as drift would force-rebuild all of them on the next
  // catch-up. Same trap schemaOutdated()'s 0 stamp documents.
  eq(S.contractsDrift(undefined, { '/r': 'k2:abc' }), null, 'kfp: an ABSENT stamp is no baseline — never drift');
  eq(S.contractsDrift(null, { '/r': 'k2:abc' }), null, 'kfp: …and null is the same');
  // WAS `eq(…, null, '…and so is a stamp that is not even an object')` — the same fail-open
  // defect fingerprintDrift now closes. ABSENT is no baseline; PRESENT-but-malformed is not.
  ok(S.contractsDrift('nonsense', { '/r': 'k2:abc' }), 'kfp: …but a stamp that is not even an object is MALFORMED and fails SAFE, unlike an absent one');
  eq(S.contractsDrift({ '/other': 'k2:zzz' }, { '/r': 'k2:abc' }), null,
    'kfp: a root with no entry of its own is not compared — a member linked in since the last full build has no baseline either');
  ok(S.contractsDrift({ '/r': 'k2:abc' }, { '/r': 'k2:def' }), 'kfp: a moved value IS drift');
  eq(S.contractsDrift({ '/r': 'k2:abc', '/gone': 'k2:zzz' }, { '/r': 'k2:abc' }), null,
    'kfp: an UNMOUNTED root is simply not compared — a mount blip cannot forge a change (the reposLastSha rule)');

  // --- THE THREE CHANGES A DIR-SET HASH IS BLIND TO --------------------------
  // Recursive mode, TWO contracts dirs, both populated and both staying populated
  // throughout — so the dir set is byte-identical at every step below.
  put('.wiregraph/state.json', JSON.stringify({ project: R, links: [], mode: 'recursive' }));
  put('contracts/outer.asyncapi.yaml', specOf('Outer', '/api/state'));
  put('sub/contracts/inner.asyncapi.yaml', specOf('Inner', '/internal/tick'));
  put('sub/x.js', 'export const a = 1;\n');
  const dirsNow = () => JSON.stringify(S.contractsFingerprint([R], {
    specsOf: (r) => rootContractsEntries(r, true).map((e) => ({ spec: e.dir, scopeRoot: e.scopeRoot, digest: null })),
  }));
  const base = fpOf();
  const baseDirs = dirsNow();
  ok(String(base).startsWith('k2:'), 'kfp: a resolved spec set hashes to a k2 value');

  // (1) A SPEC MOVED between two dirs that BOTH already exist. This is the narrowing that
  //     fabricates §13's cross-scope WIRE edge, and the dir set does not move at all.
  renameSync(join(R, 'contracts', 'outer.asyncapi.yaml'), join(R, 'sub', 'contracts', 'outer.asyncapi.yaml'));
  ok(fpOf() !== base, 'kfp: MOVING a spec between two existing contracts dirs moves the fingerprint');
  eq(dirsNow(), baseDirs, 'kfp: …while the DIR set is byte-identical, which is exactly why hashing dirs could not see it');
  renameSync(join(R, 'sub', 'contracts', 'outer.asyncapi.yaml'), join(R, 'contracts', 'outer.asyncapi.yaml'));
  eq(fpOf(), base, 'kfp: …and moving it back restores the value');

  // (2) A TITLE EDIT. Same file, same dir, different contractId — and retitling is the
  //     remedy enforceDistinctTitlePerScope tells users to apply, so the tool creates it.
  put('contracts/outer.asyncapi.yaml', specOf('Outer Renamed', '/api/state'));
  ok(fpOf() !== base, 'kfp: EDITING info.title moves the fingerprint — same file, different contract id');
  eq(dirsNow(), baseDirs, 'kfp: …with, again, an identical dir set');
  put('contracts/outer.asyncapi.yaml', specOf('Outer', '/api/state'));
  eq(fpOf(), base, 'kfp: …and restoring the title restores the value (CONTENT digest, not mtime — a rewrite alone is not a change)');

  // (3) A SPEC ADDED to / REMOVED from an existing dir.
  put('contracts/extra.asyncapi.yaml', specOf('Extra', '/extra/route'));
  ok(fpOf() !== base, 'kfp: ADDING a spec to an existing dir moves the fingerprint');
  rmSync(join(R, 'contracts', 'extra.asyncapi.yaml'), { force: true });
  eq(fpOf(), base, 'kfp: …and removing it moves it back');

  // An EMPTY contracts dir is deliberately inert: it mints no contract, no REFERENCES row
  // and no seam, so it cannot fabricate a cross-scope group, and forcing a rebuild for it
  // would rebuild for a graph that cannot change. Writing the first spec into it is what
  // moves the value — which is the ADD gap, and the event that matters.
  mkdirSync(join(R, 'sub', 'api-contracts'), { recursive: true });
  eq(fpOf(), base, 'kfp: an EMPTY contracts dir is inert — `mkdir contracts` changes no graph row');
  put('sub/api-contracts/new.asyncapi.yaml', specOf('Newly Added', '/newly/added'));
  ok(fpOf() !== base, 'kfp: …and writing the first spec into it is what moves the value');
  rmSync(join(R, 'sub', 'api-contracts'), { recursive: true, force: true });

  // A CONTENT digest, not mtime+size: mtime churns on every `git checkout`, and a
  // same-size different-content edit must not slip through.
  const before = fpOf();
  const t = new Date(Date.now() + 120000);
  utimesSync(join(R, 'contracts', 'outer.asyncapi.yaml'), t, t);
  eq(fpOf(), before, 'kfp: touching a spec does NOT move the fingerprint — mtime churns on every checkout');
  put('contracts/outer.asyncapi.yaml', specOf('Outer', '/api/stateX').slice(0, -1) + ' ');
  ok(fpOf() !== before, 'kfp: …but a content edit does');
  put('contracts/outer.asyncapi.yaml', specOf('Outer', '/api/state'));

  // RENAME STABILITY, BOTH HALVES. Making the VALUES relative was only half of it: the map
  // KEY was still the absolute root in BOTH fingerprints, so `mv proj proj2` changed every
  // key, fingerprintDrift skipped every root as "no baseline", and both guards went dark.
  // The key is now project-relative too ('.' for the project's own root).
  const R2 = join(work, 'r2');
  renameSync(R, R2);
  eq(fpOf(R2), base, 'kfp: RENAMING the project does not move the fingerprint — in-tree paths are hashed RELATIVE to the root');
  renameSync(R2, R);

  // JSON-ENCODED COMPONENTS. A naive `path + <sep> + scopeRoot` join lets a path forge a
  // field boundary, so two genuinely different sets hash the same — the exact hole Phase 2
  // closed for compartment names.
  const f1 = fpOf('/r', { specsOf: () => [{ spec: '/x|y', scopeRoot: '/z', digest: 'd' }] });
  const f2 = fpOf('/r', { specsOf: () => [{ spec: '/x', scopeRoot: 'y|/z', digest: 'd' }] });
  ok(f1 !== f2, 'kfp: components are JSON-encoded — no path can forge a field boundary');
  ok(fpOf('/r', { specsOf: () => [{ spec: '/x', scopeRoot: '', digest: 'd' }] })
     !== fpOf('/r', { specsOf: () => [{ spec: '/x', scopeRoot: null, digest: 'd' }] }),
  'kfp: …and a scopeRoot of "" (the root itself) stays distinct from null (unscoped)');

  // A `--contracts <dir>` override stamps WHAT IT ACTUALLY USED, and records the override's
  // IDENTITY. /A and /B used to hash identically (both merely "unscoped"), so a CI job that
  // switched override dirs left the next incremental re-deriving over the other one's rows.
  const A = join(work, 'A'), B = join(work, 'B');
  mkdirSync(A, { recursive: true }); mkdirSync(B, { recursive: true });
  writeFileSync(join(A, 'a.asyncapi.yaml'), specOf('Override A', '/a'));
  writeFileSync(join(B, 'b.asyncapi.yaml'), specOf('Override B', '/b'));
  ok(fpOf(R, { contracts: A }) !== fpOf(R, { contracts: B }),
    'kfp: --contracts /A and --contracts /B hash DIFFERENTLY — the override records what it actually used');
  ok(fpOf(R, { contracts: A }) !== base,
    'kfp: …and neither equals the set discovery resolves, so the next ordinary build escalates');
  const emptyA = join(work, 'emptyA'), emptyB = join(work, 'emptyB');
  mkdirSync(emptyA, { recursive: true }); mkdirSync(emptyB, { recursive: true });
  ok(fpOf(R, { contracts: emptyA }) !== fpOf(R, { contracts: emptyB }),
    'kfp: …and two EMPTY override dirs still differ — the override\'s identity is recorded, not only its specs');

  // The stamp MERGES, like reposLastSha and compartmentsFingerprint: a member excluded from
  // this build keeps its baseline instead of silently losing it.
  const proj = join(work, 'p');
  mkdirSync(join(proj, '.wiregraph'), { recursive: true });
  writeFileSync(join(proj, '.wiregraph', 'state.json'), JSON.stringify({ project: proj, links: [], contractsFingerprint: { '/absent/member': 'k2:keepme' } }));
  const stamped = S.stampContractsFingerprint(proj, [proj]);
  eq(stamped['/absent/member'], 'k2:keepme', 'kfp: stamping MERGES — an unmounted member keeps its baseline');
  ok(Object.keys(stamped).includes('.'), 'kfp: …while this build\'s roots are (re)stamped, under the project-relative key');

  // THERE IS NO 'global' CONSTANT any more. It exempted the DEFAULT mode from the entire
  // guard, and its seven assertions only ever asserted that the constant was the constant.
  eq(S.GLOBAL_CONTRACTS_FINGERPRINT, undefined,
    'kfp: the all-unscoped CONSTANT is gone — global mode is the default, and "no scope to narrow" never implied "no staleness to detect"');

  rmSync(work, { recursive: true, force: true });
}

// K1 TRIGGER 1 — MOVING A CONTRACTS DIR INWARD.
// `<root>/contracts/` (title "Nested Outer Wire", scope = the whole tree) becomes
// `<root>/harness/contracts/` (scope = harness/). Same contract id, strictly SMALLER scope.
// Every build runs in its OWN PROCESS, exactly as the hook runs them — a one-build-per
// -process harness is the only way to see this, because the module-level discovery memo
// used to hide it and because the defect is about what the PREVIOUS process persisted.
async function contractsDirMoveTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = mkdtempSync(join(tmpdir(), 'cg-kmove-'));
  const root = nestedProject(work);
  const db = join(work, 'graph.db');
  const build = (args) => execFileP(process.execPath, [BUILD, root, '--project', root, '--db', db, ...args]);
  const wireSet = (path) => {
    const c = connect(path, { readonly: true });
    const rows = c.prepare("SELECT contract, token, src, dst FROM edges WHERE project=? AND type='WIRE' ORDER BY contract, token, src, dst").all(root);
    const comps = c.prepare("SELECT DISTINCT c.name cn, s.compartment comp FROM edges e JOIN symbols s ON s.id=e.src JOIN contracts c ON c.id=e.dst WHERE e.project=? AND e.type='REFERENCES' ORDER BY cn, comp").all(root);
    c.close();
    return { wire: rows.map((r) => `${r.contract}|${r.token}`), refs: comps.map((r) => `${r.cn}|${r.comp}`) };
  };

  await build([]);
  const before = wireSet(db);
  ok(before.refs.includes('Nested Outer Wire|netsrv'),
    'kmove: baseline — the OUTER contract governs the whole tree, so netsrv references it');

  // THE MOVE. Same title, same id, strictly narrower scope.
  renameSync(join(root, 'contracts'), join(root, 'harness', 'contracts'));
  const edited = join(root, 'harness', 'harness.js');
  appendFileSync(edited, '\nexport function harnessTail() { return 2; }\n');

  // 1. The incremental REFUSES, and refuses BEFORE touching the db.
  let err = null;
  try { await build(['--files', edited]); } catch (e) { err = e; }
  ok(err, 'kmove: the incremental after the move FAILS instead of silently re-deriving');
  has(err?.stderr || '', 'contract specs in force changed since the last full build',
    'kmove: …and says exactly why');
  eq(JSON.stringify(wireSet(db)), JSON.stringify(before),
    'kmove: …and the db is untouched — the refusal is ahead of every mutation');

  // 2. THE DEFECT ITSELF, observed. Drop the stamp (which is also the LEGACY case: a
  //    project last built before this key existed must NOT be refused), so the incremental
  //    proceeds exactly as it did before this guard, and watch it fabricate a seam.
  S.updateState(root, { contractsFingerprint: null });
  await build(['--files', edited]);
  const afterStale = wireSet(db);
  ok(afterStale.wire.includes('Nested Outer Wire|/harness/probe'),
    'kmove: WITHOUT a baseline the incremental proceeds (absent is never read as changed) — and re-derives the outer seam from rows minted under the WIDER scope');
  ok(afterStale.refs.includes('Nested Outer Wire|netsrv'),
    'kmove: …and netsrv\'s stale REFERENCES rows survive, which trace_contract reports as real');

  // 3. …and a FULL rebuild of the same tree produces NEITHER. That difference is the
  //    cross-scope group the design says to stop for, and the stamp is what stops it.
  const db2 = join(work, 'full2.db');
  await execFileP(process.execPath, [BUILD, root, '--project', root, '--db', db2]);
  const full = wireSet(db2);
  ok(!full.wire.includes('Nested Outer Wire|/harness/probe'),
    'kmove: a FULL rebuild produces no such seam — the outer contract now governs harness/ only, where there is no consumer');
  ok(!full.refs.includes('Nested Outer Wire|netsrv'),
    'kmove: …and netsrv is outside its scope entirely, so it references it not at all');

  // 4. The restamp closes the loop: after the full rebuild the next incremental is cheap
  //    again rather than refusing forever.
  const st = S.readState(root);
  eq(S.contractsDrift(st.contractsFingerprint, S.contractsFingerprint([root])), null,
    'kmove: the full rebuild RESTAMPED the new set, so the project does not wedge');

  rmSync(work, { recursive: true, force: true });
}

// K1 TRIGGER 2 — `--contracts <dir>` (UNSCOPED by definition) then an ordinary incremental
// (SCOPED). The override's rows were minted matching everything; the next save resolves the
// nested dirs and re-derives over them. Own process per build.
async function contractsOverrideThenIncrementalTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = mkdtempSync(join(tmpdir(), 'cg-kover-'));
  const root = nestedProject(work);
  const db = join(work, 'graph.db');
  const build = (args) => execFileP(process.execPath, [BUILD, root, '--project', root, '--db', db, ...args]);

  await build(['--contracts', join(root, 'client', 'contracts')]);
  const overrideStamp = S.readState(root).contractsFingerprint['.'];
  ok(overrideStamp && overrideStamp !== S.contractsFingerprint([root])['.'],
    'kover: a --contracts build stamps the reality it ACTUALLY used, which is not what discovery resolves');
  const conn = connect(db, { readonly: true });
  const netsrvSaw = conn.prepare("SELECT count(*) n FROM edges e JOIN symbols s ON s.id=e.src WHERE e.project=? AND e.type='REFERENCES' AND s.compartment='netsrv'").get(root).n;
  conn.close();
  ok(netsrvSaw > 0, 'kover: …and it really did mint UNSCOPED rows — netsrv matched a client-dir token');

  const edited = join(root, 'server', 'netsrv', 'net.js');
  appendFileSync(edited, '\nexport function tail() { return 3; }\n');
  let err = null;
  try { await build(['--files', edited]); } catch (e) { err = e; }
  ok(err, 'kover: the next ORDINARY incremental refuses — its scoped dirs are not the set that minted those rows');
  has(err?.stderr || '', 'contract specs in force changed since the last full build', 'kover: …and says so');

  // An ordinary full build restamps the scoped set, and then the incremental is fine.
  await build([]);
  await build(['--files', edited]);
  ok(true, 'kover: after an ordinary full rebuild the incremental proceeds again');
  ok(S.readState(root).contractsFingerprint['.'] !== overrideStamp,
    'kover: …because the ordinary build stamped the DISCOVERED set, which is a different value from the override\'s');

  rmSync(work, { recursive: true, force: true });
}

// K1's third case, the ADD GAP. `/wiregraph-contracts apply` creates contracts/, stamps
// state, and tells the user to run the incremental — which used to index nothing while the
// nudge went silent (contractsDirs non-empty) and the Mode: line claimed the contract was
// scoped and governing. Self-heal time was NEVER. The fingerprint gives it one.
async function contractsAddGapTest() {
  const S = await import('../scripts/lib/state.mjs');
  const G = await import('../scripts/lib/git.mjs');
  const work = mkdtempSync(join(tmpdir(), 'cg-kadd-'));
  const root = nestedProject(work);
  for (const d of ['contracts', 'server/contracts', 'client/contracts']) rmSync(join(root, d), { recursive: true, force: true });
  const db = join(work, 'graph.db');
  const build = (args) => execFileP(process.execPath, [BUILD, root, '--project', root, '--db', db, ...args]);

  await build([]);
  let conn = connect(db, { readonly: true });
  eq(conn.prepare('SELECT count(*) n FROM contracts WHERE project=?').get(root).n, 0, 'kadd: baseline has no contracts at all');
  conn.close();
  const emptyStamp = S.readState(root).contractsFingerprint['.'];
  ok(emptyStamp && emptyStamp.startsWith('k2:'),
    'kadd: …and "no contracts dirs" still stamps a real value, so the first spec that appears is detectable');

  // What `apply` does: create the dir, write the spec, record it in state. It does NOT
  // rebuild, and it does NOT stamp the fingerprint — which is exactly what makes the next
  // incremental escalate instead of indexing nothing.
  mkdirSync(join(root, 'contracts'), { recursive: true });
  writeFileSync(join(root, 'contracts', 'wiregraph-inferred.asyncapi.yaml'),
    'asyncapi: 3.0.0\ninfo: { title: Applied Draft, version: 1.0.0 }\nchannels:\n'
    + '  p: { address: /harness/probe, x-wiregraph-producers: [harness], x-wiregraph-consumers: [netsrv] }\n');
  S.updateState(root, { contractsDir: join(root, 'contracts'), contractsDirs: [join(root, 'contracts')] });

  const edited = join(root, 'harness', 'harness.js');
  let err = null;
  try { await build(['--files', edited]); } catch (e) { err = e; }
  ok(err, 'kadd: the incremental `apply` tells the user to run now REFUSES rather than indexing nothing');
  has(err?.stderr || '', 'contract specs in force changed since the last full build', 'kadd: …and names the cause');

  // The SessionStart catch-up escalates on the same signal, so it self-heals unattended.
  const c = G.changedSince(root, S.readState(root).reposLastSha || {});
  ok(c.fullBuildNeeded && c.fullBuildReasons.some((r) => r.includes('contract specs changed')),
    'kadd: changedSince escalates the auto-catch-up to a full rebuild — the self-heal time is now "next hook run", not never');

  await build([]);
  conn = connect(db, { readonly: true });
  eq(conn.prepare('SELECT count(*) n FROM contracts WHERE project=?').get(root).n, 1, 'kadd: …and the rebuild finally indexes the applied spec');
  ok(conn.prepare("SELECT count(*) n FROM edges WHERE project=? AND type='WIRE'").get(root).n > 0, 'kadd: …seam and all');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// H1(a) — A SPEC MOVED BETWEEN TWO CONTRACTS DIRS THAT BOTH ALREADY EXIST.
// The sequence a DIR-set fingerprint cannot see at all. `<root>/contracts/` and
// `<root>/harness/contracts/` both exist and both hold a spec throughout; moving
// outer.asyncapi.yaml from the first into the second narrows "Nested Outer Wire" from the
// whole tree to `harness/` while the dir list stays byte-identical. Hashing the dirs
// therefore produced an IDENTICAL value, contractsDrift returned null, the incremental
// proceeded, and one save fabricated §13's cross-scope WIRE edge exactly.
// Own process per build, as the hook runs them.
async function contractsSpecMoveTest() {
  const S = await import('../scripts/lib/state.mjs');
  const { rootContractsEntries } = await import('../src/contracts-dirs.js');
  const work = mkdtempSync(join(tmpdir(), 'cg-hmove-'));
  const root = nestedProject(work);
  const db = join(work, 'graph.db');
  const build = (args) => execFileP(process.execPath, [BUILD, root, '--project', root, '--db', db, ...args]);
  const wireSet = (path) => {
    const c = connect(path, { readonly: true });
    const wire = c.prepare("SELECT contract, token FROM edges WHERE project=? AND type='WIRE' ORDER BY contract, token").all(root);
    const refs = c.prepare("SELECT DISTINCT c.name cn, s.compartment comp FROM edges e JOIN symbols s ON s.id=e.src JOIN contracts c ON c.id=e.dst WHERE e.project=? AND e.type='REFERENCES' ORDER BY cn, comp").all(root);
    c.close();
    return { wire: wire.map((r) => `${r.contract}|${r.token}`), refs: refs.map((r) => `${r.cn}|${r.comp}`) };
  };
  const dirList = () => JSON.stringify(rootContractsEntries(root, true).map((e) => relative(root, e.dir)).sort());

  // harness/contracts/ EXISTS AND IS POPULATED before the move and after it. That is what
  // makes the dir set immune to the change.
  mkdirSync(join(root, 'harness', 'contracts'), { recursive: true });
  writeFileSync(join(root, 'harness', 'contracts', 'h.asyncapi.yaml'),
    'asyncapi: 3.0.0\ninfo: { title: Harness Local Wire, version: 1.0.0 }\nchannels:\n  h: { address: /harness/local }\n');

  await build([]);
  const before = wireSet(db);
  const dirsBefore = dirList();
  const stampBefore = S.readState(root).contractsFingerprint['.'];
  ok(before.refs.includes('Nested Outer Wire|netsrv'),
    'hmove: baseline — the OUTER contract governs the whole tree, so netsrv references it');

  // THE MOVE. Both dirs still exist, both still hold specs.
  renameSync(join(root, 'contracts', 'outer.asyncapi.yaml'), join(root, 'harness', 'contracts', 'outer.asyncapi.yaml'));
  eq(dirList(), dirsBefore,
    'hmove: the DIR SET is byte-identical across the move — this is precisely what a dir-set hash cannot see');
  ok(S.contractsFingerprint([root])['.'] !== stampBefore,
    'hmove: …but the SPEC set moved, so the fingerprint moved');

  const edited = join(root, 'harness', 'harness.js');
  appendFileSync(edited, '\nexport function harnessTail() { return 2; }\n');

  // 1. The incremental REFUSES, ahead of every mutation.
  let err = null;
  try { await build(['--files', edited]); } catch (e) { err = e; }
  ok(err, 'hmove: the incremental after the move FAILS instead of silently re-deriving');
  has(err?.stderr || '', 'contract specs in force changed since the last full build', 'hmove: …and says exactly why');
  eq(JSON.stringify(wireSet(db)), JSON.stringify(before), 'hmove: …and the db is untouched');

  // 2. THE DEFECT ITSELF. Drop the stamp so the incremental proceeds exactly as it did
  //    while the fingerprint hashed dirs, and watch it fabricate the seam.
  S.updateState(root, { contractsFingerprint: null });
  await build(['--files', edited]);
  const afterStale = wireSet(db);
  ok(afterStale.wire.includes('Nested Outer Wire|/harness/probe'),
    'hmove: WITHOUT a baseline the incremental proceeds and re-derives the outer seam from rows minted under the WIDER scope');
  ok(afterStale.refs.includes('Nested Outer Wire|netsrv'),
    'hmove: …and netsrv\'s stale REFERENCES rows survive, which trace_contract reports as real');

  // 3. …and a FULL rebuild of the same tree produces NEITHER.
  const db2 = join(work, 'full2.db');
  await execFileP(process.execPath, [BUILD, root, '--project', root, '--db', db2]);
  const full = wireSet(db2);
  ok(!full.wire.includes('Nested Outer Wire|/harness/probe'),
    'hmove: a FULL rebuild produces no such seam — the outer contract now governs harness/ only, where there is no consumer');
  ok(!full.refs.includes('Nested Outer Wire|netsrv'),
    'hmove: …and netsrv is outside its scope entirely');

  // 4. The restamp closes the loop.
  eq(S.contractsDrift(S.readState(root).contractsFingerprint, S.contractsFingerprint([root])), null,
    'hmove: the full rebuild RESTAMPED, so the project does not wedge');

  rmSync(work, { recursive: true, force: true });
}

// H1(b) — A SPEC'S info.title EDITED. Same file, same dir, same dir set; a different
// contractId. The old id's REFERENCES rows are orphaned in the db and the renamed contract
// never gets its WIRE edge, because an incremental re-derives over both. NOT exotic:
// retitling is the remedy enforceDistinctTitlePerScope steers users toward on a collision,
// so the tool actively creates this path. Own process per build.
async function contractsTitleEditTest() {
  const S = await import('../scripts/lib/state.mjs');
  const { rootContractsEntries } = await import('../src/contracts-dirs.js');
  const work = mkdtempSync(join(tmpdir(), 'cg-htitle-'));
  const root = nestedProject(work);
  const db = join(work, 'graph.db');
  const spec = join(root, 'server', 'contracts', 'inner.asyncapi.yaml');
  const build = (args) => execFileP(process.execPath, [BUILD, root, '--project', root, '--db', db, ...args]);
  const names = (path) => {
    const c = connect(path, { readonly: true });
    const contracts = c.prepare('SELECT name FROM contracts WHERE project=? ORDER BY name').all(root).map((r) => r.name);
    const wire = c.prepare("SELECT DISTINCT contract FROM edges WHERE project=? AND type='WIRE' ORDER BY contract").all(root).map((r) => r.contract);
    const refs = c.prepare("SELECT DISTINCT c.name cn FROM edges e JOIN contracts c ON c.id=e.dst WHERE e.project=? AND e.type='REFERENCES' ORDER BY cn").all(root).map((r) => r.cn);
    c.close();
    return { contracts, wire, refs };
  };
  const dirList = () => JSON.stringify(rootContractsEntries(root, true).map((e) => relative(root, e.dir)).sort());

  await build([]);
  const before = names(db);
  const dirsBefore = dirList();
  ok(before.wire.includes('Server Inner Wire'), 'htitle: baseline — the inner contract has a WIRE edge under its original title');

  // THE RETITLE. One line of one file.
  writeFileSync(spec, readFileSync(spec, 'utf8').replace('title: Server Inner Wire', 'title: Server Inner Renamed'));
  eq(dirList(), dirsBefore, 'htitle: the DIR SET is byte-identical — a retitle is invisible to it');

  const edited = join(root, 'server', 'sim', 'sim.js');
  appendFileSync(edited, '\nexport function simTail() { return 4; }\n');

  let err = null;
  try { await build(['--files', edited]); } catch (e) { err = e; }
  ok(err, 'htitle: the incremental after a retitle REFUSES');
  has(err?.stderr || '', 'contract specs in force changed since the last full build', 'htitle: …and names the cause');

  // THE DEFECT ITSELF, with the guard disabled.
  S.updateState(root, { contractsFingerprint: null });
  await build(['--files', edited]);
  const stale = names(db);
  ok(stale.contracts.includes('Server Inner Wire') && stale.refs.includes('Server Inner Wire'),
    'htitle: WITHOUT a baseline the incremental keeps a GHOST contract under the OLD title, with its REFERENCES rows');
  ok(!stale.wire.includes('Server Inner Renamed'),
    'htitle: …and never mints the renamed contract\'s WIRE edge');

  const db2 = join(work, 'full2.db');
  await execFileP(process.execPath, [BUILD, root, '--project', root, '--db', db2]);
  const full = names(db2);
  ok(!full.contracts.includes('Server Inner Wire'), 'htitle: a FULL rebuild holds only the renamed contract — no ghost');
  ok(full.wire.includes('Server Inner Renamed'), 'htitle: …and it does have the renamed contract\'s WIRE edge');

  rmSync(work, { recursive: true, force: true });
}

// H2 — GLOBAL MODE IS NOT EXEMPT. Every sequence below was observed with the fingerprint's
// all-unscoped CONSTANT in place: global mode is the DEFAULT, and it is the mode
// contractsHome() (deliberately depth-1) makes `/wiregraph-contracts apply` write into, so
// the exemption covered exactly the common case. Own process per build.
async function globalContractsStalenessTest() {
  const S = await import('../scripts/lib/state.mjs');
  const G = await import('../scripts/lib/git.mjs');
  const work = mkdtempSync(join(tmpdir(), 'cg-hglobal-'));
  const root = nestedProject(work, { recursive: false });
  const db = join(work, 'graph.db');
  const build = (args) => execFileP(process.execPath, [BUILD, root, '--project', root, '--db', db, ...args]);
  const snap = (path) => {
    const c = connect(path, { readonly: true });
    const contracts = c.prepare('SELECT name FROM contracts WHERE project=? ORDER BY name').all(root).map((r) => r.name);
    const wire = c.prepare("SELECT contract, token FROM edges WHERE project=? AND type='WIRE' ORDER BY contract, token").all(root).map((r) => `${r.contract}|${r.token}`);
    const nrefs = c.prepare("SELECT count(*) n FROM edges WHERE project=? AND type='REFERENCES'").get(root).n;
    c.close();
    return { contracts, wire, nrefs };
  };
  const edited = join(root, 'harness', 'harness.js');

  // --- (1) DELETE the contracts dir -----------------------------------------
  await build([]);
  const base = snap(db);
  ok(base.wire.length > 0, 'hglobal: baseline — the depth-1 contract has a live WIRE edge');
  ok(String(S.readState(root).contractsFingerprint['.']).startsWith('k2:'),
    'hglobal: …and a global-mode root stamps a real fingerprint, not a constant exemption');

  rmSync(join(root, 'contracts'), { recursive: true, force: true });
  appendFileSync(edited, '\nexport function h1() { return 1; }\n');
  let err = null;
  try { await build(['--files', edited]); } catch (e) { err = e; }
  ok(err, 'hglobal: deleting the contracts dir REFUSES the next incremental — in global mode too');
  has(err?.stderr || '', 'contract specs in force changed since the last full build', 'hglobal: …and names the cause');

  // THE GHOST, with the guard disabled: the contract node, its REFERENCES and a live WIRE
  // edge all survive for a spec that is no longer on disk, and trace_contract calls it real.
  S.updateState(root, { contractsFingerprint: null });
  await build(['--files', edited]);
  const ghost = snap(db);
  ok(ghost.contracts.includes('Nested Outer Wire') && ghost.wire.length > 0 && ghost.nrefs > 0,
    'hglobal: WITHOUT the guard the incremental keeps a GHOST contract, its REFERENCES and a live WIRE edge for a deleted spec');
  const gconn = connect(db, { readonly: true });
  has(Q.traceContract(gconn, root, 'Nested Outer Wire', null, false), 'Nested Outer Wire',
    'hglobal: …and trace_contract reports the ghost as real');
  gconn.close();
  const dbFull = join(work, 'full.db');
  await execFileP(process.execPath, [BUILD, root, '--project', root, '--db', dbFull]);
  eq(snap(dbFull).contracts.length, 0, 'hglobal: …while a FULL rebuild holds no contract at all');

  // --- (2) `--contracts <dir>` then an ORDINARY incremental -------------------
  const work2 = mkdtempSync(join(tmpdir(), 'cg-hglobal2-'));
  const root2 = nestedProject(work2, { recursive: false });
  const db2 = join(work2, 'graph.db');
  const build2 = (args) => execFileP(process.execPath, [BUILD, root2, '--project', root2, '--db', db2, ...args]);
  await build2(['--contracts', join(root2, 'server', 'contracts')]);
  const overrideSnap = (() => { const c = connect(db2, { readonly: true }); const r = c.prepare('SELECT name FROM contracts WHERE project=?').all(root2).map((x) => x.name); c.close(); return r; })();
  eq(JSON.stringify(overrideSnap), JSON.stringify(['Server Inner Wire']),
    'hglobal: the override build holds the OVERRIDE dir\'s contract, which discovery would never find at depth 1');
  let err2 = null;
  try { await build2(['--files', join(root2, 'harness', 'harness.js')]); } catch (e) { err2 = e; }
  ok(err2, 'hglobal: the next ORDINARY incremental refuses — the override\'s rows are not the set discovery resolves');
  has(err2?.stderr || '', 'contract specs in force changed since the last full build', 'hglobal: …and says so');

  // --- (3) THE `apply` ADD GAP -----------------------------------------------
  const work3 = mkdtempSync(join(tmpdir(), 'cg-hglobal3-'));
  const root3 = nestedProject(work3, { recursive: false });
  rmSync(join(root3, 'contracts'), { recursive: true, force: true });
  const db3 = join(work3, 'graph.db');
  const build3 = (args) => execFileP(process.execPath, [BUILD, root3, '--project', root3, '--db', db3, ...args]);
  await build3([]);
  // Exactly what `apply` does: create the dir, write the spec, record it in state. It does
  // not rebuild and it does not stamp the fingerprint.
  mkdirSync(join(root3, 'contracts'), { recursive: true });
  writeFileSync(join(root3, 'contracts', 'wiregraph-inferred.asyncapi.yaml'),
    'asyncapi: 3.0.0\ninfo: { title: Applied Global Draft, version: 1.0.0 }\nchannels:\n'
    + '  p: { address: /harness/probe, x-wiregraph-producers: [harness], x-wiregraph-consumers: [netsrv] }\n');
  S.updateState(root3, { contractsDir: join(root3, 'contracts'), contractsDirs: [join(root3, 'contracts')] });
  let err3 = null;
  try { await build3(['--files', join(root3, 'harness', 'harness.js')]); } catch (e) { err3 = e; }
  ok(err3, 'hglobal: the ADD GAP is closed in global mode — the incremental `apply` prescribes now REFUSES instead of indexing nothing');
  const c3 = G.changedSince(root3, S.readState(root3).reposLastSha || {});
  ok(c3.fullBuildNeeded && c3.fullBuildReasons.some((r) => r.includes('contract specs changed')),
    'hglobal: …and the SessionStart catch-up escalates, so the self-heal time is "next hook run" rather than never');
  await build3([]);
  const c3conn = connect(db3, { readonly: true });
  eq(c3conn.prepare('SELECT count(*) n FROM contracts WHERE project=?').get(root3).n, 1, 'hglobal: …and the rebuild indexes the applied spec');
  ok(c3conn.prepare("SELECT count(*) n FROM edges WHERE project=? AND type='WIRE'").get(root3).n > 0, 'hglobal: …seam and all');
  c3conn.close();

  rmSync(work, { recursive: true, force: true });
  rmSync(work2, { recursive: true, force: true });
  rmSync(work3, { recursive: true, force: true });
}

// H3 — LEGACY IS NOT FORCE-REBUILT. A project built before this key existed has NO stamp;
// absent means "no baseline", never "changed", so neither the post-edit refusal nor the
// SessionStart escalation may fire for it. This is the property that made it safe to drop
// the 'global' constant, and it is asserted rather than assumed.
async function legacyNoContractsStampTest() {
  const S = await import('../scripts/lib/state.mjs');
  const G = await import('../scripts/lib/git.mjs');
  const work = mkdtempSync(join(tmpdir(), 'cg-hlegacy-'));
  const root = nestedProject(work, { recursive: false });
  const db = join(work, 'graph.db');
  const build = (args) => execFileP(process.execPath, [BUILD, root, '--project', root, '--db', db, ...args]);

  await build([]);
  // Make it a PRE-FIX state file: the key simply does not exist, which is what a project
  // last built by a wiregraph without this feature has on disk.
  const st = S.readState(root);
  delete st.contractsFingerprint;
  writeFileSync(join(root, '.wiregraph', 'state.json'), JSON.stringify(st, null, 2));
  ok(!('contractsFingerprint' in JSON.parse(readFileSync(join(root, '.wiregraph', 'state.json'), 'utf8'))),
    'hlegacy: the state file really has no contracts stamp at all');

  const edited = join(root, 'harness', 'harness.js');
  appendFileSync(edited, '\nexport function legacyTail() { return 9; }\n');
  let err = null;
  try { await build(['--files', edited]); } catch (e) { err = e; }
  eq(err, null, 'hlegacy: an incremental on a stamp-less project is NOT refused — absent is no baseline, never a change');
  const c = G.changedSince(root, S.readState(root).reposLastSha || {});
  ok(!(c.fullBuildReasons || []).some((r) => r.includes('contract specs changed')),
    'hlegacy: …and the SessionStart catch-up does not escalate it either');

  // The first stamp lands on its next FULL build, and the guard is live from then on.
  await build([]);
  ok(S.readState(root).contractsFingerprint['.'],
    'hlegacy: the upgrade path is "next full build stamps it" — no forced rebuild, no wedge');

  rmSync(work, { recursive: true, force: true });
}

// H4 — THE HOOK HEAL. This is the half of the guard with no coverage at all: deleting the
// two lines in refresh.mjs that add `contract specs changed` to healPartitionDrift passed
// the whole suite. Without them the project wedges SILENTLY on every save — exit 0, empty
// stdout, one `ERROR:` line in refresh.log, no index update, forever, and with posture
// `off` the SessionStart catch-up that would normally escalate never runs at all. It is
// also the only half that converts a REFUSAL into a VISIBLE REMEDY.
async function contractsHookHealTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = mkdtempSync(join(tmpdir(), 'cg-hhook-'));
  const root = nestedProject(work);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
  const dbPath = join(root, '.wiregraph', 'graph.db');
  const contractNames = () => {
    const c = connect(dbPath, { readonly: true });
    try { return c.prepare('SELECT name FROM contracts WHERE project=? ORDER BY name').all(root).map((r) => r.name); }
    finally { c.close(); }
  };

  await execFileP(process.execPath, [REFRESH, '--full'], { env });
  const firstBuild = S.readState(root).lastFullBuild;
  ok(firstBuild, 'hhook: the baseline full build landed');
  ok(contractNames().includes('Server Inner Wire'), 'hhook: …with the inner contract indexed under its original title');

  // Retitle one spec — the exact change H1(b) proves an incremental cannot survive.
  const spec = join(root, 'server', 'contracts', 'inner.asyncapi.yaml');
  writeFileSync(spec, readFileSync(spec, 'utf8').replace('title: Server Inner Wire', 'title: Server Inner Renamed'));

  const edited = join(root, 'server', 'sim', 'sim.js');
  appendFileSync(edited, '\nexport function simTail() { return 5; }\n');
  const r = await execFileP(process.execPath, [REFRESH, '--files', edited], { env });
  eq((r.stdout || '').trim(), '', 'hhook: the hook is silent on stdout either way — which is why a wedge here is invisible');

  const log = readFileSync(join(root, '.wiregraph', 'refresh.log'), 'utf8');
  has(log, 'escalating to full rebuild (contract specs changed', 'hhook: the post-edit refresh LOGS the escalation instead of writing one ERROR line and exiting 0');
  has(log, 'full rebuild complete (contract specs changed)', 'hhook: …and completes it');
  ok(!log.includes('ERROR:'), 'hhook: …and the refusal never reaches main().catch, where it would have been swallowed into the log and forgotten');

  ok(S.readState(root).lastFullBuild !== firstBuild,
    'hhook: lastFullBuild advanced — the project self-heals rather than wedging until a manual /wiregraph-rebuild');
  const after = contractNames();
  ok(after.includes('Server Inner Renamed') && !after.includes('Server Inner Wire'),
    'hhook: …and the graph actually reflects the retitled spec, with no ghost left behind');
  eq(S.contractsDrift(S.readState(root).contractsFingerprint, S.contractsFingerprint([root])), null,
    'hhook: the rebuild restamped, so the next save is cheap again instead of rebuilding on every edit');

  // Steady state: nothing changed, so the next save is an ordinary incremental, not another
  // rebuild. A gate that escalated forever would be its own wedge.
  const second = S.readState(root).lastFullBuild;
  appendFileSync(edited, '\nexport function simTail2() { return 6; }\n');
  await execFileP(process.execPath, [REFRESH, '--files', edited], { env });
  eq(S.readState(root).lastFullBuild, second, 'hhook: …and the save after that does NOT rebuild — the gate fires on change, not on every edit');

  rmSync(work, { recursive: true, force: true });
}

// K2 — THE IN-PROCESS DISCOVERY MEMO. `_discoCache`/`_modeCache` were module-level Maps
// keyed by root alone, never invalidated, process-lifetime — and the MCP server is exactly
// that long-lived process (runBuild({reset:true}) is what /wiregraph-rebuild prefers). No
// pre-existing test could catch it: every one of them is a fresh runBuild over a fresh
// tmpdir. This one does TWO builds in ONE process with the tree changing between them.
async function sameProcessDiscoveryTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = mkdtempSync(join(tmpdir(), 'cg-kmemo-'));
  const root = realpathSync(work);
  mkdirSync(join(root, 'a'), { recursive: true });
  writeFileSync(join(root, 'a', 'a.js'), "export function ping() { return '/memo/route'; }\n");
  mkdirSync(join(root, 'b'), { recursive: true });
  writeFileSync(join(root, 'b', 'b.js'), "export function pong() { return '/memo/route'; }\n");
  const db = join(work, 'graph.db');

  // Build 1: no contracts dir anywhere.
  await runBuild({ target: root, project: root, db, reset: true });
  let conn = connect(db, { readonly: true });
  eq(conn.prepare('SELECT count(*) n FROM contracts WHERE project=?').get(root).n, 0, 'kmemo: build 1 finds no contracts');
  conn.close();
  eq(S.readState(root).contractsDir, null, 'kmemo: …and records none');

  // …then `/wiregraph-contracts apply` creates one, IN THE SAME PROCESS.
  mkdirSync(join(root, 'contracts'), { recursive: true });
  writeFileSync(join(root, 'contracts', 'x.asyncapi.yaml'),
    'asyncapi: 3.0.0\ninfo: { title: Memo Probe, version: 1.0.0 }\nchannels:\n  r: { address: /memo/route }\n');

  // Build 2, same process. The memo made this still report zero contracts, a null
  // contractsDir and a forever-firing SessionStart nudge — while the comments claimed a
  // full build "always walks live".
  await runBuild({ target: root, project: root, db, reset: true });
  conn = connect(db, { readonly: true });
  eq(conn.prepare('SELECT count(*) n FROM contracts WHERE project=?').get(root).n, 1,
    'kmemo: a second build IN THE SAME PROCESS sees a contracts dir created between the two');
  ok(conn.prepare("SELECT count(*) n FROM edges WHERE project=? AND type='REFERENCES'").get(root).n > 0,
    'kmemo: …and actually matches it');
  conn.close();
  eq(S.readState(root).contractsDir, join(root, 'contracts'),
    'kmemo: …and records it, so the nudge stops firing and the Mode: line stops lying');

  // The MODE memo has the same shape and the same fix: mode is re-read per build.
  writeFileSync(join(root, '.wiregraph', 'state.json'), JSON.stringify({
    ...S.readState(root), mode: 'recursive',
    compartments: [{ path: 'a', name: 'a' }, { path: 'b', name: 'b' }],
  }, null, 2));
  mkdirSync(join(root, 'a', 'contracts'), { recursive: true });
  writeFileSync(join(root, 'a', 'contracts', 'inner.asyncapi.yaml'),
    'asyncapi: 3.0.0\ninfo: { title: Memo Inner, version: 1.0.0 }\nchannels:\n  r: { address: /memo/inner }\n');
  await runBuild({ target: root, project: root, db, reset: true });
  conn = connect(db, { readonly: true });
  eq(conn.prepare('SELECT count(*) n FROM contracts WHERE project=?').get(root).n, 2,
    'kmemo: flipping the MODE in the same process is picked up too — recursive discovery finds the nested dir');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// K3 — A MERGED SCOPED+UNSCOPED CONTRACT KEEPS ITS UNSCOPED-NESS.
// scopeDepthFor collapsed a null scope root to 0 and then max()ed it away, so a contract
// merged from `contracts/` (scope = root) AND `.wiregraph/inferred/` (null) behaved as if
// it were scoped to the root — and was DISPLACED by `client/contracts/` for files under
// client/. The existing unscoped test uses a DISTINCT title, so it never merges and never
// touches this path.
async function mergedUnscopedStaysUnscopedTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-kmerge-'));
  const root = nestedProject(work);

  // The link-inferred spec, sharing the OUTER contract's title on purpose — the routine
  // apply+link collision mergeContracts and enforceDistinctTitlePerScope both PERMIT.
  mkdirSync(join(root, '.wiregraph', 'inferred'), { recursive: true });
  writeFileSync(join(root, '.wiregraph', 'inferred', 'wiregraph-inferred.asyncapi.yaml'),
    'asyncapi: 3.0.0\ninfo: { title: Nested Outer Wire, version: 1.0.0 }\nchannels:\n'
    + '  f: { address: /ui/frame, x-wiregraph-producers: [world_state], x-wiregraph-consumers: [netsrv] }\n');

  const db = join(work, 'graph.db');
  await runBuild({ target: root, project: root, db, reset: true });
  const conn = connect(db, { readonly: true });
  const m = refMap(conn, root);

  eq(refsFor(m, 'Nested Outer Wire|/ui/frame'), JSON.stringify(['netcli', 'netsrv', 'world_state']),
    'kmerge: a contract merged with an UNSCOPED spec applies EVERYWHERE — it is not displaced under client/ by client/contracts/');
  ok(conn.prepare("SELECT count(*) n FROM edges WHERE project=? AND type='WIRE' AND contract='Nested Outer Wire' AND token='/ui/frame'").get(root).n > 0,
    'kmerge: …so the declared world_state -> netsrv link seam LIGHTS UP instead of going dark');
  // …and it did not WIDEN the genuinely scoped contract that shares the token.
  eq(refsFor(m, 'Client Inner Wire|/ui/frame'), JSON.stringify(['netcli', 'world_state']),
    'kmerge: …while the scoped sibling still governs only its own subtree');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// H4 — A ROOT THAT IS ITSELF A CONTRACTS HOME must be UNSCOPED. detectContractsDirs adds
// `root` in the recursive branch and the build took dirname(d) of it, producing a scope
// root OUTSIDE the project (`/tmp/x/projA` -> `/tmp/x`). In a linked union of SIBLING
// members that silently governs the sibling; when members are not siblings, a linked
// standalone contracts repo takes every cross-member seam dark.
async function rootIsContractsHomeScopeTest() {
  const { rootContractsEntries } = await import('../src/contracts-dirs.js');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-h4-')));

  // (a) a repo NAMED like a contracts home
  const named = join(work, 'payments-contracts');
  mkdirSync(join(named, 'sub'), { recursive: true });
  const eNamed = rootContractsEntries(named, true);
  eq(JSON.stringify(eNamed), JSON.stringify([{ dir: named, scopeRoot: null }]),
    'h4: a *-contracts repo root is UNSCOPED — dirname() would have scoped it to its PARENT, outside the project');

  // (b) a plain project root that merely HOLDS a top-level spec
  const projA = join(work, 'projA');
  mkdirSync(projA, { recursive: true });
  writeFileSync(join(projA, 'top.asyncapi.yaml'), 'asyncapi: 3.0.0\ninfo: { title: T, version: 1.0.0 }\nchannels: {}\n');
  const eTop = rootContractsEntries(projA, true);
  eq(JSON.stringify(eTop), JSON.stringify([{ dir: projA, scopeRoot: null }]),
    'h4: …and so is a root promoted by a top-level *.asyncapi.yaml');
  eq(dirname(projA), work, 'h4: …and the scope it would have got really is outside the project (a SIBLING would have been governed)');

  // A nested dir is still scoped normally — the fix is narrow.
  mkdirSync(join(projA, 'server', 'contracts'), { recursive: true });
  const both = rootContractsEntries(projA, true);
  eq(JSON.stringify(both.find((e) => e.dir.endsWith('server/contracts'))),
    JSON.stringify({ dir: join(projA, 'server', 'contracts'), scopeRoot: join(projA, 'server') }),
    'h4: a genuinely nested dir still governs its parent subtree');
  ok(both.every((e) => e.dir !== projA || e.scopeRoot === null), 'h4: …while the root entry stays unscoped');

  // Global mode is untouched: every scope root is null there regardless.
  ok(rootContractsEntries(projA, false).every((e) => e.scopeRoot === null), 'h4: global mode is all-null, as always');

  rmSync(work, { recursive: true, force: true });
}

// M9 — THE PATH-ANCESTOR GUARD. `dir.startsWith(scopeRoot + sep)` is what stops `/a` from
// governing `/afoo`. It was correct but untested: dropping the `+ sep` passed the whole
// suite.
async function scopePrefixGuardTest() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-m9-')));
  const root = work;
  mkdirSync(join(root, 'a', 'contracts'), { recursive: true });
  writeFileSync(join(root, 'a', 'contracts', 's.asyncapi.yaml'),
    'asyncapi: 3.0.0\ninfo: { title: A Wire, version: 1.0.0 }\nchannels:\n  r: { address: /a/route }\n');
  writeFileSync(join(root, 'a', 'inside.js'), "export function inA() { return fetch('/a/route'); }\n");
  mkdirSync(join(root, 'afoo'), { recursive: true });
  writeFileSync(join(root, 'afoo', 'outside.js'), "export function inAfoo() { return fetch('/a/route'); }\n");
  mkdirSync(join(root, '.wiregraph'), { recursive: true });
  writeFileSync(join(root, '.wiregraph', 'state.json'), JSON.stringify({
    project: root, indexedRoots: [root], links: [], reposLastSha: {}, autoUpdate: 'balanced',
    mode: 'recursive', compartments: [{ path: 'a', name: 'a' }, { path: 'afoo', name: 'afoo' }],
  }, null, 2));

  const db = join(work, 'graph.db');
  await runBuild({ target: root, project: root, db, reset: true });
  const conn = connect(db, { readonly: true });
  const m = refMap(conn, root);
  eq(refsFor(m, 'A Wire|/a/route'), JSON.stringify(['a']),
    'm9: a scope root of `<root>/a` governs `<root>/a` and NOT the sibling `<root>/afoo` — the guard is a PATH-ancestor test, not a string prefix');
  ok(readFileSync(join(root, 'afoo', 'outside.js'), 'utf8').includes('/a/route'),
    'm9: …and the exclusion is real: the afoo file does contain the literal');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// H5 — SHADOWED IS NOT MISSING. trace_contract reported the fixture's deliberately shared
// route as `only producer side [netcli] — consumer half missing` while netsrv implements it,
// is fully indexed, and is listed three lines below in the SAME report under the contract
// that actually governs it. Users and agents chase a phantom handler.
async function traceShadowedTokenTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-h5-'));
  const root = nestedProject(work);
  const db = join(work, 'graph.db');
  await runBuild({ target: root, project: root, db, reset: true });
  const conn = connect(db, { readonly: true });

  const outer = Q.traceContract(conn, root, 'Nested Outer Wire', null, false);
  has(outer, 'only producer side [netcli] — consumer half missing',
    'h5: the underlying one-sided verdict is unchanged — this contract really does see only one half');
  has(outer, 'NOT A MISSING IMPLEMENTATION', 'h5: …but the report no longer reads as a missing handler');
  has(outer, '"Server Inner Wire"', 'h5: …it names the contract that governs the other half');
  has(outer, 'referenced there by [netsrv, sim]', 'h5: …and the compartments that hold it, so the reader can go straight there');

  // The OTHER one-sided token on the same contract has no shadow, and must not gain a
  // bogus note. /harness/probe is declared by nobody else.
  const probeLine = outer.split('\n').find((l) => l.includes('/harness/probe')) || '';
  ok(!probeLine.includes('NOT A MISSING IMPLEMENTATION'),
    'h5: a genuinely one-sided token with no other declarant gets NO note — the check is observational, not a blanket disclaimer');
  // The scope relationship really is what gates it: the inner contract's recovered subtree
  // is a STRICT DESCENDANT of the outer one's, which is only recoverable because
  // contracts.file holds the spec's project-relative PATH and not a bare basename.
  const files = new Map(conn.prepare('SELECT name,file FROM contracts WHERE project=?').all(root).map((r) => [r.name, r.file]));
  eq(files.get('Nested Outer Wire'), 'contracts/outer.asyncapi.yaml',
    'h5: contracts.file is the spec PATH, so dirname(dirname(file)) recovers "." for the outer contract');
  eq(files.get('Server Inner Wire'), 'server/contracts/inner.asyncapi.yaml',
    'h5: …and "server" for the inner one, which is a strict descendant of it');

  // GLOBAL MODE cannot trip it: every contract is unscoped, so no other contract ever
  // holds a half this one lacks.
  conn.close();
  const gwork = mkdtempSync(join(tmpdir(), 'cg-h5g-'));
  const groot = nestedProject(gwork, { recursive: false });
  const gdb = join(gwork, 'graph.db');
  await runBuild({ target: groot, project: groot, db: gdb, reset: true });
  const gconn = connect(gdb, { readonly: true });
  ok(!Q.traceContract(gconn, groot, 'Nested Outer Wire', null, false).includes('NOT A MISSING IMPLEMENTATION'),
    'h5: global mode is untouched — nothing there can shadow anything');
  gconn.close();

  rmSync(work, { recursive: true, force: true });
  rmSync(gwork, { recursive: true, force: true });
}

// H5b — THE NOTE MUST NOT FIRE ON A DISJOINT SIBLING SCOPE.
// The observational test ("another contract declares this token and is referenced by
// compartments I do not see") is true of a NARROWER contract and EQUALLY true of a sibling
// one. `Client Inner Wire` (scope client/) and `Server Inner Wire` (scope server/) both
// declare /shared/thing; the declared consumer `world_state` genuinely does not implement
// it; and the tool asserted IN CAPITALS that a real missing implementation was not one. An
// agent reading that stops looking — strictly worse than the plain one-sided verdict.
async function traceShadowedSiblingTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-h5sib-'));
  const root = nestedProject(work);
  const db = join(work, 'graph.db');

  // The same token in BOTH inner specs — two DISJOINT sibling scopes. Its declared consumer
  // is world_state (client/), which does not mention the token anywhere, so the client
  // contract is genuinely one-sided on it and the missing half is genuinely missing.
  const add = (rel, body) => { const p = join(root, rel); writeFileSync(p, readFileSync(p, 'utf8') + body); };
  add('client/contracts/client.asyncapi.yaml',
    '  shared:\n    address: /shared/thing\n    x-wiregraph-producers: [netcli]\n    x-wiregraph-consumers: [world_state]\n');
  add('server/contracts/inner.asyncapi.yaml',
    '  shared:\n    address: /shared/thing\n    x-wiregraph-producers: [netsrv]\n    x-wiregraph-consumers: [sim]\n');
  // Only the SERVER side mentions it in code, so `Server Inner Wire` holds references the
  // client contract cannot see — which is exactly the observational shadow signal.
  appendFileSync(join(root, 'server', 'netsrv', 'net.js'), "\nexport function sharedThing() { return '/shared/thing'; }\n");
  appendFileSync(join(root, 'server', 'sim', 'sim.js'), "\nexport function readShared() { return '/shared/thing'; }\n");
  appendFileSync(join(root, 'client', 'netcli', 'net.js'), "\nexport function pushShared() { return '/shared/thing'; }\n");

  await runBuild({ target: root, project: root, db, reset: true });
  const conn = connect(db, { readonly: true });
  const client = Q.traceContract(conn, root, 'Client Inner Wire', null, false);
  const sharedLine = client.split('\n').find((l) => l.includes('/shared/thing')) || '';
  ok(sharedLine, 'h5sibling: the client contract does report on /shared/thing');
  ok(sharedLine.includes('missing'),
    'h5sibling: …and the underlying verdict is unchanged — world_state really does not implement it');
  ok(!sharedLine.includes('NOT A MISSING IMPLEMENTATION'),
    'h5sibling: …and a DISJOINT SIBLING scope earns NO reassurance — server/ took nothing from client/, so the missing half is genuinely missing');

  // The genuine nested shadow still fires in the same db, so the gate narrowed the note
  // rather than deleting it.
  has(Q.traceContract(conn, root, 'Nested Outer Wire', null, false), 'NOT A MISSING IMPLEMENTATION',
    'h5sibling: …while the real nested shadow (outer -> server/) still gets its note');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// --- the SessionStart nudge gate ----------------------------------------------
// `contractsDir` is single-valued and first-match-wins. A recursive project whose
// contracts live ONLY in nested dirs has a null singular, so a gate reading it alone nags
// forever. The plural closes that without going silent on a project that has none.
async function nudgeGatePluralTest() {
  const gate = (state) => (state.inferredSeams || 0) > 0 && !state.contractsDir && !(state.contractsDirs?.length);
  ok(gate({ inferredSeams: 3, contractsDir: null, contractsDirs: null }),
    'rnudge: seams and NO contracts dir at all still fires (the legacy case, and the resource-only project Phase 1b fixed)');
  ok(!gate({ inferredSeams: 3, contractsDir: '/p/contracts', contractsDirs: ['/p/contracts'] }),
    'rnudge: a global project with a contracts dir stays silent');
  ok(!gate({ inferredSeams: 3, contractsDir: null, contractsDirs: ['/p/server/contracts', '/p/client/contracts'] }),
    'rnudge: a recursive project with ONLY nested dirs is silent — the plural is what stops the forever-nag');
  ok(!gate({ inferredSeams: 0, contractsDir: null, contractsDirs: null }),
    'rnudge: no seams, no nudge');
  const src = readFileSync(join(HERE, '..', 'scripts', 'hooks', 'session-start.mjs'), 'utf8');
  has(src, '!(state.contractsDirs?.length)', 'rnudge: …and the hook really uses that gate');
}

// === WAVE 3 TESTS START ===

// Shared by the rename tests: a real git repo with a real commit. `.wiregraph/` is
// gitignored FIRST so the graph db never becomes a tracked file that `git status` then
// reports as a change on every run.
async function w3GitInit(dir) {
  writeFileSync(join(dir, '.gitignore'), '.wiregraph/\n');
  await execFileP('git', ['-C', dir, 'init', '-q']);
  await execFileP('git', ['-C', dir, 'config', 'user.email', 't@t']);
  await execFileP('git', ['-C', dir, 'config', 'user.name', 't']);
  await execFileP('git', ['-C', dir, 'add', '-A']);
  await execFileP('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
}

// --- B5 — A RENAMED SOURCE FILE IS NEVER PRUNED -------------------------------
// PRE-EXISTING, and byte-identical to the very first commit of this repo. `git diff`
// applies RENAME DETECTION by default, so `--name-only <last>..<head>` emitted ONLY the
// NEW path; the porcelain parse did the same thing explicitly with
// `line.slice(3).split(' -> ').pop()`. The OLD path therefore never entered
// changedSince().files and pruneFile was NEVER CALLED for it, so its file row, every
// symbol, the DEFINED_IN / IN_COMPARTMENT rows and the CALLS between them survived under
// a path that no longer exists — find_symbol reported two matches and get_source ENOENTed
// on the ghost. Self-heal time: NEVER, because the sha advanced and every later catch-up
// says "nothing changed". Signal: none.
//
// A plain `git rm` always pruned correctly, which is the tell: it is specifically rename
// DETECTION that loses the path, so the fix is to make both sides visible again.
async function renamePruneTest() {
  const S = await import('../scripts/lib/state.mjs');
  const GIT = await import('../scripts/lib/git.mjs');
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-w3ren-')));
  const refresh = (proj, args = []) => execFileP(process.execPath, [REFRESH, ...args], { env: { ...process.env, CLAUDE_PROJECT_DIR: proj } });
  const q = (proj, name) => { const c = connect(join(proj, '.wiregraph', 'graph.db'), { readonly: true }); try { return Q.findSymbol(c, proj, name); } finally { c.close(); } };
  const paths = (proj) => { const c = connect(join(proj, '.wiregraph', 'graph.db'), { readonly: true }); try { return c.prepare('SELECT path FROM files WHERE project=? ORDER BY path').all(proj).map((r) => r.path); } finally { c.close(); } };

  // The three renames a user actually performs, each in its own repo so one case cannot
  // launder another's ghost away. `alpha` calls `beta` so the surviving rows would include
  // a CALLS edge between two ghosts, not just isolated nodes.
  const BODY = 'export function alpha(){ return beta(); }\nexport function beta(){ return 2; }\n';
  const mkProj = async (tag) => {
    const p = realpathSync(mkdtempSync(join(ws, tag + '-')));
    mkdirSync(join(p, 'a'), { recursive: true });
    writeFileSync(join(p, 'a', 'one.js'), BODY);
    await w3GitInit(p);
    await refresh(p, ['--full']);
    has(q(p, 'alpha'), 'one.js', `w3rename ${tag}: alpha is indexed at its ORIGINAL path before the rename`);
    return p;
  };

  // ---- (1) COMMITTED rename (`git mv` + commit), the reported reproduction --------
  const p1 = await mkProj('committed');
  const full1 = S.readState(p1).lastFullBuild;
  await execFileP('git', ['-C', p1, 'mv', 'a/one.js', 'a/renamed.js']);
  await execFileP('git', ['-C', p1, 'commit', '-qm', 'rename']);
  // The unit-level cause, asserted directly: BOTH sides of the rename must reach `files`.
  const c1 = GIT.changedSince(p1, S.readState(p1).reposLastSha);
  ok(c1.files.includes(join(p1, 'a', 'one.js')) && c1.files.includes(join(p1, 'a', 'renamed.js')),
    'w3rename committed: changedSince returns the OLD path as well as the new — rename detection no longer swallows it');
  await refresh(p1);
  eq(S.readState(p1).lastFullBuild, full1,
    'w3rename committed: …and it was the INCREMENTAL that cleaned up — no full rebuild ran to launder the ghost away');
  has(q(p1, 'alpha'), 'renamed.js', 'w3rename committed: alpha now resolves at the NEW path');
  has(q(p1, 'alpha'), '1 match(es)', 'w3rename committed: exactly ONE alpha — the old path is not a second, ENOENT-ing match');
  eq(JSON.stringify(paths(p1)), JSON.stringify(['a/renamed.js']), 'w3rename committed: the OLD file row is gone from the db entirely');

  // ---- (2) STAGED, UNCOMMITTED rename (`git mv`, no commit) ----------------------
  // HEAD never moves, so the committed diff is empty and ONLY the porcelain parse can see
  // this one — which is why it needs its own case.
  const p2 = await mkProj('staged');
  const full2 = S.readState(p2).lastFullBuild;
  await execFileP('git', ['-C', p2, 'mv', 'a/one.js', 'a/staged.js']);
  const st2 = await execFileP('git', ['-C', p2, 'status', '--porcelain']);
  has(st2.stdout, 'R ', 'w3rename staged: git really reports this as a porcelain RENAME record (not a delete+add)');
  const c2 = GIT.changedSince(p2, S.readState(p2).reposLastSha);
  ok(c2.files.includes(join(p2, 'a', 'one.js')) && c2.files.includes(join(p2, 'a', 'staged.js')),
    'w3rename staged: the porcelain R record yields BOTH paths');
  await refresh(p2);
  eq(S.readState(p2).lastFullBuild, full2, 'w3rename staged: cleaned up incrementally, no rebuild');
  eq(JSON.stringify(paths(p2)), JSON.stringify(['a/staged.js']), 'w3rename staged: only the new path survives');
  has(q(p2, 'beta'), '1 match(es)', 'w3rename staged: beta is unique — no ghost twin under the old path');

  // ---- (3) UNSTAGED rename (a plain `mv`, git never told) ------------------------
  // The CONTROL. git sees an unrelated ` D old` + `?? new`, so this case always worked;
  // asserting it is what proves the bug was rename DETECTION and not deletion handling.
  const p3 = await mkProj('unstaged');
  renameSync(join(p3, 'a', 'one.js'), join(p3, 'a', 'moved.js'));
  await refresh(p3);
  eq(JSON.stringify(paths(p3)), JSON.stringify(['a/moved.js']), 'w3rename unstaged: a plain mv was always pruned correctly — the control case');

  // ---- (4) The --files POST-EDIT path ------------------------------------------
  // post-edit.mjs passes explicit paths, so it never consults changedSince at all. It is
  // named in the report as also reproducing, and it does — but for a different reason: it
  // only ever sees the path the EDIT tool touched. Pinning it here records that the old
  // path must be handed in for the prune to happen, which is what the auto path now does.
  const p4 = await mkProj('postedit');
  await execFileP('git', ['-C', p4, 'mv', 'a/one.js', 'a/edited.js']);
  await refresh(p4, ['--files', join(p4, 'a', 'edited.js')]);
  has(paths(p4).join(','), 'a/one.js',
    'w3rename --files: an explicit-set refresh naming ONLY the new path still leaves the old row (it is told nothing about the rename)');
  await refresh(p4); // the auto catch-up is the thing that now heals it
  eq(JSON.stringify(paths(p4)), JSON.stringify(['a/edited.js']),
    'w3rename --files: …and the very next auto catch-up prunes it, so the post-edit path self-heals instead of wedging forever');

  rmSync(ws, { recursive: true, force: true });
}

// B5, the RECURSIVE-MODE half. Swapping two declared compartments' contents leaves the
// declaration byte-identical and both declared paths existing, so NO fingerprint can move
// and nothing escalates. With only the new paths visible, the old compartments' rows
// survive and the re-derive fabricates seams — the report observed 7 WIRE edges where a
// rebuild produces 4, including a symbol wired to ITSELF across two compartments
// (`sym:ecs:ecs.js:ecsStep:2 -> sym:sim:ecs.js:ecsStep:2`).
async function renameSwapCompartmentsTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-w3swap-')));
  const root = nestedProject(work);
  const dbPath = join(root, '.wiregraph', 'graph.db');
  const refresh = (args = []) => execFileP(process.execPath, [REFRESH, ...args], { env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  const derived = (path) => {
    const c = connect(path, { readonly: true });
    try {
      return JSON.stringify({
        wire: c.prepare("SELECT type, src, dst, token FROM edges WHERE project=? AND type IN ('WIRE','RESOURCE') ORDER BY type, token, src, dst").all(root),
        files: c.prepare('SELECT compartment, path FROM files WHERE project=? ORDER BY compartment, path').all(root),
        syms: c.prepare('SELECT id FROM symbols WHERE project=? ORDER BY id').all(root).map((r) => r.id),
      });
    } finally { c.close(); }
  };

  await w3GitInit(root);
  await refresh(['--full']);
  const before = S.readState(root);
  const fpBefore = JSON.stringify(before.compartmentsFingerprint);

  // THE SWAP: ecs.js and sim.js trade declared compartments. Both declared dirs still
  // exist and the declaration text is untouched.
  await execFileP('git', ['-C', root, 'mv', 'server/ecs/ecs.js', 'server/sim/ecs.js']);
  await execFileP('git', ['-C', root, 'mv', 'server/sim/sim.js', 'server/ecs/sim.js']);
  await execFileP('git', ['-C', root, 'commit', '-qm', 'swap']);
  eq(JSON.stringify(S.compartmentsFingerprint([root])), fpBefore,
    'w3swap: the compartment fingerprint is UNMOVED by the swap — nothing can escalate, so the prune is the only defence');

  await refresh();
  eq(S.readState(root).lastFullBuild, before.lastFullBuild,
    'w3swap: the catch-up stayed INCREMENTAL (a rebuild here would hide the defect rather than fix it)');

  const db2 = join(work, 'swapped-full.db');
  await runBuild({ target: root, project: root, db: db2, reset: true });
  eq(derived(dbPath), derived(db2),
    'w3swap: the incremental result is IDENTICAL to a full rebuild of the swapped tree — no surviving rows, no fabricated seams');

  const c = connect(dbPath, { readonly: true });
  const ids = c.prepare('SELECT id FROM symbols WHERE project=?').all(root).map((r) => r.id);
  const wire = c.prepare("SELECT src, dst FROM edges WHERE project=? AND type='WIRE'").all(root);
  c.close();
  ok(!ids.some((i) => i.startsWith('sym:ecs:ecs.js:')), 'w3swap: no symbol survives under its PRE-swap compartment+path');
  ok(!ids.some((i) => i.startsWith('sym:sim:sim.js:')), 'w3swap: …in either direction');
  ok(!wire.some((e) => e.src.split(':').slice(2).join(':') === e.dst.split(':').slice(2).join(':')),
    'w3swap: no WIRE edge joins a symbol to ITSELF across two compartments — the pure fabrication is gone');

  rmSync(work, { recursive: true, force: true });
}

// --- B7 — AN UNREADABLE <db>.heal MARKER WEDGES EVERY DRIFT ESCALATION FOREVER ---
// claimHeal read the marker's pid to decide steal-vs-wait. If readFileSync/statSync THREW
// — a directory at that path, a chmod 000 file, one owned by another user — it did
// `continue`, which BURNED an attempt without ever reaching shouldStealLock. After two
// attempts it returned null, healPartitionDrift logged the FALSE "another process is
// already rebuilding" and ended the round. The age-based steal was UNREACHABLE, so ageing
// the marker did not help and nothing was ever indexed again.
// TWO MORE SHAPES, EACH ITS OWN BLOCKER, added after the above shipped:
//
//   * A DANGLING SYMLINK — the ORIGINAL bug, and the one the first fix MISSED. readFileSync
//     on a dangling link returns ENOENT, and ENOENT is the "benign race -> continue" branch,
//     so it burned both attempts without ever reaching shouldStealLock and the wedge stayed
//     exactly as described above. The fix's own comment called this case "ELOOP"; ELOOP is a
//     symlink LOOP. lstat is what tells the two apart: it SEES the link instead of resolving
//     it, so a dangling link is debris and a genuinely vanished marker is still a race.
//   * A FIFO — worse than a wedge. readFileSync on a fifo BLOCKS FOREVER, with no timeout
//     and no output, hanging the refresh WORKER; every subsequent PostToolUse then spawned
//     another permanently-hung process. acquireLock has guarded this since it was written
//     ("reading a fifo would block forever"); claimHeal never adopted the guard.
//
// EVERY CHILD HERE IS BOUNDED (SIGKILL) and BLOCKED is asserted against explicitly — a
// regression on the fifo case must fail one assertion, never hang this suite.
async function healMarkerUnreadableTest() {
  const S = await import('../scripts/lib/state.mjs');
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-w3heal-')));

  // existsSync FOLLOWS symlinks, so it reports false for a dangling one that is still
  // sitting there. Ask the directory instead.
  const nameThere = (p) => readdirSync(dirname(p)).includes(basename(p));
  // The refresh worker under a hard kill bound: 'DONE' or 'BLOCKED', never a hang.
  const refreshBounded = (args, env, boundMs = 90_000) => new Promise((res) => {
    execFile(process.execPath, [REFRESH, ...args], { env, timeout: boundMs, killSignal: 'SIGKILL', maxBuffer: 1 << 24 },
      (err) => res(err && err.killed ? 'BLOCKED' : 'DONE'));
  });

  // One scenario, run once per marker SHAPE. Each gets its own project: a wedge in the
  // first would otherwise be indistinguishable from a pass in the second.
  const scenario = async (tag, makeMarker) => {
    const work = realpathSync(mkdtempSync(join(ws, tag + '-')));
    const root = nestedProject(work);
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    const dbPath = join(root, '.wiregraph', 'graph.db');
    const log = () => readFileSync(join(root, '.wiregraph', 'refresh.log'), 'utf8');

    await execFileP(process.execPath, [REFRESH, '--full'], { env });
    const firstBuild = S.readState(root).lastFullBuild;

    // REAL partition drift: rename a declared compartment. Every id under it moves, which
    // is exactly the condition healPartitionDrift exists to escalate.
    const sp = join(root, '.wiregraph', 'state.json');
    const st = JSON.parse(readFileSync(sp, 'utf8'));
    st.compartments = st.compartments.map((c) => (c.name === 'harness' ? { ...c, name: 'harness_renamed' } : c));
    writeFileSync(sp, JSON.stringify(st, null, 2));
    ok(S.compartmentsDrift(S.readState(root).compartmentsFingerprint, S.compartmentsFingerprint([root])),
      `w3heal ${tag}: the declaration edit really is detectable drift`);

    await makeMarker(dbPath + '.heal');
    ok(nameThere(dbPath + '.heal'), `w3heal ${tag}: the unreadable marker is in place`);

    const edited = join(root, 'harness', 'harness.js');
    appendFileSync(edited, '\nexport function h_3() { return 3; }\n');
    eq(await refreshBounded(['--files', edited], env), 'DONE',
      `w3heal ${tag}: the refresh worker RETURNS — a marker it cannot read must never be read (a fifo blocks forever)`);

    ok(!log().includes('another process is already rebuilding'),
      `w3heal ${tag}: the FALSE "another process is already rebuilding" is not logged — an unreadable marker is no evidence of a live holder`);
    has(log(), 'escalating to full rebuild', `w3heal ${tag}: the drift escalation actually runs`);
    ok(S.readState(root).lastFullBuild !== firstBuild, `w3heal ${tag}: …and lastFullBuild advanced, so the project really rebuilt`);
    const c = connect(dbPath, { readonly: true });
    const found = Q.findSymbol(c, root, 'h_3');
    const comps = c.prepare('SELECT name FROM compartments WHERE project=?').all(root).map((r) => r.name);
    c.close();
    has(found, 'harness.js', `w3heal ${tag}: the edit is INDEXED — the wedge indexed nothing, ever`);
    ok(comps.includes('harness_renamed'), `w3heal ${tag}: …under the re-declared partition`);
    ok(!nameThere(dbPath + '.heal'), `w3heal ${tag}: the stolen marker is released, not left to wedge the next round`);
  };

  // (a) A DIRECTORY at the marker path. readFileSync throws EISDIR, and a non-recursive
  //     rmSync would then throw too — so the steal has to be recursive as well.
  await scenario('dir', (p) => mkdirSync(p, { recursive: true }));

  // (b) A chmod 000 FILE. readFileSync throws EACCES. Skipped under root, where the mode
  //     bits do not apply and the file reads back as empty (already-stealable garbage).
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    await scenario('chmod000', (p) => { writeFileSync(p, '12345'); chmodSync(p, 0o000); });
  } else {
    ok(true, 'w3heal chmod000: skipped — running as root, where mode bits cannot make a file unreadable');
  }

  // (c) A DANGLING SYMLINK. `openSync 'wx'` fails EEXIST on the LINK; readFileSync follows
  //     it and gets ENOENT — which the pre-fix code read as "it vanished, retry", burning
  //     both attempts. lstat sees a symlink, which is not a regular file, so: debris.
  await scenario('dangling-symlink', (p) => symlinkSync(p + '.nowhere', p));

  // (d) A SYMLINK TO A DIRECTORY. Stat-able but not a regular file. The steal must unlink
  //     the LINK, never recurse into the target.
  await scenario('symlink-to-directory', (p) => { mkdirSync(p + '.dir'); symlinkSync(p + '.dir', p); });

  // (e) A FIFO — the hang. Not a regular file, so it is classified as debris without ever
  //     being opened for read. Skipped where mkfifo is unavailable.
  if (await execFileP('mkfifo', ['--version']).then(() => true, () => false)) {
    await scenario('fifo', (p) => execFileP('mkfifo', [p]));
  } else {
    ok(true, 'w3heal fifo: skipped — no mkfifo on this system');
  }

  // (f) A marker FAR TOO BIG to be a pid. It must not be slurped (the old code read it
  //     whole, once per attempt), and with no parseable pid it falls to the mtime rule —
  //     so an OLD one is stolen, exactly like the empty/garbage marker.
  await scenario('huge-old', (p) => {
    writeFileSync(p, 'x'.repeat(4 << 20));
    const t = Date.now() / 1000 - 600;
    utimesSync(p, t, t);
  });

  // A LIVE, READABLE claim must still be honoured: this fix widens what counts as
  // stealable, and must not turn the single-flight into a free-for-all.
  {
    const work = realpathSync(mkdtempSync(join(ws, 'live-')));
    const root = nestedProject(work);
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    const dbPath = join(root, '.wiregraph', 'graph.db');
    await execFileP(process.execPath, [REFRESH, '--full'], { env });
    const firstBuild = S.readState(root).lastFullBuild;
    const sp = join(root, '.wiregraph', 'state.json');
    const st = JSON.parse(readFileSync(sp, 'utf8'));
    st.compartments = st.compartments.filter((c) => c.name !== 'harness');
    writeFileSync(sp, JSON.stringify(st, null, 2));
    writeFileSync(dbPath + '.heal', String(process.pid)); // this process is alive and readable
    const edited = join(root, 'server', 'sim', 'sim.js');
    appendFileSync(edited, '\nexport function simLive() { return 1; }\n');
    await execFileP(process.execPath, [REFRESH, '--files', edited], { env });
    has(readFileSync(join(root, '.wiregraph', 'refresh.log'), 'utf8'), 'another process is already rebuilding',
      'w3heal live: a READABLE marker naming a LIVE pid is still respected — the single-flight is intact');
    eq(S.readState(root).lastFullBuild, firstBuild, 'w3heal live: …and no concurrent rebuild was started');
  }

  // Two properties no black-box case can reach, pinned at the source exactly as the lock
  // tests pin their deadline:
  //   - the marker is INSPECTED with lstat BEFORE any read (that is what makes a dangling
  //     link debris rather than a vanished file, and what keeps a fifo from being opened);
  //   - a byte cap, so a huge marker is never slurped on the way to "unparseable".
  // And the GENUINE benign race — a marker that really did vanish between the failed open
  // and the inspection — must still `continue`, which is only visible in the source: it
  // cannot be provoked deterministically from outside the process.
  {
    const src = readFileSync(REFRESH, 'utf8');
    const claim = src.slice(src.indexOf('function claimHeal'), src.indexOf('async function healOutdatedSchemas'));
    ok(claim.includes('lstatSync(p)'), 'w3heal src: claimHeal LSTATS the marker (a dangling link is seen, not resolved)');
    ok(claim.indexOf('lstatSync(p)') < claim.indexOf('readFileSync(p'),
      'w3heal src: …before it reads it — reading a fifo blocks forever, so the read must be gated on "regular file"');
    ok(/isFile\(\)/.test(claim), 'w3heal src: …and only a REGULAR FILE is ever read');
    ok(/HEAL_MAX_BYTES/.test(claim), 'w3heal src: a marker too big to be a pid is not slurped');
    ok(/code === 'ENOENT'\) continue/.test(claim), 'w3heal src: the genuine benign race — a marker that truly vanished — still retries');
  }

  rmSync(ws, { recursive: true, force: true });
}

// --- M1 — CONTENT-DROPPING REFUSALS WENT TO /dev/null ON THE HOOK PATH ----------
// Five refusals that DELETE graph content are plain process.stderr.write calls in the
// build, and both hook dispatchers spawned refresh.mjs with `stdio: 'ignore'`. So on the
// hook path — which now includes the full rebuilds the schema and drift heals trigger —
// they were unrecorded in state, absent from refresh.log and absent from graph_status. The
// DECISION lines already survived; only the content-dropping ones vanished.
async function hookWarningsPersistedTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-w3warn-')));
  const root = nestedProject(work);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
  const log = () => readFileSync(join(root, '.wiregraph', 'refresh.log'), 'utf8');

  // enforceDistinctTitlePerScope — one of the named five, and the loudest: it SKIPS an
  // entire spec's tokens. Two specs in disjoint scopes claiming one title.
  const dupe = join(root, 'client', 'contracts', 'dupe.asyncapi.yaml');
  writeFileSync(dupe, [
    'asyncapi: 3.0.0', 'info:', '  title: Server Inner Wire', '  version: 1.0.0',
    'channels:', '  x:', '    address: /client/only',
    '    x-wiregraph-producers: [netcli]', '    x-wiregraph-consumers: [world_state]', '',
  ].join('\n'));

  const r = await execFileP(process.execPath, [REFRESH, '--full'], { env });
  has(r.stderr, 'contract title collision ACROSS SCOPES',
    'w3warn: the build really does emit the refusal on stderr (the stream the hooks sent to /dev/null)');

  has(log(), 'warning (graph content dropped)', 'w3warn: …and refresh.log now carries it, so a hook-driven rebuild leaves a record');
  has(log(), 'contract title collision ACROSS SCOPES', 'w3warn: …naming the actual refusal, not a generic "something was dropped"');
  // Defaulted rather than dereferenced: on the PRE-fix code the key is absent entirely,
  // and a TypeError here would abort the runner before it prints its totals.
  const snap = S.readState(root).lastBuildWarnings || {};
  ok(snap.kind === 'full' && Array.isArray(snap.items) && snap.items.length >= 1,
    'w3warn: …and state carries a replaceable snapshot a status reader can surface without parsing a log');
  ok((snap.items || []).some((i) => i.includes('SKIPPING')),
    'w3warn: …whose text says what was DROPPED — the whole point of surfacing it');
  ok(!!snap.at, 'w3warn: the snapshot is timestamped');

  // An INCREMENTAL that re-hits the same refusal records it too — the drift/schema heals
  // are not the only way a save reloads the contract set.
  const before = log().length;
  const edited = join(root, 'client', 'netcli', 'net.js');
  appendFileSync(edited, '\nexport function netcliTail() { return 1; }\n');
  await execFileP(process.execPath, [REFRESH, '--files', edited], { env });
  has(log().slice(before), 'warning (graph content dropped)', 'w3warn: an ordinary post-edit save records it as well, not only a full rebuild');

  // …and a CLEAN full rebuild clears the snapshot, so a fixed spec stops being reported.
  // Only a full rebuild may clear it: an incremental never re-runs the WIRE derivation, so
  // letting a quiet one-file save blank the key would erase a real fan-out-cap finding.
  rmSync(dupe);
  await execFileP(process.execPath, [REFRESH, '--full'], { env });
  const cleaned = S.readState(root).lastBuildWarnings || {};
  ok(cleaned.kind === 'full' && Array.isArray(cleaned.items) && cleaned.items.length === 0,
    'w3warn: a clean full rebuild clears the snapshot — a fixed spec stops being reported as dropped');

  // The dispatchers no longer throw the child's stderr away. This is the half no
  // functional assertion can reach from inside the child, because it is about the fd the
  // PARENT hands it — and it is where a failure BEFORE the tee installs would be lost.
  for (const hook of ['post-edit.mjs', 'session-start.mjs']) {
    const src = readFileSync(join(HERE, '..', 'scripts', 'hooks', hook), 'utf8');
    ok(!/stdio:\s*'ignore'\s*,/.test(src), `w3warn: ${hook} no longer wires the detached refresh worker's stderr to /dev/null`);
    has(src, 'openRefreshErrFd', `w3warn: …it points fd 2 at a real file instead`);
  }
  const HL = await import('../scripts/lib/hooklog.mjs');
  const fd = HL.openRefreshErrFd(root);
  ok(fd !== null && existsSync(HL.refreshErrLogPath(root)), 'w3warn: the raw-stderr log is creatable under .wiregraph/');
  if (fd !== null) { const { closeSync } = await import('node:fs'); closeSync(fd); }
  eq(HL.openRefreshErrFd('/nonexistent-w3/nope'), null, 'w3warn: …and an unopenable path degrades to null so the spawn still happens');

  rmSync(work, { recursive: true, force: true });
}

// --- H1 — GLOBAL MODE SILENTLY MERGED TWO COMPARTMENTS SHARING A BASENAME -------
// compartmentId is NAME-ONLY, so two boundary dirs called `network` collapsed into ONE row
// via INSERT OR REPLACE: whichever root landed last won, every relPath from the other
// resolved under it, and get_source read the wrong file or ENOENTed. validateDeclaration
// guards this WITHIN a declaration and canLink guards it ACROSS linked members — nothing
// guarded the INFERRED partition, which is the one global mode always runs on. Init's own
// scope command printed the duplicate without flagging it and then recommended Global.
// `client/network` + `server/network` is a real user's planned layout.
async function inferredBasenameCollisionTest() {
  const W = await import('../src/extract/walk.js');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-w3coll-')));
  const root = join(work, 'ws');
  const mk = (rel, files) => {
    const d = join(root, rel);
    mkdirSync(d, { recursive: true });
    for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  };
  // Same basename, DIFFERENT bodies, so a symbol resolving under the wrong root is
  // observable as wrong SOURCE and not merely as a wrong path.
  mk('client/network', { 'package.json': '{"name":"cnet"}', 'transport.js': 'export function transport(){ return "CLIENT SIDE"; }\n' });
  mk('server/network', { 'package.json': '{"name":"snet"}', 'listener.js': 'export function listener(){ return "SERVER SIDE"; }\n' });
  mk('client/input', { 'package.json': '{"name":"cin"}', 'input.js': 'export function inputFn(){ return 1; }\n' });

  const roots = W.findCompartmentRoots(root);
  const names = roots.map((r) => r.name).sort();
  eq(JSON.stringify(names), JSON.stringify(['client/network', 'input', 'server/network'].sort()),
    'w3coll: the two colliding roots get DISTINCT, path-derived names while the non-colliding one keeps its bare basename');
  eq(new Set(names).size, 3, 'w3coll: …so the partition really has three distinct names, not two');

  const db = join(work, 'graph.db');
  const out = await execFileP(process.execPath, [BUILD, root, '--project', root, '--db', db, '--reset']);
  has(out.stderr, 'COMPARTMENT NAME COLLISION',
    'w3coll: the rename is LOUD — a graph-shape change the user has to know about cannot be silent');
  has(out.stderr, 'client/network', 'w3coll: …and names the actual directories');
  has(out.stderr, 'x-wiregraph-producers', 'w3coll: …and states the consequence to act on (specs naming the bare basename go dark)');

  const c = connect(db, { readonly: true });
  const comps = c.prepare('SELECT name, root FROM compartments WHERE project=? ORDER BY name').all(root);
  eq(comps.length, 3, 'w3coll: THREE compartment rows — the INSERT OR REPLACE collapse is gone');
  // Falls back rather than throwing: on the PRE-fix code the row simply does not exist,
  // and a TypeError here would abort the whole runner before it prints its totals — which
  // makes the mutation test report nothing instead of a count.
  const rowFor = (n) => comps.find((r) => r.name === n) || { name: n, root: null };
  eq(rowFor('client/network').root, join(root, 'client', 'network'), 'w3coll: each compartment keeps its OWN root');
  eq(rowFor('server/network').root, join(root, 'server', 'network'), 'w3coll: …both of them');
  const files = c.prepare('SELECT compartment, path FROM files WHERE project=? ORDER BY compartment, path').all(root);
  eq(JSON.stringify(files), JSON.stringify([
    { compartment: 'client/network', path: 'transport.js' },
    { compartment: 'input', path: 'input.js' },
    { compartment: 'server/network', path: 'listener.js' },
  ]), 'w3coll: every file is attributed to its own compartment, with relPath relative to its OWN root');

  // The user-visible symptom in the report: get_source ENOENTing on
  // '<root>/server/network/src/transport.ts' — a client file resolved under the server root.
  has(Q.getSource(c, root, 'transport'), 'CLIENT SIDE', 'w3coll: get_source on the client symbol returns the CLIENT body, not ENOENT and not the server file');
  has(Q.getSource(c, root, 'listener'), 'SERVER SIDE', 'w3coll: …and the server symbol returns the server body');
  c.close();

  // A partition with NO collision must come back byte-identical — this is what keeps every
  // existing project's ids stable.
  const clean = realpathSync(mkdtempSync(join(tmpdir(), 'cg-w3clean-')));
  mkdirSync(join(clean, 'a'), { recursive: true }); writeFileSync(join(clean, 'a', 'package.json'), '{"name":"a"}');
  mkdirSync(join(clean, 'b'), { recursive: true }); writeFileSync(join(clean, 'b', 'package.json'), '{"name":"b"}');
  eq(JSON.stringify(W.findCompartmentRoots(clean).map((r) => r.name).sort()), JSON.stringify(['a', 'b']),
    'w3coll: a collision-free partition is untouched — no name is rewritten and no project\'s ids move');

  // A DECLARED partition is not touched by this: it already rejects duplicates at declare
  // time, so the disambiguator must not second-guess names the user chose.
  const decl = realpathSync(mkdtempSync(join(tmpdir(), 'cg-w3decl-')));
  mkdirSync(join(decl, 'client', 'network'), { recursive: true });
  mkdirSync(join(decl, 'server', 'network'), { recursive: true });
  mkdirSync(join(decl, '.wiregraph'), { recursive: true });
  writeFileSync(join(decl, '.wiregraph', 'state.json'), JSON.stringify({
    project: decl, mode: 'recursive',
    compartments: [{ path: 'client/network', name: 'cnet' }, { path: 'server/network', name: 'snet' }],
  }));
  eq(JSON.stringify(W.findCompartmentRoots(decl).map((r) => r.name).sort()), JSON.stringify(['cnet', 'snet']),
    'w3coll: declared names are passed through verbatim — the guard is only for the INFERRED partition');

  rmSync(work, { recursive: true, force: true });
  rmSync(clean, { recursive: true, force: true });
  rmSync(decl, { recursive: true, force: true });
}

// === WAVE 3 TESTS END ===

// === LOCK TESTS START ===
// acquireLock used to SPIN FOREVER whenever <db>.lock could not be read: its
// EEXIST branch did `catch { continue; }`, which jumped straight back to the top
// of the retry loop and skipped its own deadline check — so neither
// LOCK_TIMEOUT_MS nor LOCK_HARD_MAX_MS could ever fire and shouldStealLock was
// never even consulted. A DIRECTORY at <db>.lock (EISDIR on the read) therefore
// wedged every writer silently and forever; so did a chmod-000 file, a dangling
// symlink, or anything else unreadable. The rule now: a lock we cannot STAT or
// READ is DEBRIS, not a live claim, and is stolen — while a lock naming a LIVE
// pid still blocks for the documented interval.
const LOCK_SQLITE = join(HERE, '..', 'src', 'store', 'sqlite.js');

// Drive the REAL acquireLock (via connect) in a CHILD process under a hard
// SIGKILL bound, so a regression can never hang this suite: the worst case is
// that one case reports BLOCKED and its assertion fails. Returns the child's last
// line — 'OK <ms>' on success, 'THREW <msg>' on a thrown timeout, 'BLOCKED' if it
// had to be killed.
function lockConnectBounded(db, boundMs) {
  const code = `import(${JSON.stringify(pathToFileURL(LOCK_SQLITE).href)})`
    + `.then(m => { const t = Date.now(); const c = m.connect(${JSON.stringify(db)}); c.close(); console.log('OK ' + (Date.now() - t)); })`
    + `.catch(e => console.log('THREW ' + e.message));`;
  return new Promise((res) => {
    execFile('node', ['-e', code], { timeout: boundMs, killSignal: 'SIGKILL', maxBuffer: 1 << 24 }, (err, so, se) => {
      if (err && err.killed) return res('BLOCKED');
      res(String(so + se).trim().split('\n').pop() || 'EMPTY');
    });
  });
}

async function lockDebrisTests() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-lockdebris-')));
  let seq = 0;
  const freshDb = () => { const d = join(work, 'p' + (++seq)); mkdirSync(d, { recursive: true }); return join(d, 'graph.db'); };
  const backdate = (p, secs) => { const t = Date.now() / 1000 - secs; utimesSync(p, t, t); };
  // existsSync() follows symlinks, so it reports false for a dangling one that is
  // still sitting there. Ask the directory instead.
  const nameThere = (p) => readdirSync(dirname(p)).includes(basename(p));

  // Each of these must be STOLEN: connect returns promptly and leaves no debris.
  // Before the fix every one of them (except the plain-file cases, kept here to
  // pin the pre-existing mtime/liveness paths) spun until killed.
  const stealsFast = async (label, plant) => {
    const db = freshDb();
    await plant(db);
    const r = await lockConnectBounded(db, 20_000);
    has(r, 'OK', `lockdebris/${label}: connect completes instead of spinning forever`);
    ok(!nameThere(db + '.lock'), `lockdebris/${label}: ...and the debris at the lock path is gone afterwards`);
  };

  // A lock naming a LIVE holder is a live session however slow, and must still be
  // waited out (bug M9) — assert it is STILL blocked when the bound expires.
  const blocks = async (label, plant) => {
    const db = freshDb();
    await plant(db);
    const r = await lockConnectBounded(db, 2_500);
    eq(r, 'BLOCKED', `lockdebris/${label}: a live claim is still WAITED on, not stolen`);
    ok(nameThere(db + '.lock'), `lockdebris/${label}: ...and the holder's lock is left untouched`);
  };

  const fifoOk = await execFileP('mkfifo', ['--version']).then(() => true, () => false);

  await Promise.all([
    // --- the reported hang: a path we cannot READ ---
    stealsFast('directory', (db) => mkdirSync(db + '.lock')),
    stealsFast('non-empty-directory', (db) => { mkdirSync(db + '.lock'); writeFileSync(join(db + '.lock', 'junk'), 'x'); }),
    // chmod 000 — unreadable to us. Contents are a dead PID so the case still
    // resolves to a steal (not a wait) even in the degenerate root-runs-the-tests
    // environment where the mode is ignored.
    stealsFast('chmod-000', (db) => { writeFileSync(db + '.lock', '2147483647'); chmodSync(db + '.lock', 0o000); }),
    // A dangling symlink: openSync 'wx' fails EEXIST on the LINK, while the read
    // follows it and gets ENOENT. Unstat-able => debris.
    stealsFast('dangling-symlink', (db) => symlinkSync(db + '.nowhere', db + '.lock')),
    // A symlink to a directory: stat-able but not a regular file => debris. The
    // steal must unlink the SYMLINK, never touch the target.
    stealsFast('symlink-to-directory', (db) => { mkdirSync(db + '.dir'); symlinkSync(db + '.dir', db + '.lock'); }),

    // --- preserved behaviour: the documented steal paths still work ---
    // Unparseable PID + mtime past LOCK_STALE_MS -> the age-based steal.
    stealsFast('empty-file-old', (db) => { writeFileSync(db + '.lock', ''); backdate(db + '.lock', 120); }),
    stealsFast('garbage-old', (db) => { writeFileSync(db + '.lock', 'not a pid\nat all'); backdate(db + '.lock', 120); }),
    // A lock far too big to be a PID is unparseable, and must not be slurped into
    // memory once per 50ms poll on the way to that conclusion.
    stealsFast('huge-file-old', (db) => { writeFileSync(db + '.lock', 'x'.repeat(4 << 20)); backdate(db + '.lock', 120); }),
    // Known PID, holder DEAD -> immediate crash recovery, regardless of age.
    stealsFast('dead-pid-fresh', (db) => writeFileSync(db + '.lock', '2147483647')),
    // Known PID, holder LIVE, but the lock is older than LOCK_HARD_MAX_MS -> the
    // PID-reuse / wedged-holder backstop still steals.
    stealsFast('live-pid-past-hard-max', (db) => { writeFileSync(db + '.lock', String(process.pid)); backdate(db + '.lock', 400); }),
  ]);

  // A FIFO would BLOCK FOREVER inside readFileSync — a second, quieter way to
  // hang. It is not a regular file, so it is classified as debris without ever
  // being opened for read.
  if (fifoOk) await stealsFast('fifo', (db) => execFileP('mkfifo', [db + '.lock']));

  await Promise.all([
    // The M9 invariant: a live holder keeps its lock for the documented interval.
    blocks('live-pid-fresh', (db) => writeFileSync(db + '.lock', String(process.pid))),
    // The openSync-'wx'-won-but-PID-not-written race: unparseable PID BELOW the
    // stale window still waits rather than robbing a possibly-fresh live lock.
    blocks('empty-file-fresh', (db) => writeFileSync(db + '.lock', '')),
  ]);

  // The structural invariant behind all of the above, and the only cheap way to
  // pin it: the absolute deadline must be REACHABLE on every path through the
  // retry loop. A `continue` that jumps over it is precisely what made the
  // directory case unbounded — and it stays unbounded even when the steal
  // decision is right, if the steal itself cannot remove the debris (a read-only
  // parent dir). That last case is far too slow to assert here (it ends in a
  // thrown LOCK_TIMEOUT_MS timeout ~5.5 min later), so guard the shape instead.
  const acqSrc = (() => {
    const src = readFileSync(LOCK_SQLITE, 'utf8');
    const a = src.indexOf('function acquireLock'), b = src.indexOf('function releaseLock');
    return a >= 0 && b > a ? src.slice(a, b) : '';
  })();
  ok(acqSrc.length > 0, 'lockdebris: located acquireLock in src/store/sqlite.js');
  const acqCode = acqSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // comments may discuss `continue`; code may not use it
  has(acqCode, 'timed out waiting for db lock', 'lockdebris: acquireLock still has an absolute deadline to hit');
  ok(!/\bcontinue\b/.test(acqCode),
    'lockdebris: no `continue` in acquireLock — every path must fall through to the deadline check');
  ok(/recursive:\s*true/.test(acqCode),
    'lockdebris: the steal removes a DIRECTORY at the lock path too (plain rmSync refuses one with EISDIR)');

  try { chmodSync(join(work, 'p3', 'graph.db.lock'), 0o644); } catch { /* already stolen */ }
  rmSync(work, { recursive: true, force: true });
}
// === LOCK TESTS END ===

// === WAVE 2 TESTS START ===
// Three blockers found by end-to-end testing, each reproduced before it was fixed.
//   B3  the import-suppression matcher blacked out on PROSE, in every language
//   B4  `/wiregraph-contracts apply` deleted hand-written resource contracts
//   B6  AsyncAPI 2.x specs loaded as ZERO tokens, silently

// --- B3: the import-suppression region, over RAW TEXT --------------------------
// scanTokenOccurrences skips a token occurrence that sits on an import line. The line
// test is a REGEX OVER RAW TEXT and the comment ranges do not help it: tree-sitter parses
// a Python docstring as an `expression_statement`, not a comment, and a JS template
// literal / heredoc is code. So every arm of IMPORT_START_RE meets ordinary prose, and the
// region it opens used to run on an unbalanced bracket until one closed — i.e. to the end
// of the file.
//
// The assertions are split so each of the two fixes is pinned by ITS OWN case:
//   (a) the CONTINUATION BOUND — a prose line costs the line it is on, never the file;
//   (b) the TIGHTENED `use` ARM — Rust's item shape, so the sentence never matched at all.
async function wave2ImportProseTest() {
  const C = await import('../src/extract/contracts.js');
  const TOK = 'GAME_STATE_PATH';
  const re = C.compileTokenRegexes([TOK]);
  const lines = (text) => { const out = []; C.scanTokenOccurrences(text, [TOK], re, (t, line) => out.push(line)); return out; };
  const finds = (text, line) => lines(text).includes(line);

  // (a) ONLY. The bare `import` arm is deliberately NOT tightened (see IMPORT_START_RE:
  // no rule separates `import os` from English without guessing), so this case can only
  // be fixed by bounding the region. The prose opens a `(` that never closes; the real
  // reference below it balances its own parens, so the region used to swallow it.
  const bareImportProse = [
    'def register():',
    '    """Wire up the plugins.',
    '',
    '    import the registration flow (described in docs/registration for the',
    '    full list of hooks.',
    '    """',
    '    return open(GAME_STATE_PATH)',
  ].join('\n');
  ok(finds(bareImportProse, 7),
    `w2b3(a): a prose line matching the bare "import" arm costs ONE line — the real reference below it is still found (got lines ${JSON.stringify(lines(bareImportProse))})`);

  // (b) ONLY. The token sits ON the prose line, so no bound can save it — the `use` arm
  // must not match "use the shared config …" in the first place.
  const useProseSameLine = [
    'def read_state():',
    '    """Load the world snapshot.',
    '',
    '    use the shared GAME_STATE_PATH config (see the notes in docs/state',
    '    """',
    '    return 1',
  ].join('\n');
  ok(finds(useProseSameLine, 4),
    `w2b3(b): an English sentence beginning "use " is not a Rust use-item, so a token ON it is still a reference (got lines ${JSON.stringify(lines(useProseSameLine))})`);

  // The reported end-to-end shape, in unit form: prose two lines above the real use.
  // Fixed by either half independently, which is why the two cases above exist.
  const useProseBelow = [
    'def read_state():',
    '    """Load the world snapshot.',
    '',
    '    use the shared config (see the notes in docs/state for the exact',
    '    """',
    '    with open(GAME_STATE_PATH) as f:',
    '        return f.read()',
  ].join('\n');
  ok(finds(useProseBelow, 6),
    `w2b3: …and the real use two lines below the prose is found (got lines ${JSON.stringify(lines(useProseBelow))})`);

  // A JS TEMPLATE LITERAL is code, not a comment — the ranges never covered it.
  const templateLiteral = [
    'const HELP = `',
    'use the shared config (see the notes',
    'for the exact layout',
    '`;',
    'export function read() { return readFileSync(GAME_STATE_PATH); }',
  ].join('\n');
  ok(finds(templateLiteral, 5),
    `w2b3: prose inside a JS template literal does not black out the code after it (got lines ${JSON.stringify(lines(templateLiteral))})`);

  // A SHELL-STYLE `#` comment. `#\s*(?:include|import)\s` fired on it; a real C include
  // always names its header in <> or "", which is what now separates the two.
  const shellComment = [
    '# import the registration flow GAME_STATE_PATH (the one in docs',
    '# it is the shared one',
    'STATE_FILE="$GAME_STATE_PATH"',
  ].join('\n');
  ok(finds(shellComment, 1),
    `w2b3: "# import the registration flow" is not an #include, so a token on it counts (got lines ${JSON.stringify(lines(shellComment))})`);
  ok(finds(shellComment, 3),
    `w2b3: …and the line below it is not suppressed either (got lines ${JSON.stringify(lines(shellComment))})`);

  // BOUND 2, the backstop cap. Text that really does end on an opener defeats bound 1,
  // and the cost of that must still be bounded. 45 continuation lines, then a real use.
  const runaway = ['export {', ...Array.from({ length: 45 }, (_, i) => `  name${i},`), 'const p = GAME_STATE_PATH;'].join('\n');
  ok(finds(runaway, 47),
    `w2b3: an import region is capped, so a never-closing bracket cannot suppress the rest of the file (got lines ${JSON.stringify(lines(runaway))})`);

  // …and NONE of this reopened what the suppression is for. Every real import form below
  // must still mint nothing.
  const suppressed = {
    'js single-line named import': "import { GAME_STATE_PATH } from './constants.js';",
    'js multi-line named import': "import {\n  GAME_STATE_PATH,\n  OTHER,\n} from './constants.js';",
    'python from-import': 'from constants import GAME_STATE_PATH',
    'python parenthesised from-import': 'from constants import (\n    GAME_STATE_PATH,\n)',
    'rust use item': 'use common::GAME_STATE_PATH;',
    'rust multi-line use tree': 'use common::{\n    GAME_STATE_PATH,\n    OTHER,\n};',
    'rust pub use with rename': 'pub use common::GAME_STATE_PATH as P;',
    'js re-export': "export { GAME_STATE_PATH } from './constants.js';",
    'commonjs require': "const { GAME_STATE_PATH } = require('./constants.js');",
  };
  for (const [label, text] of Object.entries(suppressed)) {
    eq(lines(text).length, 0, `w2b3: a real import is still suppressed — ${label}`);
  }
  // The multi-line forms are only suppressed because the region CONTINUES; assert the
  // continuation is genuinely doing work rather than the single opening line carrying it.
  eq(lines('import {\n  GAME_STATE_PATH,\n} from "./c.js";').length, 0,
    'w2b3: …and the continuation itself still works — the fix bounded it, it did not delete it');
}

// The reported end-to-end failure, verbatim in shape: TWO IDENTICAL Python readers of one
// resource, one of them carrying a docstring that begins "use the shared config (". The
// clean reader produced its REFERENCES and its RESOURCE edge; the other produced ZERO of
// both, and nothing anywhere said so — trace_contract called the resource SATISFIED
// because the other reader existed, so a declared participant left the graph in silence.
async function wave2ImportProseE2ETest() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-w2prose-')));
  for (const d of ['writer', 'clean', 'prose']) mkdirSync(join(work, d, '.git'), { recursive: true });

  writeFileSync(join(work, 'writer', 'state.py'),
    "GAME_STATE_PATH = '/var/run/game/state.json'\n\n\n"
    + 'def write_state(body):\n'
    + "    with open(GAME_STATE_PATH, 'w') as f:\n"
    + '        return f.write(body)\n');

  // The control. No prose, and it works today.
  writeFileSync(join(work, 'clean', 'read.py'),
    'from writer.state import GAME_STATE_PATH\n\n\n'
    + 'def read_clean():\n'
    + '    """Read the world snapshot."""\n'
    + '    with open(GAME_STATE_PATH) as f:\n'
    + '        return f.read()\n');

  // Byte-for-byte the same reader, plus four lines of ordinary docstring prose. A
  // docstring is an expression_statement, NOT a comment, so the comment ranges do not
  // cover it and the matcher sees the raw sentence.
  writeFileSync(join(work, 'prose', 'read.py'),
    'from writer.state import GAME_STATE_PATH\n\n\n'
    + 'def read_prose():\n'
    + '    """Read the world snapshot.\n\n'
    + '    use the shared config (see the notes in docs/state for the exact\n'
    + '    layout of every field.\n'
    + '    """\n'
    + '    with open(GAME_STATE_PATH) as f:\n'
    + '        return f.read()\n');

  mkdirSync(join(work, 'contracts'), { recursive: true });
  writeFileSync(join(work, 'contracts', 'game.resource.yaml'),
    'title: Game State Files\nresources:\n  - id: GAME_STATE_PATH\n    kind: path\n'
    + '    single_writer: true\n    writers: [writer]\n    readers: [clean, prose]\n');

  const db = join(work, '.wiregraph', 'graph.db');
  await runBuild({ target: work, project: work, db, reset: true });
  const c = connect(db, { readonly: true });
  const refComps = c.prepare(
    `SELECT DISTINCT s.compartment cc FROM edges e JOIN symbols s ON s.id=e.src
      WHERE e.project=? AND e.type='REFERENCES' AND e.token='GAME_STATE_PATH' ORDER BY cc`)
    .all(work).map((r) => r.cc);
  const resEdges = [...new Set(c.prepare(
    `SELECT sp.compartment sc, dp.compartment dc FROM edges e JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
      WHERE e.project=? AND e.type='RESOURCE'`).all(work).map((r) => `${r.sc}->${r.dc}`))].sort();
  c.close();

  ok(refComps.includes('clean'), `w2b3-e2e: the CLEAN reader references the resource (control) (got ${refComps.join(', ') || 'none'})`);
  ok(refComps.includes('prose'),
    `w2b3-e2e: …and so does the IDENTICAL reader whose docstring begins "use the shared config (" — prose does not delete a reference (got ${refComps.join(', ') || 'none'})`);
  eq(JSON.stringify(resEdges), JSON.stringify(['writer->clean', 'writer->prose']),
    `w2b3-e2e: BOTH declared readers get their RESOURCE edge — the seam is not silently half-built (got ${resEdges.join(', ') || 'none'})`);
}

// --- B4: a hand-written resource spec beats an inferred draft ------------------
// The duplicate-resource-id rule resolved by READ ORDER, and the machine-written draft is
// read first by construction (`apply` writes it into the outermost contracts home, and
// discovery is shallowest-first). Following commands/wiregraph-contracts.md verbatim on a
// repo with hand-written resource specs therefore stripped every id out of them, so their
// contract nodes were never created at all.
//
// Read order is the whole point, so it is pinned in BOTH directions: the same two specs,
// loaded draft-first and hand-written-first, must produce the identical answer.
async function wave2HandWrittenPrecedenceTest() {
  const C = await import('../src/extract/contracts.js');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-w2prec-')));
  const draftDir = join(work, 'inferred');
  const handDir = join(work, 'contracts');
  mkdirSync(draftDir, { recursive: true });
  mkdirSync(handDir, { recursive: true });

  // Exactly what synthesizeResourceSpec emits: the generated filename, the
  // x-wiregraph-inferred marker, and the all-both placeholder roles.
  writeFileSync(join(draftDir, 'wiregraph-inferred.resource.yaml'),
    'title: wiregraph-inferred-resources\nx-wiregraph-inferred: true\nresources:\n'
    + '  - id: WORLD_SNAPSHOT_CACHE_PATH\n    kind: path\n    semantics: presence-as-state\n'
    + '    writers: [world_state, netcli, netsrv]\n    readers: [world_state, netcli, netsrv]\n');
  // The user's own spec: a real writer/reader split and a declared discipline.
  writeFileSync(join(handDir, 'client-resources.resource.yaml'),
    'title: Client Shared Resources\nresources:\n'
    + '  - id: WORLD_SNAPSHOT_CACHE_PATH\n    kind: path\n    single_writer: true\n'
    + '    writers: [world_state]\n    readers: [netcli]\n');

  for (const [label, dirs] of [
    ['draft read FIRST (what apply actually produces)', [draftDir, handDir]],
    ['draft read LAST', [handDir, draftDir]],
  ]) {
    const logs = [];
    const g = new Graph(work);
    const merged = C.loadAllContracts(g, dirs, (m) => logs.push(m));
    const hand = merged.find((c) => c.name === 'Client Shared Resources');
    const draft = merged.find((c) => c.name === 'wiregraph-inferred-resources');
    ok(hand, `w2b4(a): the HAND-WRITTEN contract node exists — ${label}`);
    eq(JSON.stringify(hand?.tokens ?? []), JSON.stringify(['WORLD_SNAPSHOT_CACHE_PATH']),
      `w2b4(a): …and keeps its id — ${label}`);
    const roles = hand?.wireRoles?.get('WORLD_SNAPSHOT_CACHE_PATH');
    eq(JSON.stringify([...(roles?.producers ?? [])]), JSON.stringify(['world_state']),
      `w2b4(a): …with the user's real writer, not the draft's all-both placeholder — ${label}`);
    eq(JSON.stringify([...(roles?.consumers ?? [])]), JSON.stringify(['netcli']),
      `w2b4(a): …and the user's real reader — ${label}`);
    ok(String(hand?.direction?.WORLD_SNAPSHOT_CACHE_PATH).includes('single_writer=1'),
      `w2b4(a): …and the declared single_writer discipline survives — ${label}`);
    ok(!draft, `w2b4(a): the draft, having lost its only id to the human's spec, mints no competing node — ${label}`);
    ok(logs.some((l) => l.includes('HAND-WRITTEN spec always wins')),
      `w2b4(a): …and the loader says WHICH side won and why — ${label} (got: ${logs.join(' | ') || 'nothing'})`);
  }

  // Two HAND-WRITTEN specs colliding is a real ambiguity between two human declarations
  // and stays first-come, with the rename advice — the new rule must not swallow it.
  writeFileSync(join(handDir, 'zz-other.resource.yaml'),
    'title: Other Shared Resources\nresources:\n  - id: WORLD_SNAPSHOT_CACHE_PATH\n    kind: path\n'
    + '    writers: [netsrv]\n    readers: [sim]\n');
  const logs2 = [];
  const merged2 = C.loadAllContracts(new Graph(work), [handDir], (m) => logs2.push(m));
  ok(merged2.some((c) => c.name === 'Client Shared Resources'),
    'w2b4(a): two hand-written specs on one id — the first still wins');
  ok(logs2.some((l) => l.includes('Rename one of them')),
    `w2b4(a): …and the message is still the human-vs-human one (got: ${logs2.join(' | ') || 'nothing'})`);

  rmSync(work, { recursive: true, force: true });
}

// The collateral, end to end: with the draft owning the ids, the hand-written contracts
// were absent from the graph entirely (`trace_contract` answered "No contract matches"),
// the correct writer/reader roles were replaced by the symmetric placeholder, and the
// declared single_writer violation stopped being reported.
async function wave2HandWrittenPrecedenceE2ETest() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-w2prece2e-')));
  for (const d of ['world_state', 'netcli', 'netsrv']) mkdirSync(join(work, d, '.git'), { recursive: true });
  writeFileSync(join(work, 'world_state', 'cache.js'),
    "export const WORLD_SNAPSHOT_CACHE_PATH = '/var/run/game/snapshot.cache';\n"
    + 'export function writeSnapshot(b) { return writeFileSync(WORLD_SNAPSHOT_CACHE_PATH, b); }\n');
  writeFileSync(join(work, 'netcli', 'read.js'),
    "import { WORLD_SNAPSHOT_CACHE_PATH } from '../world_state/cache.js';\n"
    + 'export function readSnapshot() { return readFileSync(WORLD_SNAPSHOT_CACHE_PATH); }\n');
  writeFileSync(join(work, 'netsrv', 'peek.js'),
    "import { WORLD_SNAPSHOT_CACHE_PATH } from '../world_state/cache.js';\n"
    + 'export function peekSnapshot() { return statSync(WORLD_SNAPSHOT_CACHE_PATH); }\n');

  // `asyncapi/` and `contracts/` are BOTH contracts homes and children sort
  // asyncapi < contracts, so the draft is read first — the ordering `apply` creates.
  mkdirSync(join(work, 'asyncapi'), { recursive: true });
  mkdirSync(join(work, 'contracts'), { recursive: true });
  writeFileSync(join(work, 'asyncapi', 'wiregraph-inferred.resource.yaml'),
    'title: wiregraph-inferred-resources\nx-wiregraph-inferred: true\nresources:\n'
    + '  - id: WORLD_SNAPSHOT_CACHE_PATH\n    kind: path\n'
    + '    writers: [world_state, netcli, netsrv]\n    readers: [world_state, netcli, netsrv]\n');
  writeFileSync(join(work, 'contracts', 'client-resources.resource.yaml'),
    'title: Client Shared Resources\nresources:\n'
    + '  - id: WORLD_SNAPSHOT_CACHE_PATH\n    kind: path\n    single_writer: true\n'
    + '    writers: [world_state]\n    readers: [netcli]\n');

  const db = join(work, '.wiregraph', 'graph.db');
  await runBuild({ target: work, project: work, db, reset: true });
  const c = connect(db, { readonly: true });
  const trace = Q.traceContract(c, work, 'Client Shared Resources');
  const resEdges = [...new Set(c.prepare(
    `SELECT sp.compartment sc, dp.compartment dc FROM edges e JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
      WHERE e.project=? AND e.type='RESOURCE'`).all(work).map((r) => `${r.sc}->${r.dc}`))].sort();
  c.close();

  ok(!trace.includes('No contract matches'),
    `w2b4-e2e: the hand-written contract is IN the graph — the draft did not delete it (got:\n${trace})`);
  has(trace, 'WORLD_SNAPSHOT_CACHE_PATH', 'w2b4-e2e: …and reports on its resource');
  eq(JSON.stringify(resEdges), JSON.stringify(['world_state->netcli']),
    `w2b4-e2e: the seam is the DECLARED one, not the draft's symmetric cross product (got ${resEdges.join(', ') || 'none'})`);

  rmSync(work, { recursive: true, force: true });
}

// --- B4(b): inference must not re-propose what is already declared -------------
// The same defect from the other end. `scan` printed a repo's already-declared seams back
// as new proposals — contradicting its own "you already have hand-written contracts … so
// there is nothing left to infer" explainer — and `apply` then wrote them into a draft
// that competed with the very specs they were copied from.
async function wave2InferenceExcludesDeclaredTest() {
  const I = await import('../src/contracts/infer.js');
  const C = await import('../src/extract/contracts.js');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-w2excl-')));
  const dir = join(work, 'contracts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hand.asyncapi.yaml'),
    "asyncapi: 3.0.0\ninfo:\n  title: Hand Wire\n  version: '1.0.0'\n"
    + 'channels:\n  orders:\n    address: /orders/{orderId}/items\n');
  writeFileSync(join(dir, 'hand.resource.yaml'),
    'title: Hand Resources\nresources:\n  - id: LEDGER_STATE_PATH\n    kind: path\n'
    + '    writers: [alpha]\n    readers: [beta]\n');
  writeFileSync(join(dir, 'wiregraph-inferred.resource.yaml'),
    'title: wiregraph-inferred-resources\nx-wiregraph-inferred: true\nresources:\n'
    + '  - id: DRAFT_ONLY_PATH\n    kind: path\n    writers: [alpha]\n    readers: [beta]\n');

  const declared = C.handWrittenTokens([dir]);
  ok(declared.has('/orders/{orderId}/items'), 'w2b4(b): hand-written wire addresses are collected');
  ok(declared.has('LEDGER_STATE_PATH'), 'w2b4(b): …and hand-written resource ids');
  ok(!declared.has('DRAFT_ONLY_PATH'),
    "w2b4(b): …but NOT a generated draft's own ids — excluding those would freeze inference behind a stale draft forever");

  // The wire side. The declared route uses a DIFFERENT param name from the inferred one,
  // which is the same `{}`-canonical grouping clusterSeams already does — a declared route
  // must not escape the exclusion on a spelling.
  const wireCands = [
    { kind: 'wire', token: '/orders/:id/items', role: 'out', compartment: 'client', label: 'get' },
    { kind: 'wire', token: '/orders/{id}/items', role: 'in', compartment: 'server', label: 'get' },
    { kind: 'wire', token: '/undeclared/route/here', role: 'out', compartment: 'client', label: 'get' },
    { kind: 'wire', token: '/undeclared/route/here', role: 'in', compartment: 'server', label: 'get' },
  ];
  eq(I.clusterSeams(wireCands).length, 2, 'w2b4(b): both routes are seams with no exclusion set (control)');
  const wireRejected = [];
  const kept = I.clusterSeams(wireCands, { exclude: declared, rejected: wireRejected });
  eq(JSON.stringify(kept.map((s) => s.token)), JSON.stringify(['/undeclared/route/here']),
    `w2b4(b): the already-declared route is NOT re-proposed, param spelling notwithstanding (got ${kept.map((s) => s.token).join(', ') || 'none'})`);
  ok(wireRejected.some((r) => r.includes('already declared by a hand-written contract')),
    `w2b4(b): …and it is reported as declined, not dropped silently (got ${wireRejected.join(' | ') || 'nothing'})`);
  has(I.formatSeams(kept, wireRejected), 'already declared by a hand-written contract',
    'w2b4(b): …and the scan report actually prints that, so the explainer stops contradicting itself');

  // The resource side, through the real clusterer over a real tree.
  for (const d of ['alpha', 'beta']) mkdirSync(join(work, d, '.git'), { recursive: true });
  const body = (n) => `export const ${n} = '/var/run/x/${n.toLowerCase()}.json';\n`
    + `export function use_${n}() { return ${n}; }\n`;
  writeFileSync(join(work, 'alpha', 'a.js'), body('LEDGER_STATE_PATH') + body('OTHER_STATE_PATH'));
  writeFileSync(join(work, 'beta', 'b.js'), body('LEDGER_STATE_PATH') + body('OTHER_STATE_PATH'));
  const cands = I.extractCandidatesAcross([work]);
  const base = I.clusterResourceSeams(cands, [work]).map((s) => s.token).sort();
  eq(JSON.stringify(base), JSON.stringify(['LEDGER_STATE_PATH', 'OTHER_STATE_PATH']),
    `w2b4(b): both constants are resource seams with no exclusion set (control) (got ${base.join(', ') || 'none'})`);
  const resRejected = [];
  const resKept = I.clusterResourceSeams(cands, [work], { exclude: declared, rejected: resRejected }).map((s) => s.token);
  eq(JSON.stringify(resKept), JSON.stringify(['OTHER_STATE_PATH']),
    `w2b4(b): the already-declared resource id is NOT re-proposed (got ${resKept.join(', ') || 'none'})`);
  ok(resRejected.some((r) => r.startsWith('LEDGER_STATE_PATH: already declared')),
    `w2b4(b): …with a reason (got ${resRejected.join(' | ') || 'nothing'})`);

  rmSync(work, { recursive: true, force: true });
}

// End to end through the CLI, which is what the command file tells the user to run: a
// repo whose only seam is already declared by hand must scan to NOTHING, and `apply` must
// therefore not write a competing draft over it.
async function wave2ContractsCliExcludesDeclaredTest() {
  const CONTRACTS = join(HERE, '..', 'scripts', 'contracts.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-w2excli-')));
  for (const d of ['alpha', 'beta']) mkdirSync(join(work, d, '.git'), { recursive: true });
  const body = (n) => `export const ${n} = '/var/run/x/${n.toLowerCase()}.json';\n`
    + `export function use_${n}() { return ${n}; }\n`;
  writeFileSync(join(work, 'alpha', 'a.js'), body('LEDGER_STATE_PATH'));
  writeFileSync(join(work, 'beta', 'b.js'), body('LEDGER_STATE_PATH'));
  mkdirSync(join(work, 'contracts'), { recursive: true });
  writeFileSync(join(work, 'contracts', 'ledger.resource.yaml'),
    'title: Ledger State\nresources:\n  - id: LEDGER_STATE_PATH\n    kind: path\n    single_writer: true\n'
    + '    writers: [alpha]\n    readers: [beta]\n');

  const scan = await execFileP('node', [CONTRACTS, 'scan', work]);
  ok(!scan.stdout.includes('--- proposed RESOURCE contract'),
    `w2b4(b)-cli: a seam the user has already declared by hand is not re-proposed as a draft (got:\n${scan.stdout})`);
  has(scan.stdout, 'LEDGER_STATE_PATH: already declared by a hand-written resource contract',
    'w2b4(b)-cli: …and the scan says so by name rather than going quietly empty');

  await execFileP('node', [CONTRACTS, 'apply', work]);
  ok(!existsSync(join(work, 'contracts', 'wiregraph-inferred.resource.yaml')),
    'w2b4(b)-cli: …so apply writes no draft to compete with the spec it came from');
  eq(readFileSync(join(work, 'contracts', 'ledger.resource.yaml'), 'utf8').includes('single_writer: true'), true,
    "w2b4(b)-cli: …and the user's own spec is untouched");

  rmSync(work, { recursive: true, force: true });
}

// --- B6: AsyncAPI 2.x --------------------------------------------------------
// In 2.x the channel KEY is the address; 3.0 moved it to an `address:` field. Reading only
// the 3.0 shape made a whole 2.x spec load as ZERO channel tokens — while still producing
// a contract whose tokens were the payload FIELD names, which looked entirely healthy.
async function wave2AsyncApi2xTest() {
  const C = await import('../src/extract/contracts.js');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-w2v2-')));
  const dir = join(work, 'contracts');
  mkdirSync(dir, { recursive: true });

  const spec26 = "asyncapi: 2.6.0\ninfo:\n  title: Legacy Wire\n  version: '1.0.0'\nchannels:\n"
    + '  /player/session/refresh:\n'
    + '    x-wiregraph-producers: [netcli]\n    x-wiregraph-consumers: [netsrv]\n'
    + '    publish:\n      message:\n        payload:\n          type: object\n'
    + '          properties:\n            player_token:\n              type: string\n'
    + '  /world/snapshot/push:\n'
    + '    x-wiregraph-producers: [netsrv]\n    x-wiregraph-consumers: [world_state]\n'
    + '    subscribe:\n      message:\n        payload:\n          type: object\n'
    + '          properties:\n            entity_id:\n              type: string\n';
  writeFileSync(join(dir, 'legacy.asyncapi.yaml'), spec26);

  const logs = [];
  const merged = C.loadAllContracts(new Graph(work), [dir], (m) => logs.push(m));
  const legacy = merged.find((c) => c.name === 'Legacy Wire');
  ok(legacy, 'w2b6: the 2.6 spec loads as a contract');
  const toks = [...(legacy?.tokens ?? [])].sort();
  ok(toks.includes('/player/session/refresh'),
    `w2b6: the 2.x channel KEY is the address, so it becomes a matchable token (got ${toks.join(', ') || 'none'})`);
  ok(toks.includes('/world/snapshot/push'), 'w2b6: …for every channel, not just the first');
  ok(toks.includes('player_token') && toks.includes('entity_id'),
    'w2b6: …and the payload field names it always found are still there (this type is additive)');
  // Roles keyed on the SAME token the tokens list carries — the half that made a 2.x spec
  // produce roles for addresses that were never tokens.
  const roles = legacy?.wireRoles?.get('/player/session/refresh');
  eq(JSON.stringify([...(roles?.producers ?? [])]), JSON.stringify(['netcli']),
    'w2b6: x-wiregraph-producers is read off a 2.x channel');
  eq(JSON.stringify([...(roles?.consumers ?? [])]), JSON.stringify(['netsrv']),
    'w2b6: …and x-wiregraph-consumers');
  // 2.x publish/subscribe is the operation model. Server perspective, same as 3.0's
  // receive/send: publish = published TO the app (c2s), subscribe = the app sends (s2c).
  eq(legacy?.direction?.player_token, 'c2s', 'w2b6: a 2.x `publish` payload field classifies as c2s');
  eq(legacy?.direction?.entity_id, 's2c', 'w2b6: …and a `subscribe` one as s2c');

  // 3.0 is UNTOUCHED: a 3.0 channel KEY is an arbitrary id and must never become a token.
  writeFileSync(join(dir, 'modern.asyncapi.yaml'),
    "asyncapi: 3.0.0\ninfo:\n  title: Modern Wire\n  version: '1.0.0'\nchannels:\n"
    + '  some_channel_key:\n    address: /modern/route/here\n');
  const modern = C.loadAllContracts(new Graph(work), [dir], () => {}).find((c) => c.name === 'Modern Wire');
  ok(modern?.tokens.includes('/modern/route/here'), 'w2b6: a 3.0 address is still the token');
  ok(!modern?.tokens.includes('some_channel_key'),
    `w2b6: …and a 3.0 channel KEY is still NOT a token (got ${(modern?.tokens ?? []).join(', ')})`);

  // AN UNROOTED CHANNEL KEY is the idiomatic 2.x spelling, and reading it as a token is
  // worth nothing if the compiled matcher then demands a leading slash the source never
  // writes. The new boundary is a strict SUPERSET of the old literal '/', so a rooted
  // occurrence still matches and only unrooted ones are added.
  const unrooted = C.pathTokenRegex('player/session/updates');
  ok(unrooted.test("const ch = 'player/session/updates';"),
    'w2b6: an UNROOTED channel address matches the source that writes it unrooted');
  ok(unrooted.test("const ch = '/player/session/updates';"),
    'w2b6: …and the rooted spelling it always matched still matches (the boundary is a superset)');
  ok(!unrooted.test("const ch = 'xplayer/session/updates';"),
    'w2b6: …but not a longer identifier it is merely a suffix of');
  const rooted = C.pathTokenRegex('/orders/{id}/items');
  ok(rooted.test("fetch('/orders/12/items')") && !rooted.test("fetch('/orders/12/itemsFoo')"),
    'w2b6: …and a rooted path token is byte-for-byte the matcher it always was');

  // The silence was half the defect. A spec that yields nothing must say so, by name.
  const emptyLogs = [];
  const emptyDir = join(work, 'empty-contracts');
  mkdirSync(emptyDir, { recursive: true });
  writeFileSync(join(emptyDir, 'nothing.asyncapi.yaml'),
    "asyncapi: 2.0.0\ninfo:\n  title: Empty Wire\n  version: '1.0.0'\nchannels: {}\n");
  C.loadAllContracts(new Graph(work), [emptyDir], (m) => emptyLogs.push(m));
  ok(emptyLogs.some((l) => l.includes('NO matchable tokens') && l.includes('nothing.asyncapi.yaml')),
    `w2b6: a spec that defines no tokens is warned about BY NAME instead of loading silently (got ${emptyLogs.join(' | ') || 'nothing'})`);
  const futureLogs = [];
  const futureDir = join(work, 'future-contracts');
  mkdirSync(futureDir, { recursive: true });
  writeFileSync(join(futureDir, 'future.asyncapi.yaml'),
    "asyncapi: 4.1.0\ninfo:\n  title: Future Wire\n  version: '1.0.0'\nchannels:\n  x:\n    address: /future/route/here\n");
  C.loadAllContracts(new Graph(work), [futureDir], (m) => futureLogs.push(m));
  ok(futureLogs.some((l) => l.includes('wiregraph reads AsyncAPI 2.x and 3.x only')),
    `w2b6: …and an unsupported major version is named too (got ${futureLogs.join(' | ') || 'nothing'})`);
  ok(!logs.some((l) => l.includes('NO matchable tokens')),
    'w2b6: …while a WORKING 2.6 spec raises no warning at all');

  rmSync(work, { recursive: true, force: true });
}

// The same defect end to end, in GLOBAL mode — this was never recursive-specific. A 2.6
// spec with x-wiregraph-* roles reported `0 wire tokens`, `matched 0 contract REFERENCES
// edges`, and trace_contract found no contract at all.
async function wave2AsyncApi2xE2ETest() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-w2v2e2e-')));
  for (const d of ['netcli', 'netsrv']) mkdirSync(join(work, d, '.git'), { recursive: true });
  writeFileSync(join(work, 'netcli', 'client.js'),
    "export function refreshSession() { return fetch('/player/session/refresh'); }\n");
  writeFileSync(join(work, 'netsrv', 'server.js'),
    "export function onRefresh(app) { return app.post('/player/session/refresh', () => 1); }\n");
  mkdirSync(join(work, 'contracts'), { recursive: true });
  writeFileSync(join(work, 'contracts', 'legacy.asyncapi.yaml'),
    "asyncapi: 2.6.0\ninfo:\n  title: Legacy Wire\n  version: '1.0.0'\nchannels:\n"
    + '  /player/session/refresh:\n'
    + '    x-wiregraph-producers: [netcli]\n    x-wiregraph-consumers: [netsrv]\n'
    + '    publish:\n      message:\n        payload:\n          type: object\n'
    + '          properties:\n            player_token:\n              type: string\n');

  const db = join(work, '.wiregraph', 'graph.db');
  await runBuild({ target: work, project: work, db, reset: true });
  const c = connect(db, { readonly: true });
  const refs = [...new Set(c.prepare(
    `SELECT s.compartment cc FROM edges e JOIN symbols s ON s.id=e.src
      WHERE e.project=? AND e.type='REFERENCES' AND e.token='/player/session/refresh'`).all(work).map((r) => r.cc))].sort();
  const wire = c.prepare(
    `SELECT count(*) n FROM edges e JOIN symbols sp ON sp.id=e.src JOIN symbols dp ON dp.id=e.dst
      WHERE e.project=? AND e.type='WIRE' AND sp.compartment='netcli' AND dp.compartment='netsrv'`).get(work).n;
  const trace = Q.traceContract(c, work, 'Legacy Wire');
  c.close();

  eq(JSON.stringify(refs), JSON.stringify(['netcli', 'netsrv']),
    `w2b6-e2e: BOTH sides of the 2.6 channel mint REFERENCES (got ${refs.join(', ') || 'none'})`);
  ok(wire >= 1, `w2b6-e2e: …so the declared netcli -> netsrv seam derives a WIRE edge (got ${wire})`);
  ok(!trace.includes('No contract matches'), `w2b6-e2e: …and trace_contract finds the contract (got:\n${trace})`);
  has(trace, '/player/session/refresh', 'w2b6-e2e: …and reports on its channel');

  rmSync(work, { recursive: true, force: true });
}
// === WAVE 2 TESTS END ===

// === POLISH TESTS START ===

// --- F1: the post-edit hook must SHARE the partition resolution -----------------
// healPartitionDrift compares the compartment fingerprint and incrementalBuild then
// attributes against the same partition, one function call apart in the SAME process. The
// contracts half was threaded through the shared discoveryContext when the gate was
// written; the compartments half was not, so every save paid an extra full
// findCompartmentRoots walk of the tree (an INFERRED partition is fingerprinted now, so
// resolving it is a walk, not a state read). Two properties matter: the memo really is one
// resolution per root, and handing it to compartmentsFingerprint is TRANSPARENT — a shared
// value must not produce a different fingerprint from an unshared one, or the drift gate
// would start firing on its own optimisation.
async function polishSharedPartitionMemoTest() {
  const S = await import('../scripts/lib/state.mjs');
  const B = await import('../src/build.js');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-pmemo-')));
  const proj = join(work, 'engine');
  mkSourceTree(proj, ENGINE_SOURCES);
  mkdirSync(join(proj, 'server', 'ecs', '.git'), { recursive: true }); // a real inferred boundary

  const ctx = B.discoveryContext();
  const first = ctx.compartments(proj);
  ok(ctx.compartments(proj) === first, 'pmemo: discoveryContext resolves a root\'s partition ONCE per context (same object back)');

  let calls = 0;
  const counting = (r) => { calls++; return ctx.compartments(r); };
  const shared = S.compartmentsFingerprint(proj, { partitionOf: counting });
  eq(calls, 1, 'pmemo: compartmentsFingerprint asks the supplied partitionOf, once per root — it does not re-resolve behind it');
  eq(JSON.stringify(shared), JSON.stringify(S.compartmentsFingerprint(proj)),
    'pmemo: …and the shared value is IDENTICAL to the unshared one, so threading the memo cannot forge drift');
  eq(S.compartmentsDrift(shared, S.compartmentsFingerprint(proj)), null,
    'pmemo: …which is what keeps the gate quiet when nothing moved');

  // The hook really does thread it. This is the half no in-process assertion can reach:
  // refresh.mjs's gate runs in a detached child and healPartitionDrift is not exported, so
  // the only way to pin "the memo is passed" is the call site itself.
  const src = readFileSync(REFRESH, 'utf8');
  has(src, 'compartmentsFingerprint(g, { partitionOf: (r) => ctx.compartments(r) })',
    'pmemo: healPartitionDrift hands the shared context to the COMPARTMENTS fingerprint, as it already did for the contracts one');

  rmSync(work, { recursive: true, force: true });
}

// --- F3: the stamped seam count must exclude what the user already declared -----
// state.inferredSeams drives the SessionStart nudge and /wiregraph-status. It was stamped
// from clusterSeams/clusterResourceSeams with NO exclusion set, while /wiregraph-contracts
// passes the hand-written tokens — so a fully contracted project kept reporting seams to
// capture, and the number never matched what `scan` printed when the user followed the
// nudge.
async function polishInferredSeamsExcludeDeclaredTest() {
  const S = await import('../scripts/lib/state.mjs');
  const CONTRACTS = join(HERE, '..', 'scripts', 'contracts.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-pseam-')));
  for (const d of ['alpha', 'beta']) mkdirSync(join(work, d, '.git'), { recursive: true });
  // BOTH inferrable kinds, because the count sums both clusterers and each takes its own
  // exclusion set: a shared named constant (resource seam) and a shared route (wire seam).
  const body = (n, route) => `export const ${n} = '/var/run/x/${n.toLowerCase()}.json';\n`
    + `export function use_${n}() { return ${n}; }\n`
    + `export function call_${n}(app) { return app.get('${route}', () => 1); }\n`;
  const ROUTE = '/ledger/transfer/apply';
  writeFileSync(join(work, 'alpha', 'a.js'), body('LEDGER_STATE_PATH', ROUTE));
  writeFileSync(join(work, 'beta', 'b.js'), body('LEDGER_STATE_PATH', ROUTE));

  await runBuild({ target: work, project: work, reset: true });
  eq(S.readState(work).inferredSeams, 2,
    'pseam: with nothing declared, the full build stamps both inferrable seams — one wire, one resource (control)');

  // Now declare exactly those seams by hand — the state /wiregraph-contracts calls
  // "nothing left to infer".
  mkdirSync(join(work, 'contracts'), { recursive: true });
  writeFileSync(join(work, 'contracts', 'ledger.resource.yaml'),
    'title: Ledger State\nresources:\n  - id: LEDGER_STATE_PATH\n    kind: path\n'
    + '    writers: [alpha]\n    readers: [beta]\n');
  writeFileSync(join(work, 'contracts', 'ledger.asyncapi.yaml'),
    "asyncapi: 3.0.0\ninfo:\n  title: Ledger Wire\n  version: '1.0.0'\n"
    + `channels:\n  transfer:\n    address: ${ROUTE}\n`
    + '    x-wiregraph-producers: [alpha]\n    x-wiregraph-consumers: [beta]\n');

  await runBuild({ target: work, project: work, reset: true });
  eq(S.readState(work).inferredSeams, 0,
    'pseam: a seam the user has already written down is NOT counted as one still to infer — wire and resource alike');

  const scan = await execFileP('node', [CONTRACTS, 'scan', work]);
  ok(!scan.stdout.includes('--- proposed RESOURCE contract'),
    'pseam: …which is exactly what the CLI reports, so the stamped count and the scan agree');
  has(scan.stdout, 'already declared by a hand-written resource contract',
    'pseam: …and the CLI still names it as declined rather than going quietly empty');

  rmSync(work, { recursive: true, force: true });
}

// --- F4: the persisted content-dropping warnings must be RENDERED ---------------
// Wave 3 made refresh.mjs persist `lastBuildWarnings` for every build that DELETED graph
// content, and nothing read the key: graph_status reported "Fresh: no source changes" with
// no advisories while an entire spec's tokens were missing from the graph. Rendered from
// state.mjs for the same reason modeLine and statusAdvisories are — assertable without
// spinning up the stdio server, and one place the handler cannot drift from.
async function polishBuildWarningsRenderedTest() {
  const S = await import('../scripts/lib/state.mjs');
  eq(S.buildWarningLines(null).length, 0, 'pwarn: no state ⇒ no line');
  eq(S.buildWarningLines({}).length, 0, 'pwarn: a project that never recorded a warning ⇒ no line');
  eq(S.buildWarningLines({ lastBuildWarnings: { at: 'T', kind: 'full', items: [] } }).length, 0,
    'pwarn: a CLEAN full rebuild (items: []) is an assertion that nothing was dropped, not a finding to print');

  const one = S.buildWarningLines({
    lastBuildWarnings: { at: '2026-01-01T00:00:00.000Z', kind: 'full', items: ['⚠ contract title collision ACROSS SCOPES: SKIPPING inner.asyncapi.yaml'] },
  });
  has(one.join('\n'), 'LAST BUILD DROPPED GRAPH CONTENT', 'pwarn: a recorded warning is surfaced');
  has(one.join('\n'), 'contract title collision ACROSS SCOPES', 'pwarn: …quoting what was actually dropped, not a generic "something"');
  has(one.join('\n'), '2026-01-01T00:00:00.000Z', 'pwarn: …with when');
  has(one.join('\n'), 'full build', 'pwarn: …and which kind of build recorded it');
  has(one.join('\n'), '/wiregraph-rebuild', 'pwarn: …and the remedy');

  const many = S.buildWarningLines({
    lastBuildWarnings: { at: 'T', kind: 'incremental', items: Array.from({ length: 9 }, (_, i) => `⚠ dropped thing ${i}`) },
  });
  eq(many.length, 7, 'pwarn: a long list is capped (header + 5 + "and N more"), because refresh.log already has all of it');
  has(many.join('\n'), 'and 4 more', 'pwarn: …and says how many it withheld');

  // The handler must actually call it — the half no state-level assertion can reach.
  has(readFileSync(join(HERE, '..', 'src', 'mcp', 'server.js'), 'utf8'), 'lines.push(...buildWarningLines(state));',
    'pwarn: graph_status renders it alongside its Posture:/Mode: lines');
}

// --- F6: a project COPY is not a project MOVE ----------------------------------
// loadState rebinds state.project to the directory it read from. Right for a move; on
// `cp -a proj proj2` it silently adopts the ORIGINAL's graph, baseline shas and
// fingerprints — all of which still MATCH, because ids are project-free and the
// fingerprints hash content under a project-relative key. Both halves are pinned here:
// the copy must be caught, and the move must keep working.
async function polishProjectCopyTest() {
  const S = await import('../scripts/lib/state.mjs');
  const G = await import('../scripts/lib/git.mjs');

  // --- COPY ---------------------------------------------------------------------
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-pcopy-')));
  const a = join(work, 'proj-a');
  mkSourceTree(a, ENGINE_SOURCES);
  await runBuild({ target: a, project: a, reset: true });
  const stampedA = S.readState(a).compartmentsFingerprint;
  ok(!String(stampedA['.']).startsWith('copied-from:'), 'pcopy: the ORIGINAL is never flagged as a copy of itself');

  const b = join(work, 'proj-b');
  cpSync(a, b, { recursive: true }); // carries .wiregraph/ — graph.db, shas, both fingerprints
  const stB = S.readState(b);
  eq(stB.project, b, 'pcopy: the copy still rebinds its own root (the rename self-heal is intact)');
  has(String(stB.compartmentsFingerprint['.']), `copied-from:${a}`,
    'pcopy: …but the copied baseline is marked as the ORIGINAL project\'s, naming where it came from');
  ok(S.compartmentsDrift(stB.compartmentsFingerprint, S.compartmentsFingerprint(b)) !== null,
    'pcopy: …so the partition guard reads the copied graph as not matching this project');

  // No .git anywhere in this tree, so the reposLastSha route says nothing — the escalation
  // has to come from the partition guard, which is why the copy is marked there.
  eq(G.changedSince(b, S.readState(b).reposLastSha || {}).fullBuildNeeded, true,
    'pcopy: the catch-up escalates to a full rebuild even with no git repo to notice');
  let refused = null;
  try { await runBuild({ target: b, project: b, files: [join(b, 'server', 'ecs', 'ecs.js')] }); }
  catch (e) { refused = e.message; }
  ok(refused !== null, 'pcopy: and every incremental entry point is REFUSED rather than re-indexing into a foreign graph');
  has(refused, 'full rebuild', 'pcopy: …naming the fix');

  // The full rebuild is the remedy, and it clears the mark for good.
  await runBuild({ target: b, project: b, reset: true });
  const healed = S.readState(b).compartmentsFingerprint;
  ok(!String(healed['.']).startsWith('copied-from:'), 'pcopy: a full rebuild restamps the baseline as this project\'s own');
  eq(S.compartmentsDrift(healed, S.compartmentsFingerprint(b)), null, 'pcopy: …so the guard goes quiet');
  await runBuild({ target: b, project: b, files: [join(b, 'server', 'ecs', 'ecs.js')] });
  ok(!String(S.readState(b).compartmentsFingerprint['.']).startsWith('copied-from:'),
    'pcopy: …and ordinary incremental saves work again, permanently (the mark does not come back)');

  // --- MOVE (the case that must NOT change) ---------------------------------------
  const c = join(work, 'proj-c');
  renameSync(a, c); // the old path is GONE — this is a move, not a copy
  const stC = S.readState(c);
  eq(stC.project, c, 'pmove: a moved project rebinds to its new root exactly as before');
  ok(!String(stC.compartmentsFingerprint['.']).startsWith('copied-from:'),
    'pmove: …and is NOT flagged as a copy — the old path no longer holds a wiregraph state file');
  // A MOVE IS NOT A COPY — and it is not a NO-OP either. ENGINE_SOURCES has no manifest
  // anywhere, so every file is attributed to basename(root) (walk.js#compartmentNameFor),
  // and the move renames that compartment for every id in the graph. The two conditions
  // are DIFFERENT and both must be visible: the copy is caught by the poison, the move by
  // the partition value itself. This used to assert "nothing escalates", which held only
  // because neither partition value carried the root fallback name — and one save after a
  // move then left every symbol under both the old and the new compartment.
  const moveDrift = S.compartmentsDrift(stC.compartmentsFingerprint, S.compartmentsFingerprint(c));
  ok(moveDrift !== null, 'pmove: …the move re-partitions every root-attributed id, so the guard sees it');
  // Stringified, not dereferenced: on a regression moveDrift is null, and a TypeError here
  // would kill the runner before it printed its totals.
  ok(!String(moveDrift).includes('copied-from:'), 'pmove: …as an ordinary partition change, NOT as a copy');

  // A directory left behind at the old path is only a copy if it is itself a wiregraph
  // project — `mv proj proj2 && mkdir proj` (or a fresh clone, or a new checkout, into the
  // vacated path) is still a move. Asserted BEFORE the incremental below, deliberately:
  // that incremental persists the rebound project, after which no signal is consulted at
  // all and this could not distinguish anything.
  mkdirSync(a, { recursive: true });
  ok(!String(S.readState(c).compartmentsFingerprint['.']).startsWith('copied-from:'),
    'pmove: a bare directory at the old path is not a wiregraph project, so the move stays a move');
  ok(!String(S.compartmentsDrift(S.readState(c).compartmentsFingerprint, S.compartmentsFingerprint(c))).includes('copied-from:'),
    'pmove: …and nothing extra escalates on account of it — the drift is still just the move');

  // Caught rather than left to throw: a regression here must read as ONE failing assertion,
  // not as an unhandled rejection that kills the runner before it prints its totals.
  let moveRefused = null;
  try { await runBuild({ target: c, project: c, files: [join(c, 'server', 'ecs', 'ecs.js')] }); }
  catch (e) { moveRefused = e.message; }
  ok(moveRefused !== null, 'pmove: an incremental after a move is REFUSED (the compartment every id lives in was renamed)');
  has(moveRefused, 'full rebuild', 'pmove: …naming the fix');

  // …and the rebuild converges on exactly what a from-scratch build of the moved tree
  // produces — one row per symbol, under the new root name, with no ghost of the old one.
  await runBuild({ target: c, project: c, reset: true });
  eq(symbolPartitionOf(join(c, '.wiregraph', 'graph.db')), await fromScratchPartition(c),
    'pmove: …after which the graph matches a from-scratch rebuild exactly');
  let healedSave = null;
  try { await runBuild({ target: c, project: c, files: [join(c, 'server', 'ecs', 'ecs.js')] }); }
  catch (e) { healedSave = e.message; }
  eq(healedSave, null, 'pmove: …and ordinary saves are accepted again');

  rmSync(work, { recursive: true, force: true });
}
// === POLISH TESTS END ===

// === BLOCKER TESTS START ===
// Four more blockers, each reproduced end-to-end before it was fixed. The first and the
// last are §14's lesson recurring for a third and fourth time: FINGERPRINT (or read) THE
// THING THAT DETERMINES THE PARTITION, NOT THE THING THAT CONTAINS IT.

// --- THE ROOT FALLBACK COMPARTMENT NAME WAS IN NEITHER PARTITION VALUE ----------
// Every file that sits under NO compartment boundary is attributed to basename(rootDir)
// (src/extract/walk.js#compartmentNameFor), and that name is embedded in the id of every
// such symbol. Neither branch of compartmentPartition carried it: the declared branch
// hashed only the declared pairs, and the inferred branch carried it ONLY when the root
// was itself a boundary — which is why every existing test missed it, since their fixtures
// either put a manifest at the top level or put every file inside a sub-compartment.
//
// The shape below is the one that hides it completely: a sub-compartment that is
// rename-stable (its path is hashed RELATIVE, so `sub` stays `sub`) plus one file
// attributed to the root. The move then changes NOTHING the old hash could see, while
// re-partitioning every id in the root compartment.
//
// Driven through the REAL post-edit worker, and with no `.git` anywhere: for a git repo at
// the root the next SessionStart escalates on "new repo" and the corruption lasts only a
// session, which is exactly what hid this. With no git it NEVER self-heals.
async function rootFallbackPartitionTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-rootfp-')));
  const proj = join(work, 'R2');
  mkSourceTree(proj, {
    'tools/t.js': 'export function toolFn(){ return 1; }\n',
    'sub/s.js': 'export function subFn(){ return 2; }\n',
  });
  writeFileSync(join(proj, 'sub', 'package.json'), JSON.stringify({ name: 'sub' }) + '\n');
  await runBuild({ target: proj, project: proj, reset: true });
  ok(!existsSync(join(proj, '.git')), 'rootfp: no git anywhere — nothing else can escalate, so the guard is the only thing standing here');

  const before = S.readState(proj).compartmentsFingerprint;
  const moved = join(work, 'R2b');
  renameSync(proj, moved);

  // The sub-compartment is rename-stable by construction; the ROOT fallback name is not,
  // and it is the whole of what moved.
  ok(S.compartmentsDrift(before, S.compartmentsFingerprint([moved])) !== null,
    'rootfp: the move IS a partition change — the compartment every root-attributed file lives in was renamed');

  const env = { ...process.env, CLAUDE_PROJECT_DIR: moved };
  const edited = join(moved, 'tools', 't.js');
  appendFileSync(edited, '\nexport function toolTail(){ return 3; }\n');
  await execFileP(process.execPath, [REFRESH, '--files', edited], { env });

  const log = readFileSync(join(moved, '.wiregraph', 'refresh.log'), 'utf8');
  has(log, 'escalating to full rebuild (compartment partition changed',
    'rootfp: the post-edit worker ESCALATES instead of logging a clean "reindexed 1 explicit file(s)"');

  const dbPath = join(moved, '.wiregraph', 'graph.db');
  const c = connect(dbPath, { readonly: true });
  const toolRows = c.prepare("SELECT compartment, file FROM symbols WHERE name='toolFn' ORDER BY compartment").all()
    .map((r) => `${r.compartment}:${r.file}`);
  c.close();
  eq(JSON.stringify(toolRows), JSON.stringify(['R2b:tools/t.js']),
    'rootfp: toolFn exists exactly ONCE — the wedge left it under BOTH R2 and R2b, with no warning and no self-heal');
  eq(symbolPartitionOf(dbPath), await fromScratchPartition(moved),
    'rootfp: …and the healed graph matches a from-scratch rebuild exactly');
}

// --- hooklog BRICKED EVERY LEGACY `.codegraph` PROJECT --------------------------
// wiregraphDir() adopts an existing `.codegraph/` in place, so a project indexed before
// the rename keeps working. hooklog.mjs built `join(project, '.wiregraph', …)` BY HAND and
// then MKDIRS it — so one hook fire created `.wiregraph/` and flipped the shim. After that
// readState looked in the empty new folder and returned null forever: "no state file —
// project not initialized; skipping", a db path that does not exist (MCP: NOT_BUILT), and
// the next updateState writing a fresh default over the lot. Self-heal: never.
async function legacyCodegraphHookLogTest() {
  const S = await import('../scripts/lib/state.mjs');
  const HL = await import('../scripts/lib/hooklog.mjs');
  const { closeSync } = await import('node:fs');
  const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cg-legacydir-')));
  writeFileSync(join(proj, 'a.js'), 'export function aFn(){ return 1; }\n');

  // A project as it exists on disk after the rename: state and graph under `.codegraph/`.
  mkdirSync(join(proj, '.codegraph'), { recursive: true });
  writeFileSync(join(proj, '.codegraph', 'state.json'), JSON.stringify({
    project: proj, indexedRoots: [proj], links: [{ root: '/somewhere/peer', peer: '/somewhere/peer' }],
    reposLastSha: { [proj]: 'deadbeef' }, autoUpdate: 'aggressive',
    compartmentsFingerprint: { '.': 'g1:1111111111111111' },
  }, null, 2));
  eq(S.wiregraphDir(proj), join(proj, '.codegraph'), 'legacydir: the shim adopts the legacy folder to begin with');

  eq(HL.refreshErrLogPath(proj), join(proj, '.codegraph', 'refresh.err.log'),
    'legacydir: the raw-stderr log goes THROUGH wiregraphDir — into the folder the project actually uses');
  const fd = HL.openRefreshErrFd(proj);
  ok(fd !== null, 'legacydir: …and it really is openable there');
  if (fd !== null) closeSync(fd);

  ok(!existsSync(join(proj, '.wiregraph')),
    'legacydir: opening it did NOT create .wiregraph/ — creating it is what flipped the shim');
  eq(S.wiregraphDir(proj), join(proj, '.codegraph'), 'legacydir: …so the shim still points at the legacy folder');
  // Defaulted, not dereferenced: the bug's whole signature is readState returning null, and
  // a TypeError here would kill the runner before it printed its totals.
  const st = S.readState(proj) || {};
  ok(!!S.readState(proj), 'legacydir: …and readState still finds the state file, instead of returning null forever');
  eq(st.autoUpdate, 'aggressive', 'legacydir: …with the posture intact');
  eq((st.links || []).length, 1, 'legacydir: …the links intact');
  eq(JSON.stringify(st.compartmentsFingerprint), JSON.stringify({ '.': 'g1:1111111111111111' }),
    'legacydir: …and the partition baseline intact, rather than orphaned behind a fresh default');

  rmSync(proj, { recursive: true, force: true });
}

// --- AN UNMOUNTED LINKED MEMBER MADE EVERY INCREMENTAL THROW --------------------
// memberRoots drops a vanished linked root (with a warning) and both fingerprint maps drop
// its key. graphsListing — the reverse index reindexFiles fans out over — did NOT:
// realpathish RETURNS THE PATH UNCHANGED when realpath fails, so the dead peer arrived as
// an ordinary target and runBuild's `realpathSync(o.project)` threw
// `ENOENT … lstat '<peer>'` — AFTER the edit had already been applied to the other graphs,
// with the shas never restamped. The project then stopped indexing until the peer came
// back. Reachable by `rm -rf` on a peer instead of /wiregraph-unlink, or an external drive.
async function unmountedMemberFanOutTest() {
  const S = await import('../scripts/lib/state.mjs');
  const { reindexFiles } = await import('../src/build.js');
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'cg-unmounted-')));
  const A = join(ws, 'ln_A'); const C = join(ws, 'ln_C');
  for (const [d, f, body] of [[A, 'a.js', 'export function aFn(){ return 1; }\n'], [C, 'c.js', 'export function cFn(){ return 2; }\n']]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, f), body);
  }
  S.addLink(A, { root: C, peer: C, initiator: A });
  S.addLink(C, { root: A, peer: A, initiator: A });
  await runBuild({ target: A, project: A, reset: true });
  await runBuild({ target: C, project: C, reset: true });
  ok(S.graphsListing(A).includes(C), 'unmounted: while it is mounted, the peer really is in the fan-out set');

  rmSync(C, { recursive: true, force: true }); // `rm -rf` instead of /wiregraph-unlink

  ok(!S.graphsListing(A).includes(C), 'unmounted: a vanished peer is dropped from the reverse index, exactly as memberRoots drops it');
  const edited = join(A, 'a.js');
  appendFileSync(edited, 'export function aTail(){ return 9; }\n');
  let threw = null;
  let rebuilt = [];
  try { rebuilt = await reindexFiles([edited], A, { fanOut: true }); } catch (e) { threw = e.message; }
  eq(threw, null, 'unmounted: the incremental COMPLETES instead of throwing ENOENT out of the fan-out');
  eq(JSON.stringify(rebuilt), JSON.stringify([A]), 'unmounted: …into the graphs that still exist, and only those');
  const c = connect(join(A, '.wiregraph', 'graph.db'), { readonly: true });
  const n = c.prepare("SELECT count(*) n FROM symbols WHERE name='aTail'").get().n;
  c.close();
  eq(n, 1, 'unmounted: …and the edit really is indexed, instead of the project silently freezing until the peer returns');

  rmSync(ws, { recursive: true, force: true });
}

// --- validateResourceRoles FIRED A FALSE WARNING ON EVERY ORDINARY SAVE ---------
// Its `known` set came from `graph.compartments`, which on the `--files` path holds ONLY
// the compartments of the EDITED files. Its own comment ("by the time contracts load the
// graph already knows every compartment name") is true of a full build and false of an
// incremental. So one save of an unrelated file made graph_status assert, of a correct
// spec over a correct graph, that a real compartment "does not exist in this graph" and
// that the known set was a single name — while the `Mode:` line two lines above it named
// them both. It re-armed on every save and cleared only on a full rebuild.
async function resourceRoleScopeTest() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-rolescope-')));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: work };
  mkSourceTree(work, {
    'svc_a/a.js': "import { writeFileSync } from 'node:fs';\nexport const GAME_STATE_PATH = '/tmp/gs.json';\nexport function aWrite(){ writeFileSync(GAME_STATE_PATH, '1'); }\n",
    'svc_b/b.js': "import { readFileSync } from 'node:fs';\nexport const GAME_STATE_PATH = '/tmp/gs.json';\nexport function bRead(){ return readFileSync(GAME_STATE_PATH); }\n",
  });
  writeFileSync(join(work, 'svc_a', 'package.json'), JSON.stringify({ name: 'svc_a' }) + '\n');
  writeFileSync(join(work, 'svc_b', 'package.json'), JSON.stringify({ name: 'svc_b' }) + '\n');
  const spec = (readers) => [
    'title: game-state-files', 'resources:', '  - id: GAME_STATE_PATH', '    kind: path',
    '    semantics: last-writer-wins', '    writers: [svc_a]', `    readers: [${readers}]`, '',
  ].join('\n');
  mkSourceTree(work, { 'contracts/res.resource.yaml': spec('svc_b') });

  const NOISE = 'do not exist in this graph';
  const full = await execFileP(process.execPath, [REFRESH, '--full'], { env });
  ok(!full.stderr.includes(NOISE), 'rolescope: a full build of a correct spec over a correct graph says nothing (the control)');

  const edited = join(work, 'svc_a', 'a.js');
  appendFileSync(edited, '\nexport function aTail(){ return 1; }\n');
  const inc = await execFileP(process.execPath, [REFRESH, '--files', edited], { env });
  ok(!inc.stderr.includes(NOISE),
    'rolescope: ONE ordinary save of an unrelated-to-the-seam file no longer claims a real compartment does not exist');
  ok(!readFileSync(join(work, '.wiregraph', 'refresh.log'), 'utf8').includes(NOISE),
    'rolescope: …so nothing re-arms the "graph content dropped" banner graph_status renders on every save');

  // …and the check is still LIVE on that path: a genuinely misspelled name still warns.
  // (Edited then full-rebuilt, because moving the spec set is itself a refusal condition.)
  writeFileSync(join(work, 'contracts', 'res.resource.yaml'), spec('svc_typo'));
  const full2 = await execFileP(process.execPath, [REFRESH, '--full'], { env });
  has(full2.stderr, NOISE, 'rolescope: a real misspelling still warns on a full build');
  appendFileSync(edited, '\nexport function aTail2(){ return 2; }\n');
  const inc2 = await execFileP(process.execPath, [REFRESH, '--files', edited], { env });
  has(inc2.stderr, 'svc_typo',
    'rolescope: …and on an incremental too — the fix scoped the KNOWN SET, it did not switch the check off');

  rmSync(work, { recursive: true, force: true });
}
// === BLOCKER TESTS END ===

// === DEFERRED-3 TESTS START ===
// Eleven REPORTING / FAIL-SAFE defects, each reproduced before it was fixed. The theme is
// one failure mode wearing eleven hats: the tool KNEW the right answer and said something
// else — a false alarm, a stale snapshot captioned as current, a truncated payload, a
// notice filed as data loss, a guard that disarmed itself on junk, and a count that
// disagreed with the tool next to it.

// --- R1 — FALSE DRIFT ON THE CANONICAL RECURSIVE LAYOUT -------------------------
// The shadow note covered `one-sided` and NOT `unreferenced`. When a NARROWER contract takes
// BOTH halves of a token the outer contract's copy has zero references, so it landed in
// `unreferenced` and printed `🔴 unreferenced — … NO code references it (code has drifted off
// the contract…)` plus the 🔴 DRIFT flag — the tool's strongest signal — while grep finds the
// token in six places and the db holds six REFERENCES rows for it, every one attributed to
// the inner contract. Fired falsely on exactly the nested layout recursive mode exists for.
async function d3ShadowedNotDriftTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-d3r1-'));
  const root = nestedProject(work);
  const db = join(work, 'graph.db');
  const add = (rel, body) => appendFileSync(join(root, rel), body);

  // A token BOTH specs declare, whose producer AND consumer both live under server/ — so
  // longest-prefix scoping gives every reference to the INNER contract and the outer one
  // sees none at all. This is the FULLY shadowed case; /api/state (already in the fixture)
  // is the half-shadowed one the old note covered.
  const chan = '  innerOnly:\n    address: /api/inner_only\n'
    + '    x-wiregraph-producers: [sim]\n    x-wiregraph-consumers: [netsrv]\n';
  add('contracts/outer.asyncapi.yaml', chan);
  add('server/contracts/inner.asyncapi.yaml', chan);
  add('server/sim/sim.js', "\nexport function pushInnerOnly() { return '/api/inner_only'; }\n");
  add('server/netsrv/net.js', "\nexport function handleInnerOnly() { return '/api/inner_only'; }\n");
  // …and a token NOBODY implements anywhere, so the REAL drift signal has to survive intact.
  add('contracts/outer.asyncapi.yaml',
    '  ghost:\n    address: /api/ghost_route\n    x-wiregraph-producers: [netcli]\n    x-wiregraph-consumers: [netsrv]\n');

  await runBuild({ target: root, project: root, db, reset: true });
  const conn = connect(db, { readonly: true });
  const outer = Q.traceContract(conn, root, 'Nested Outer Wire', null, false);
  const lineFor = (tok) => outer.split('\n').find((l) => l.includes(tok)) || '';

  // The db really does hold the references, under the inner contract — i.e. the tool had the
  // answer in hand while reporting the opposite.
  const m = refMap(conn, root);
  eq(refsFor(m, 'Server Inner Wire|/api/inner_only'), JSON.stringify(['netsrv', 'sim']),
    'd3r1: the REFERENCES rows exist and are attributed to the INNER contract');
  eq(refsFor(m, 'Nested Outer Wire|/api/inner_only'), JSON.stringify([]),
    'd3r1: …and the outer contract genuinely has none of its own — the input to the verdict is not in dispute');

  ok(!lineFor('/api/inner_only').includes('unreferenced'),
    'd3r1: a FULLY shadowed token is no longer reported as unreferenced');
  has(lineFor('/api/inner_only'), 'NOT DRIFT',
    'd3r1: …it says so in as many words, so an agent does not go looking for a handler that was never missing');
  has(lineFor('/api/inner_only'), '"Server Inner Wire"',
    'd3r1: …and NAMES the narrower contract that governs it');
  has(lineFor('/api/inner_only'), 'netsrv, sim',
    'd3r1: …and the compartments holding it, so the reader can go straight there');

  // THE VERDICT CHANGED, not just the wording: a fully shadowed token is not drift, so the
  // header must not claim one and must not raise the DRIFT flag on its account.
  const header = outer.split('\n')[0];
  has(header, '1 shadowed by a narrower contract', 'd3r1: the header counts it as SHADOWED');
  ok(!header.includes('0 unreferenced'), 'd3r1: …and the fixture still has one GENUINELY unreferenced token, so this is not vacuous');
  has(header, '1 unreferenced', 'd3r1: exactly one — the ghost route, not the shadowed one');
  has(header, '🔴 DRIFT', 'd3r1: DRIFT still fires, because /api/ghost_route really is drift');
  has(lineFor('/api/ghost_route'), '/api/ghost_route', 'd3r1: …and the ghost route is the token named under it');

  // Now REMOVE the genuine drift: with only the shadowed token left, the flag must go
  // silent. This is the assertion the fix is FOR — the false alarm on a healthy graph.
  const spec = join(root, 'contracts', 'outer.asyncapi.yaml');
  writeFileSync(spec, readFileSync(spec, 'utf8').replace(
    '  ghost:\n    address: /api/ghost_route\n    x-wiregraph-producers: [netcli]\n    x-wiregraph-consumers: [netsrv]\n', ''));
  conn.close();
  await runBuild({ target: root, project: root, db, reset: true });
  const conn2 = connect(db, { readonly: true });
  const clean = Q.traceContract(conn2, root, 'Nested Outer Wire', null, false);
  ok(!clean.includes('🔴 DRIFT'),
    'd3r1: with only a shadowed token left, the strongest signal the tool has is SILENT — no false alarm on the canonical nested layout');
  has(clean.split('\n')[0], '0 unreferenced', 'd3r1: …and nothing is counted as unreferenced');
  conn2.close();

  rmSync(work, { recursive: true, force: true });
}

// --- R1b — THE VERDICT REUSES THE STRICT-DESCENDANT GATE, NOT A SECOND MECHANISM -
// The same trap traceShadowedSiblingTest locks down for the one-sided note applies with more
// force here, because this branch CHANGES THE VERDICT: a DISJOINT SIBLING scope declaring the
// same token would otherwise turn a genuinely undiscovered token into "nothing to fix".
async function d3ShadowedVerdictSiblingGateTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-d3r1b-'));
  const root = nestedProject(work);
  const db = join(work, 'graph.db');
  const add = (rel, body) => appendFileSync(join(root, rel), body);

  // client/ and server/ are DISJOINT siblings. Both declare /sib/only; only the server side
  // implements it. The client contract therefore has zero references for it — genuinely
  // unreferenced, because server/ took nothing from client/.
  const chan = (p, c) => `  sibOnly:\n    address: /sib/only\n    x-wiregraph-producers: [${p}]\n    x-wiregraph-consumers: [${c}]\n`;
  add('client/contracts/client.asyncapi.yaml', chan('netcli', 'world_state'));
  add('server/contracts/inner.asyncapi.yaml', chan('netsrv', 'sim'));
  add('server/netsrv/net.js', "\nexport function sibWrite() { return '/sib/only'; }\n");
  add('server/sim/sim.js', "\nexport function sibRead() { return '/sib/only'; }\n");

  await runBuild({ target: root, project: root, db, reset: true });
  const conn = connect(db, { readonly: true });
  const client = Q.traceContract(conn, root, 'Client Inner Wire', null, false);
  const line = client.split('\n').find((l) => l.trim().startsWith('/sib/only')) || '';
  ok(line, 'd3r1b: the client contract does report on /sib/only');
  ok(!line.includes('NOT DRIFT'),
    'd3r1b: a DISJOINT SIBLING scope earns NO reassurance — the structural gate is the SAME strict-descendant test the one-sided note uses');
  has(client, '🔴 DRIFT', 'd3r1b: …so a genuinely unreferenced token still raises DRIFT');
  has(client.split('\n')[0], '1 unreferenced', 'd3r1b: …and is still counted as unreferenced');
  conn.close();

  rmSync(work, { recursive: true, force: true });
}

// --- R2 — lastBuildWarnings WAS WRITTEN ONLY BY THE HOOK ------------------------
// Three failures at once. (1) Only scripts/hooks/refresh.mjs installed the capture, so
// `update_graph {full:true}` and `node src/build.js --reset` recorded NOTHING and
// graph_status displayed a DIFFERENT, OLDER build's warnings captioned as current. (2) A
// full rebuild did not CLEAR it, so the prescribed remedy ("fix the cause, then
// /wiregraph-rebuild") left the block unchanged and the agent looped. (3) A noisy
// incremental OVERWROTE the full build's accurate snapshot with its own partial list.
async function d3BuildWarningsEveryPathTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d3r2-')));
  const root = nestedProject(work);
  const dupe = join(root, 'client', 'contracts', 'dupe.asyncapi.yaml');
  const writeDupe = () => writeFileSync(dupe, [
    'asyncapi: 3.0.0', 'info:', '  title: Server Inner Wire', '  version: 1.0.0',
    'channels:', '  x:', '    address: /client/only',
    '    x-wiregraph-producers: [netcli]', '    x-wiregraph-consumers: [world_state]', '',
  ].join('\n'));

  // (1) A PLAIN runBuild — no hook anywhere. This is what update_graph {full:true} and
  // /wiregraph-init's `node src/build.js --reset` actually run.
  writeDupe();
  await runBuild({ target: root, project: root, reset: true });
  const full = S.readState(root).lastBuildWarnings || {};
  eq(full.kind, 'full', 'd3r2: a full build OUTSIDE the hook records its own warnings');
  ok((full.items || []).some((i) => i.includes('contract title collision ACROSS SCOPES')),
    'd3r2: …naming what was dropped, so graph_status is never captioned with an older build\'s findings');
  ok((full.items || []).some((i) => i.includes('SKIPPING')), 'd3r2: …including the consequence');
  ok(!!full.at, 'd3r2: …timestamped');

  // (3) A NOISY INCREMENTAL MAY NOT DESTROY THE FULL BUILD'S RECORD. The incremental
  // re-loads the contract set, so it re-hits the SAME collision — and used to overwrite.
  const edited = join(root, 'client', 'netcli', 'net.js');
  appendFileSync(edited, '\nexport function d3Tail() { return 1; }\n');
  await runBuild({ target: root, project: root, files: [edited] });
  const afterInc = S.readState(root);
  eq(JSON.stringify(afterInc.lastBuildWarnings), JSON.stringify(full),
    'd3r2: the full build\'s record is BYTE-IDENTICAL after a noisy incremental — an incremental cannot destroy it');
  ok((afterInc.lastIncrementalWarnings?.items || []).some((i) => i.includes('title collision')),
    'd3r2: …while the incremental\'s own findings land in their own slot, so nothing is lost either');

  // …and the rendering keeps them apart, so a reader can tell a complete finding from a
  // partial one.
  const rendered = S.buildWarningLines(afterInc).join('\n');
  has(rendered, 'LAST BUILD DROPPED GRAPH CONTENT', 'd3r2: the full build\'s block still renders');
  ok(!rendered.includes('ALSO DROPPED'),
    'd3r2: …and an incremental finding the full build already reported is not printed twice');

  // (2) A CLEAN FULL REBUILD CLEARS BOTH, so the prescribed remedy actually ends the loop.
  rmSync(dupe);
  await runBuild({ target: root, project: root, reset: true });
  const cleaned = S.readState(root);
  eq((cleaned.lastBuildWarnings?.items || []).length, 0, 'd3r2: a clean full rebuild clears the full record');
  eq(cleaned.lastIncrementalWarnings, null,
    'd3r2: …and supersedes the incremental one too — the loop "report -> rebuild -> report the identical finding" is over');
  eq(S.buildWarningLines(cleaned).length, 0, 'd3r2: …so graph_status prints nothing at all');

  // An incremental may clear its OWN slot (so a fixed cause stops being reported from it)
  // and still may not touch the full one. Seeded directly, because every way to make the
  // build stop warning also moves a partition fingerprint and is correctly refused.
  S.updateState(root, { lastIncrementalWarnings: { at: 'T', kind: 'incremental', items: ['⚠ something the last save dropped'], notes: [] } });
  appendFileSync(edited, '\nexport function d3Tail2() { return 2; }\n');
  await runBuild({ target: root, project: root, files: [edited] });
  eq((S.readState(root).lastIncrementalWarnings?.items || []).length, 0, 'd3r2: a quiet incremental clears its own slot');
  eq((S.readState(root).lastBuildWarnings?.items || []).length, 0, 'd3r2: …without ever writing the full one');

  // …and when the incremental DOES hold something the full build's record does not, it is
  // rendered separately and labelled PARTIAL, rather than replacing the complete record.
  const mixed = S.buildWarningLines({
    lastBuildWarnings: { at: 'T1', kind: 'full', items: ['⚠ fan-out cap: 3 WIRE edge(s) NOT derived'], notes: [] },
    lastIncrementalWarnings: { at: 'T2', kind: 'incremental', items: ['⚠ resource id dropped'], notes: [] },
  }).join('\n');
  has(mixed, 'fan-out cap', 'd3r2: the full build\'s finding is still first and still complete');
  has(mixed, 'ALSO DROPPED', 'd3r2: …and the incremental\'s own finding is not lost either');
  has(mixed, 'PARTIAL', 'd3r2: …but is labelled for what it is — an incremental re-derives only part of the graph');

  rmSync(work, { recursive: true, force: true });
}

// --- R3 — MULTI-LINE WARNINGS WERE TRUNCATED TO THEIR HEADER --------------------
// The tee kept only lines containing a marker, so the two loudest messages in the build —
// both written as ONE multi-line stderr write — reached graph_status as a bare header. The
// directories, the errors, the new names, the remedy and the consequence to act on, i.e. the
// entire actionable payload, were cut.
async function d3MultiLineWarningBlockTest() {
  const S = await import('../scripts/lib/state.mjs');

  // The unit: a marker line OPENS a block and the following lines of the same write belong
  // to it. Lines before any marker are ordinary build output and are dropped.
  const blocks = S.splitWarningBlocks([
    '  parsed 2 files total',
    'wiregraph: IGNORING the compartment declaration in /p — it is PRESENT but UNUSABLE:',
    '  - compartments[0].path "gone" does not exist',
    '  Until it is fixed, every id under this root is derived from the INFERRED partition.',
  ]);
  eq(blocks.length, 1, 'd3r3: one marker, one block — ordinary output before it is not captured');
  has(blocks[0].text, 'does not exist', 'd3r3: …and the block carries the ERRORS, not just the header');
  has(blocks[0].text, 'Until it is fixed', 'd3r3: …and the REMEDY, which is the whole point of the message');

  // Two markers in one write are two blocks, not one run-on.
  eq(S.splitWarningBlocks(['  ⚠ a: dropped', '  ⚠ b: dropped']).length, 2, 'd3r3: two markers are two blocks');

  // End to end: a declared path that does not exist makes the declaration UNUSABLE, the walk
  // says so in a four-line block, and the whole block has to reach state.
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d3r3-')));
  mkdirSync(join(work, 'alpha'), { recursive: true });
  writeFileSync(join(work, 'alpha', 'a.js'), 'export function alphaFn(){ return 1; }\n');
  mkdirSync(join(work, '.wiregraph'), { recursive: true });
  writeFileSync(join(work, '.wiregraph', 'state.json'), JSON.stringify({
    project: work, indexedRoots: [work], links: [], reposLastSha: {}, autoUpdate: 'balanced',
    mode: 'recursive', compartments: [{ path: 'alpha', name: 'alpha' }, { path: 'vanished', name: 'vanished' }],
  }, null, 2));

  await runBuild({ target: work, project: work, reset: true });
  const items = S.readState(work).lastBuildWarnings?.items || [];
  const ignoring = items.find((i) => i.includes('IGNORING the compartment declaration')) || '';
  ok(ignoring, 'd3r3: the IGNORING block is recorded');
  has(ignoring, 'vanished', 'd3r3: …naming the declared path that is not there — the header alone never said which one');
  ok(ignoring.split('\n').length > 1, 'd3r3: …and it is a BLOCK, not a first line');
  has(S.buildWarningLines(S.readState(work)).join('\n'), 'vanished',
    'd3r3: …and the payload survives all the way into what graph_status prints');

  rmSync(work, { recursive: true, force: true });
}

// --- R4 / R5 — A RENAME IS NOT A DELETION, AND IT HAS TO BE VISIBLE -------------
// WARN_MARKERS keyed on `⚠`, so the compartment-name DISAMBIGUATION notice — whose own text
// reads "wiregraph RENAMED them to keep the graph correct" — was persisted and rendered under
// "LAST BUILD DROPPED GRAPH CONTENT … what they name is NOT in the graph". On a 22-compartment
// tree that self-contradiction printed after every build. And the renames were invisible
// everywhere else: graph_status said `Mode: global — compartments inferred…` with no mention
// that `network` became `client/network` + `server/network`, and find_symbol on the bare name
// dead-ended with no hint the real names existed.
async function d3RenameIsNotALossTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d3r45-')));
  const root = join(work, 'ws');
  const mk = (rel, files) => {
    const d = join(root, rel);
    mkdirSync(d, { recursive: true });
    for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  };
  mk('client/network', { 'package.json': '{"name":"cnet"}', 'transport.js': 'export function transport(){ return 1; }\n' });
  mk('server/network', { 'package.json': '{"name":"snet"}', 'listener.js': 'export function listener(){ return 2; }\n' });
  mk('client/input', { 'package.json': '{"name":"cin"}', 'input.js': 'export function inputFn(){ return 3; }\n' });

  const db = join(work, 'graph.db');
  await runBuild({ target: root, project: root, db, reset: true });
  const st = S.readState(root);

  // R4 — filed as a NOTICE, not as content loss.
  const notes = st.lastBuildWarnings?.notes || [];
  const items = st.lastBuildWarnings?.items || [];
  ok(notes.some((n) => n.includes('COMPARTMENT NAME COLLISION')), 'd3r4: the rename notice is recorded as a NOTE');
  ok(!items.some((i) => i.includes('COMPARTMENT NAME COLLISION')),
    'd3r4: …and NOT as dropped content — nothing was dropped, the compartments are all in the graph');
  const rendered = S.buildWarningLines(st).join('\n');
  has(rendered, 'RENAMED OR ADJUSTED', 'd3r4: it renders under its own heading');
  has(rendered, 'NOTHING WAS DROPPED', 'd3r4: …which says the opposite of the heading it used to appear under');
  ok(!rendered.includes('LAST BUILD DROPPED GRAPH CONTENT'),
    'd3r4: …and the content-loss heading does not appear at all, so the report no longer contradicts itself');
  has(rendered, 'client/network', 'd3r4: …and the multi-line block still carries the new names (R3 rides along)');

  // R5 — the renames are reachable from the read tools, not just from build stderr.
  const conn = connect(db, { readonly: true });
  eq(JSON.stringify(Q.disambiguatedCompartments(conn, root)),
    JSON.stringify([{ bare: 'network', names: ['client/network', 'server/network'] }]),
    'd3r5: the graph itself is the record of what was renamed — no extra state to go stale');
  const lines = Q.disambiguatedCompartmentLines(conn, root).join('\n');
  has(lines, 'RENAMED COMPARTMENTS', 'd3r5: graph_status gets a line for it');
  has(lines, '"network" → client/network, server/network', 'd3r5: …naming the bare name and both replacements');

  // find_symbol on the bare name dead-ended with nothing to go on.
  has(Q.findSymbol(conn, root, 'transport', 'network'), 'renamed to client/network and server/network',
    'd3r5: find_symbol on the vanished bare name says where it went instead of dead-ending');
  ok(!Q.findSymbol(conn, root, 'transport', 'client/network').includes('renamed to'),
    'd3r5: …and a compartment that DOES exist gets no hint');
  ok(!Q.findSymbol(conn, root, 'transport', 'input').includes('renamed to'),
    'd3r5: …nor does an unrelated real compartment with no symbol of that name');
  has(Q.getSource(conn, root, 'transport', 'network'), 'renamed to client/network and server/network',
    'd3r5: get_source dead-ends the same way and gets the same hint');

  // A collision-free project is untouched — no line, no hint, byte-identical report.
  const clean = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d3r45c-')));
  mkdirSync(join(clean, 'a'), { recursive: true });
  writeFileSync(join(clean, 'a', 'package.json'), '{"name":"a"}');
  writeFileSync(join(clean, 'a', 'a.js'), 'export function aFn(){ return 1; }\n');
  const cdb = join(clean, 'g.db');
  await runBuild({ target: clean, project: clean, db: cdb, reset: true });
  const cconn = connect(cdb, { readonly: true });
  eq(Q.disambiguatedCompartmentLines(cconn, clean).length, 0, 'd3r5: a project with no collision gets no line');
  cconn.close();
  conn.close();

  // The handler must actually render it — the half no query-level assertion can reach.
  has(readFileSync(join(HERE, '..', 'src', 'mcp', 'server.js'), 'utf8'),
    'lines.push(...Q.disambiguatedCompartmentLines(db, PROJECT));',
    'd3r5: graph_status really calls it, next to its Mode: line');

  rmSync(work, { recursive: true, force: true });
  rmSync(clean, { recursive: true, force: true });
}

// --- R6 — A MALFORMED FINGERPRINT DISARMED THE GUARD ---------------------------
// `null`/absent failing OPEN is BY DESIGN (§14): it is what makes an upgrade non-disruptive.
// A PRESENT but malformed value is a different thing entirely — a hand edit, a truncated
// write, another tool — and none of it is evidence the graph matches the live partition.
// Each of these let a REAL declaration change through an incremental, producing duplicate
// symbols under two compartments while the log said only `auto: reindexed 1 changed file(s)`.
async function d3MalformedFingerprintTest() {
  const S = await import('../scripts/lib/state.mjs');
  const live = { '.': 'g1:aaaaaaaaaaaaaaaa' };

  // ABSENT still fails OPEN. This half is the design's, and breaking it would force-rebuild
  // every project that predates the key.
  eq(S.compartmentsDrift(undefined, live), null, 'd3r6: an ABSENT stamp is still no baseline');
  eq(S.compartmentsDrift(null, live), null, 'd3r6: …and null is still the same');

  // PRESENT-but-malformed fails SAFE.
  for (const [bad, what] of [['garbage', 'a bare string'], [5, 'a number'], [true, 'a boolean']]) {
    ok(S.compartmentsDrift(bad, live), `d3r6: ${what} is MALFORMED and reads as drift`);
  }
  ok(S.compartmentsDrift([1, 2], live), 'd3r6: an ARRAY is malformed — a stamp is a per-root map');
  ok(S.compartmentsDrift({}, live), 'd3r6: an EMPTY map is malformed — a real stamp always carries at least the project root');
  ok(S.compartmentsDrift({ '.': 5 }, live), 'd3r6: …and so is a map whose value is not a fingerprint string');
  has(S.compartmentsDrift('garbage', live), 'MALFORMED', 'd3r6: the reason SAYS malformed rather than inventing a partition change');
  ok(S.contractsDrift([1, 2], { '.': 'k2:x' }), 'd3r6: the CONTRACTS fingerprint rides the same comparison, so it is fixed too');

  // The two legitimate per-root skips are UNTOUCHED — they are what a newly linked member
  // and a transiently unmounted root depend on.
  eq(S.compartmentsDrift({ '.': 'g1:aaaaaaaaaaaaaaaa', '/gone': 'g1:z' }, live), null,
    'd3r6: an UNMOUNTED root is still simply not compared');
  eq(S.compartmentsDrift({ '.': 'g1:aaaaaaaaaaaaaaaa' }, { '.': 'g1:aaaaaaaaaaaaaaaa', '/new': 'g1:q' }), null,
    'd3r6: a root with no entry of its own is still "no baseline", not "changed"');

  // END TO END: the observed symptom was a real declaration change sailing through an
  // incremental. With the stamp replaced by junk, the incremental must REFUSE.
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d3r6-')));
  for (const d of ['alpha', 'beta']) {
    mkdirSync(join(work, d), { recursive: true });
    writeFileSync(join(work, d, 'f.js'), `export function ${d}Fn(){ return 1; }\n`);
  }
  mkdirSync(join(work, '.wiregraph'), { recursive: true });
  const declare = (comps) => writeFileSync(join(work, '.wiregraph', 'state.json'), JSON.stringify({
    project: work, indexedRoots: [work], links: [], reposLastSha: {}, autoUpdate: 'balanced',
    mode: 'recursive', compartments: comps,
  }, null, 2));
  declare([{ path: 'alpha', name: 'alpha' }, { path: 'beta', name: 'beta' }]);
  await runBuild({ target: work, project: work, reset: true });

  // Change the partition AND clobber the baseline with junk — the exact state a hand edit
  // leaves behind.
  declare([{ path: 'alpha', name: 'alpha' }]);
  S.updateState(work, { compartmentsFingerprint: 'garbage' });
  let refused = null;
  try { await runBuild({ target: work, project: work, files: [join(work, 'alpha', 'f.js')] }); }
  catch (e) { refused = e.message; }
  ok(refused, 'd3r6: an incremental over a MALFORMED baseline is REFUSED instead of silently re-partitioning');
  has(refused, 'full rebuild', 'd3r6: …naming the remedy');
  await runBuild({ target: work, project: work, reset: true });
  eq(S.compartmentsDrift(S.readState(work).compartmentsFingerprint, S.compartmentsFingerprint(work)), null,
    'd3r6: …and the full rebuild restamps a well-formed baseline, so it does not recur');

  rmSync(work, { recursive: true, force: true });
}

// --- R7 — `compartments.mjs clear` LIED ON AN ALREADY-GLOBAL PROJECT ------------
// It printed "Cleared the compartment declaration … mode is now global" AND "A full rebuild
// is REQUIRED — every node id changes when the partition changes" when nothing was cleared
// and no id moved. Both /wiregraph-init's GLOBAL branch and /wiregraph-teardown run `clear`
// unconditionally, so the false rebuild demand was on the ordinary path.
async function d3ClearNothingToClearTest() {
  const S = await import('../scripts/lib/state.mjs');
  const CLEAR = join(HERE, '..', 'scripts', 'lib', 'compartments.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d3r7-')));

  // An indexed project that was never declared — the global default, i.e. most projects.
  mkdirSync(join(work, 'a'), { recursive: true });
  writeFileSync(join(work, 'a', 'a.js'), 'export function aFn(){ return 1; }\n');
  await runBuild({ target: work, project: work, reset: true });
  ok(!S.isRecursiveMode(S.readState(work)), 'd3r7: the project really is global to begin with');

  const r = await execFileP(process.execPath, [CLEAR, 'clear', work]);
  ok(!r.stdout.includes('Cleared the compartment declaration'),
    'd3r7: it no longer claims to have cleared a declaration that was never there');
  ok(!r.stdout.includes('REQUIRED'),
    'd3r7: …nor demands a full rebuild for a change that did not happen');
  has(r.stdout, 'already global', 'd3r7: …it says what is actually true');
  has(r.stdout, 'nothing changed', 'd3r7: …and that nothing changed');

  // The two REAL cases are untouched: a brand-new project still errors, and a DECLARED
  // project still clears and still demands the rebuild it genuinely needs.
  const bare = join(work, 'not-a-project');
  mkdirSync(bare, { recursive: true });
  let failed = null;
  try { await execFileP(process.execPath, [CLEAR, 'clear', bare]); } catch (e) { failed = e; }
  ok(failed && String(failed.stderr).includes('nothing to clear'), 'd3r7: an UNINDEXED dir still errors, exactly as before');

  S.updateState(work, { mode: 'recursive', compartments: [{ path: 'a', name: 'a' }] });
  const r2 = await execFileP(process.execPath, [CLEAR, 'clear', work]);
  has(r2.stdout, 'Cleared the compartment declaration', 'd3r7: a REAL declaration is still cleared');
  has(r2.stdout, 'REQUIRED', 'd3r7: …and still demands the rebuild, which really is required there');
  eq(S.readState(work).compartments, null, 'd3r7: …and the declaration is actually gone');

  rmSync(work, { recursive: true, force: true });
}

// --- R8 — update_graph {full:true} REPORTED A DIFFERENT COUNT FROM graph_status --
// `Full rebuild complete: 20 symbols indexed` on a graph the same run reported as 28 symbols
// via graph_status, because the two counted different things. /wiregraph-rebuild tells the
// agent to "report the new stats", i.e. to publish the disagreement.
async function d3SymbolCountAgreementTest() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d3r8-')));
  const root = nestedProject(work);
  await runBuild({ target: root, project: root, reset: true });

  const conn = connect(join(root, '.wiregraph', 'graph.db'), { readonly: true });
  const all = conn.prepare('SELECT count(*) c FROM symbols WHERE project=?').get(root).c;
  const noModule = conn.prepare("SELECT count(*) c FROM symbols WHERE project=? AND kind<>'module'").get(root).c;
  const statsLine = Q.graphStats(conn, root).split('\n').find((l) => l.startsWith('Nodes:')) || '';
  conn.close();
  ok(all > noModule, 'd3r8: the fixture really does have `<module>` symbols, so the two counts genuinely differ');
  has(statsLine, `Symbol=${all}`, 'd3r8: graph_stats/graph_status count EVERY symbol row');

  // The number update_graph publishes, from the module that publishes it. PROJECT is
  // resolved at import, so this runs in its own process.
  const src = `const m = await import(${JSON.stringify(MCP_SERVER_URL)});\n`
    + "process.stdout.write('\\nCOUNT:' + m.__withDbCount() + '\\n');\n";
  const { stdout } = await execFileP('node', ['--input-type=module', '-e', src],
    { env: { ...process.env, CLAUDE_PROJECT_DIR: root, WIREGRAPH_DB: join(root, '.wiregraph', 'graph.db') } });
  const published = Number(/^COUNT:(\d+)$/m.exec(stdout)?.[1]);
  eq(published, all,
    'd3r8: "Full rebuild complete: N symbols indexed" reports the SAME N graph_status does — one quantity, one number');

  rmSync(work, { recursive: true, force: true });
}

// --- R9 — trace_contract COULD NOT LIST CONTRACTS -------------------------------
// It required a name substring, and `{"contract":""}` only worked by accident (the empty
// string makes the LIKE match everything, dumping every contract's full drift report).
// Omitted or empty now LISTS, with kind and token count.
async function d3TraceContractListingTest() {
  const work = mkdtempSync(join(tmpdir(), 'cg-d3r9-'));
  const root = nestedProject(work);
  const db = join(work, 'graph.db');
  // A RESOURCE contract alongside the wire ones, so the `kind` column has something to say.
  writeFileSync(join(root, 'contracts', 'shared.resource.yaml'), [
    'title: Shared Snapshot Cache',
    'resources:', '  - id: WORLD_SNAPSHOT_CACHE_PATH', '    kind: path',
    '    semantics: last-writer-wins', '    writers: [sim]', '    readers: [netsrv]', '',
  ].join('\n'));
  await runBuild({ target: root, project: root, db, reset: true });
  const conn = connect(db, { readonly: true });

  const omitted = Q.traceContract(conn, root, undefined, null, false);
  const empty = Q.traceContract(conn, root, '', null, false);
  eq(omitted, empty, 'd3r9: an OMITTED contract and an empty one mean the same thing — listing');
  has(omitted, 'contract(s) in this project', 'd3r9: …and it is a listing, not a dump of every drift report');
  ok(!omitted.includes('referenced by:'), 'd3r9: …with none of the per-symbol detail a real trace prints');
  has(omitted, 'Nested Outer Wire — wire · 2 token(s)', 'd3r9: each contract with its KIND and its defined-token COUNT');
  has(omitted, 'Server Inner Wire — wire · 2 token(s)', 'd3r9: …for every wire contract');
  has(omitted, 'Shared Snapshot Cache — resource · 1 token(s)', 'd3r9: …and a resource spec is listed as `resource`, not as a wire');
  has(omitted, 'contracts/outer.asyncapi.yaml', 'd3r9: …and names the spec file, so the next step is obvious');

  // Naming one still traces it, unchanged.
  has(Q.traceContract(conn, root, 'Nested Outer', null, false), 'referenced by:',
    'd3r9: passing a substring still returns the full drift report — the listing is an ADDITION');
  has(Q.traceContract(conn, root, 'no-such-contract', null, false), 'No contract matches',
    'd3r9: …and a name that matches nothing still says so, rather than falling back to the listing');
  conn.close();

  // A project with no contracts at all says so instead of returning an empty listing.
  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d3r9b-')));
  writeFileSync(join(bare, 'a.js'), 'export function aFn(){ return 1; }\n');
  const bdb = join(bare, 'g.db');
  await runBuild({ target: bare, project: bare, db: bdb, reset: true });
  const bconn = connect(bdb, { readonly: true });
  has(Q.traceContract(bconn, bare, undefined, null, false), 'No contracts in this project',
    'd3r9: a project with no contracts gets a sentence, not a blank');
  bconn.close();

  // The schema has to allow the omission — a required field makes the listing unreachable
  // from the tool no matter what the query layer does.
  const src = readFileSync(join(HERE, '..', 'src', 'mcp', 'server.js'), 'utf8');
  has(src, "contract: z.string().optional()", 'd3r9: …and the MCP schema marks the field OPTIONAL, so an agent can actually omit it');

  rmSync(work, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
}

// --- R10 — THE TWO SCHEMA STAMPS COULD DISAGREE, AND THE MISMATCH WAS RESTAMPED --
// `meta.schema_version` is authoritative and the file header's `user_version` is its cheap
// mirror. With meta=3 and header=5 the cheap probe short-circuits, so the authoritative value
// is never read, no migration runs, and the incremental RESTAMPS meta to 5 — the db then
// claims to be current while physically on the old shape, defeating every downstream check.
async function d3SchemaStampDisagreementTest() {
  const { schemaStatus, schemaVersion } = await import('../src/store/sqlite.js');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d3r10-')));
  writeFileSync(join(work, 'a.js'), 'export function aFn(){ return 1; }\n');
  await runBuild({ target: work, project: work, reset: true });
  const dbPath = join(work, '.wiregraph', 'graph.db');

  // meta says 3, the header still says 5 — one hand edit, or an older tool.
  stampSchemaVersion(work, 3, SCHEMA_VERSION);
  eq(schemaStatus(dbPath), 'current',
    'd3r10: the cheap probe still reports CURRENT — it reads the header, so it cannot see this at all');

  let refused = null;
  try { await runBuild({ target: work, project: work, files: [join(work, 'a.js')] }); }
  catch (e) { refused = e.message; }
  ok(refused, 'd3r10: the incremental REFUSES instead of silently restamping a db it never migrated');
  has(refused, 'DISAGREE', 'd3r10: …saying what is actually wrong');
  has(refused, 'meta.schema_version=3', 'd3r10: …with both values, so it is diagnosable');
  has(refused, 'user_version=5', 'd3r10: …both of them');
  {
    const c = connect(dbPath, { readonly: true });
    eq(schemaVersion(c), 3, 'd3r10: …and it did NOT restamp meta on the way out — the trap is the silent restamp');
    c.close();
  }

  // The remedy the message names actually works: a reset build recreates the tables and
  // rewrites both stamps together.
  await runBuild({ target: work, project: work, reset: true });
  {
    const c = connect(dbPath, { readonly: true });
    eq(schemaVersion(c), SCHEMA_VERSION, 'd3r10: a full rebuild migrates and agrees');
    eq(Number(c.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION, 'd3r10: …on both stamps');
    c.close();
  }
  await runBuild({ target: work, project: work, files: [join(work, 'a.js')] });
  ok(true, 'd3r10: …and ordinary incremental saves work again');

  // ABSENT IS NOT DISAGREEMENT. A pre-mirror db (header 0) must keep working — that is the
  // same "0 means unknown, never outdated" rule schemaStatus documents for its own probe.
  stampSchemaVersion(work, SCHEMA_VERSION, 0);
  await runBuild({ target: work, project: work, files: [join(work, 'a.js')] });
  ok(true, 'd3r10: an ABSENT header stamp is unknown, not a disagreement — a legacy db still updates');

  rmSync(work, { recursive: true, force: true });
}

// --- R11 — A FOREIGN graph.db DROPPED IN PLACE WAS NEVER DETECTED ---------------
// Every id is project-FREE, so someone else's graph.db looks plausible. One incremental later
// hundreds of rows still carry the other project's tag, and `INSERT OR REPLACE` on the
// compartment id means this project's own compartment row is REPLACED by the foreign one. No
// warning, no escalation, no self-heal short of a full rebuild. A `cp -a` of a whole PROJECT
// is caught by the copy sentinel (it carries a state.json to compare); the bare-db case
// carries nothing, so the db has to record who owns it.
async function d3ForeignDbTest() {
  const S = await import('../scripts/lib/state.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d3r11-')));
  const A = join(work, 'proj-a'); const B = join(work, 'proj-b');
  for (const [d, n] of [[A, 'alpha'], [B, 'bravo']]) {
    mkdirSync(join(d, n), { recursive: true });
    writeFileSync(join(d, n, 'f.js'), `export function ${n}Fn(){ return 1; }\n`);
  }
  await runBuild({ target: A, project: A, reset: true });
  await runBuild({ target: B, project: B, reset: true });

  const dbA = join(A, '.wiregraph', 'graph.db');
  const dbB = join(B, '.wiregraph', 'graph.db');
  {
    const c = connect(dbA, { readonly: true });
    eq(c.prepare("SELECT value v FROM meta WHERE key='project_root'").get()?.v, A,
      'd3r11: a built db records WHICH project it belongs to');
    c.close();
  }

  // B's db dropped into A. Nothing else moves — A's state.json, shas and fingerprints are its
  // own, so the copy sentinel and both partition guards see nothing wrong.
  cpSync(dbB, dbA);
  eq(S.compartmentsDrift(S.readState(A).compartmentsFingerprint, S.compartmentsFingerprint(A)), null,
    'd3r11: the partition guard is silent — this is not a partition change, which is why nothing caught it');

  let refused = null;
  try { await runBuild({ target: A, project: A, files: [join(A, 'alpha', 'f.js')] }); }
  catch (e) { refused = e.message; }
  ok(refused, 'd3r11: the incremental REFUSES a db built for another project');
  has(refused, B, 'd3r11: …naming whose db it is');
  has(refused, 'full rebuild', 'd3r11: …and the remedy');
  {
    const c = connect(dbA, { readonly: true });
    const foreign = c.prepare('SELECT count(*) n FROM symbols WHERE project=?').get(B).n;
    ok(foreign > 0, 'd3r11: …and it refused BEFORE writing, so the foreign rows are still exactly as they were');
    c.close();
  }

  await runBuild({ target: A, project: A, reset: true });
  {
    const c = connect(dbA, { readonly: true });
    eq(c.prepare('SELECT count(*) n FROM symbols WHERE project=?').get(B).n, 0, 'd3r11: a full rebuild purges the foreign rows');
    eq(c.prepare("SELECT value v FROM meta WHERE key='project_root'").get()?.v, A, 'd3r11: …and restamps the owner');
    c.close();
  }
  await runBuild({ target: A, project: A, files: [join(A, 'alpha', 'f.js')] });
  ok(true, 'd3r11: …so ordinary saves work again');

  // A MOVE IS NOT A FOREIGN DB, and the test is the same decisive existsSync the copy
  // sentinel uses: after `mv` the recorded owner is no longer a wiregraph project. Moved to a
  // new PARENT, keeping the basename, so the compartment fingerprint (which deliberately is
  // NOT rename-stable) does not fire first and this really does exercise the db check.
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d3r11m-')));
  const C = join(elsewhere, 'proj-a');
  renameSync(A, C);
  await runBuild({ target: C, project: C, files: [join(C, 'alpha', 'f.js')] });
  ok(true, 'd3r11: a MOVED project still updates incrementally — the old path is gone, so this is a move');
  {
    const c = connect(join(C, '.wiregraph', 'graph.db'), { readonly: true });
    eq(c.prepare("SELECT value v FROM meta WHERE key='project_root'").get()?.v, C,
      'd3r11: …and it adopts the db under its new name, so the guard is armed again from the next save');
    c.close();
  }

  rmSync(work, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
}
// === DEFERRED-3 TESTS END ===

// === DEFERRED-2 TESTS START ===

// --- D1: AUTHORSHIP IS DECIDED BY CONTENT, NOT BY FILENAME ---------------------
// `INFERRED_SPEC_NAME_RE` used to be OR-ed with the x-wiregraph-inferred marker, so
// `wiregraph-inferred.*` alone classified a spec as a generated draft. Two ways that
// destroyed a user's work, both reproduced here:
//
//   (a) THE DOCUMENTED WORKFLOW. The draft's own header told the reader to prune
//       writers:/readers: and then DELETE the marker. Do exactly that and the file is
//       STILL a draft by filename: its ids are re-proposed by the next scan, and `apply`
//       overwrites the pruned roles and the declared single_writer with the all-both
//       placeholder.
//   (b) A HAND-WRITTEN SPEC THAT MERELY BORROWED THE NAME loses every id to a draft.
//
// The fix is layered — digest, then marker, then filename-AND-shape — so each layer is
// asserted on its own, including the two directions that must NOT change: a real draft is
// still a draft, and a legacy marker-only draft is still a draft.
async function deferred2AuthorshipTest() {
  const C = await import('../src/extract/contracts.js');
  const I = await import('../src/contracts/infer.js');
  const YAML = (await import('yaml')).default;

  const draftSpec = (extra = '') =>
    'title: wiregraph-inferred-resources\nx-wiregraph-inferred: true\n' + extra + 'resources:\n'
    + '  - id: WORLD_SNAPSHOT_CACHE_PATH\n    kind: path\n    semantics: presence-as-state\n'
    + '    writers: [world_state, netcli, netsrv]\n    readers: [world_state, netcli, netsrv]\n';
  // Exactly what the header told the user to produce: roles pruned to the real split, a
  // declared discipline, and the marker deleted.
  const prunedSpec =
    'title: wiregraph-inferred-resources\nresources:\n'
    + '  - id: WORLD_SNAPSHOT_CACHE_PATH\n    kind: path\n    semantics: presence-as-state\n'
    + '    single_writer: true\n    writers: [world_state]\n    readers: [netcli, netsrv]\n';

  const isDraft = (text, name) => C.isGeneratedDraft(YAML.parse(text), name, /\.resource\./.test(name) ? 'resource' : 'asyncapi');

  // (a) the pruned file, under the generated filename, is the USER'S.
  ok(!isDraft(prunedSpec, 'wiregraph-inferred.resource.yaml'),
    'D1(a): a draft the user pruned per its own header — roles split, single_writer declared, marker deleted — is NOT re-classified as a draft by its filename');
  // …and the same content under any other name is likewise the user's (control).
  ok(!isDraft(prunedSpec, 'client-resources.resource.yaml'),
    'D1(a): …and the verdict does not depend on the filename at all');

  // (b) a hand-written spec that merely borrowed the generated NAME.
  const handSpec = 'title: Client Shared Resources\nresources:\n'
    + '  - id: WORLD_SNAPSHOT_CACHE_PATH\n    kind: path\n    single_writer: true\n'
    + '    writers: [world_state]\n    readers: [netcli]\n';
  ok(!isDraft(handSpec, 'wiregraph-inferred.resource.yaml'),
    'D1(b): a hand-written spec NAMED wiregraph-inferred.resource.yaml is not a draft — the filename cannot overrule the content');

  // The directions that must NOT change.
  ok(isDraft(draftSpec(), 'wiregraph-inferred.resource.yaml'),
    'D1(c): a real marker-carrying draft is still a draft (the marker alone is trusted when there is no digest — a legacy draft has no baseline)');
  ok(isDraft('title: t\nx-wiregraph-inferred: true\nresources:\n  - id: DRAFT_ONLY_PATH\n    kind: path\n    writers: [alpha]\n    readers: [beta]\n', 'anything.resource.yaml'),
    'D1(c): …marker-only, under any filename, likewise — dropping the marker layer would break every pre-digest draft');

  // A PRE-MARKER draft, identifiable only by name: the filename layer still works, but
  // ONLY because the content still has the emitter's exact all-both shape.
  const preMarker = draftSpec().replace('x-wiregraph-inferred: true\n', '');
  ok(isDraft(preMarker, 'wiregraph-inferred.resource.yaml'),
    'D1(d): a pre-marker draft (filename + untouched placeholder roles) is still recognised');
  ok(!isDraft(preMarker.replace('writers: [world_state, netcli, netsrv]', 'writers: [world_state]'), 'wiregraph-inferred.resource.yaml'),
    'D1(d): …but pruning ONE role list ends it — the filename layer is gated on the shape, which is the whole fix');

  // THE DIGEST, which is what lets the header stop telling users to delete the marker: a
  // user may now prune the roles and LEAVE the marker in place, and still own the file.
  const emitted = I.synthesizeResourceSpec([{ kind: 'resource', token: 'A_STATE_PATH', value: '/var/run/a.json', compartments: ['a', 'b'], definers: ['a'], corroborated: [], layout: 'shared-module' }]);
  has(emitted, 'x-wiregraph-digest:', 'D1(e): the emitter stamps a content digest on the resource draft');
  ok(isDraft(emitted, 'wiregraph-inferred.resource.yaml'),
    'D1(e): …which matches its own output, so a freshly written draft is a draft');
  ok(isDraft(emitted + '\n# a note to myself\n', 'wiregraph-inferred.resource.yaml'),
    'D1(e): …a COMMENT is not a semantic edit (the digest is over the parsed doc), so annotating a draft does not claim it');
  const emittedPruned = emitted.replace('    readers:\n      - a\n      - b\n', '    readers:\n      - b\n');
  ok(emittedPruned !== emitted, 'D1(e): (the pruning edit under test really did change the file)');
  ok(!isDraft(emittedPruned, 'wiregraph-inferred.resource.yaml'),
    'D1(e): …but pruning a role list WITH THE MARKER LEFT IN PLACE does — editing is what claims the file');

  // The wire draft never carried a marker at all before this, so it was identifiable ONLY
  // by filename — the pure form of the defect.
  const wire = I.synthesizeAsyncApi([{ kind: 'wire', token: '/orders/{id}', compartments: ['cli', 'srv'], inCompartments: ['srv'], outCompartments: ['cli'], labels: ['get'] }]);
  has(wire, 'x-wiregraph-inferred: true', 'D1(f): the wire draft now carries the marker too (it never did)');
  ok(isDraft(wire, 'wiregraph-inferred.asyncapi.yaml'), 'D1(f): …and is recognised as a draft');
  const handWire = "asyncapi: 3.0.0\ninfo:\n  title: My Wire\n  version: '1.0.0'\nchannels:\n  o:\n    address: /orders/{id}\n"
    + '    messages:\n      request:\n        payload:\n          type: object\n          properties:\n            order_token:\n              type: string\n';
  ok(!isDraft(handWire, 'wiregraph-inferred.asyncapi.yaml'),
    'D1(f): …while a hand-written wire spec under the generated filename is NOT — a filled-in payload schema is not the emitter\u2019s empty skeleton');

  // The header must no longer instruct the deletion the fix made unnecessary.
  // THROUGH THE LOADER, not just the predicate: `handWrittenTokens` is where the verdict
  // is actually consumed, and readContractsDir is where the filename used to be OR-ed in.
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d2auth-u-')));
  writeFileSync(join(work, 'wiregraph-inferred.resource.yaml'), prunedSpec);
  writeFileSync(join(work, 'other-inferred.resource.yaml'), draftSpec().replace('WORLD_SNAPSHOT_CACHE_PATH', 'DRAFT_ONLY_CACHE_PATH'));
  const declared = C.handWrittenTokens([work]);
  ok(declared.has('WORLD_SNAPSHOT_CACHE_PATH'),
    'D1(h): through the LOADER — a pruned draft is a hand-written declaration, so inference stops re-proposing its id');
  ok(!declared.has('DRAFT_ONLY_CACHE_PATH'),
    'D1(h): …while a genuine draft is still skipped, so inference is not frozen behind one');
  rmSync(work, { recursive: true, force: true });

  ok(!/delete it once you have pruned/i.test(emitted),
    'D1(g): the draft header no longer tells the user to delete the marker (the instruction that triggered the whole defect)');
  has(emitted, 'LEAVE THEM AS THEY ARE', 'D1(g): …it says to leave the marker and digest alone');
  has(emitted, 'authorship is decided by the CONTENT, never by the filename', 'D1(g): …and states the rule that replaced it');
}

// --- D1e2e: the same thing end to end, through scan/apply ----------------------
// The report the defect was filed from: follow the documented workflow, re-run the
// documented commands, and watch `apply` overwrite the pruned roles and single_writer with
// the all-both placeholder.
async function deferred2AuthorshipE2ETest() {
  const CONTRACTS = join(HERE, '..', 'scripts', 'contracts.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d2auth-')));
  for (const d of ['world_state', 'netcli', 'netsrv']) mkdirSync(join(work, d, '.git'), { recursive: true });
  writeFileSync(join(work, 'world_state', 'cache.js'),
    "export const WORLD_SNAPSHOT_CACHE_PATH = '/var/run/game/snapshot.cache';\n"
    + 'export function writeSnapshot(b) { return writeFileSync(WORLD_SNAPSHOT_CACHE_PATH, b); }\n');
  writeFileSync(join(work, 'netcli', 'read.js'),
    "import { WORLD_SNAPSHOT_CACHE_PATH } from '../world_state/cache.js';\n"
    + 'export function readSnapshot() { return readFileSync(WORLD_SNAPSHOT_CACHE_PATH); }\n');
  writeFileSync(join(work, 'netsrv', 'peek.js'),
    "import { WORLD_SNAPSHOT_CACHE_PATH } from '../world_state/cache.js';\n"
    + 'export function peekSnapshot() { return statSync(WORLD_SNAPSHOT_CACHE_PATH); }\n');

  // 1. apply — wiregraph writes the draft.
  await execFileP('node', [CONTRACTS, 'apply', work]);
  const spec = join(work, 'contracts', 'wiregraph-inferred.resource.yaml');
  ok(existsSync(spec), 'D1-e2e: apply writes the resource draft');

  // 2. the user does EXACTLY what the draft header asks: prune the roles to the real
  //    split and declare the discipline. (The marker stays — the new header says so.)
  const pruned = readFileSync(spec, 'utf8')
    .replace(/  writers:\n(?:    - \w+\n)+/, '  writers:\n    - world_state\n')
    .replace(/  readers:\n(?:    - \w+\n)+/, '  readers:\n    - netcli\n    - netsrv\n')
    .replace(/    kind: path\n/, '    kind: path\n    single_writer: true\n');
  ok(pruned.includes('single_writer: true') && !pruned.includes('- netsrv\n  readers'), 'D1-e2e: (the edit under test really did prune the lists)');
  writeFileSync(spec, pruned);

  // 3. re-run the documented scan/apply.
  const scan = await execFileP('node', [CONTRACTS, 'scan', work]);
  has(scan.stdout, 'WORLD_SNAPSHOT_CACHE_PATH: already declared by a hand-written resource contract',
    'D1-e2e: the edited draft is the USER\u2019s spec, so the scan does not re-propose its id');
  ok(!scan.stdout.includes('--- proposed RESOURCE contract'),
    `D1-e2e: …and there is nothing left to propose (got:\n${scan.stdout})`);

  await execFileP('node', [CONTRACTS, 'apply', work]);
  const after = readFileSync(spec, 'utf8');
  has(after, 'single_writer: true', 'D1-e2e: apply does NOT overwrite the declared single_writer discipline');
  ok(!/writers:\n\s+- world_state\n\s+- netcli/.test(after),
    `D1-e2e: …nor restore the all-both placeholder over the pruned writers (got:\n${after})`);
  eq(after, pruned, 'D1-e2e: the user\u2019s file is byte-identical after re-running the documented workflow');

  rmSync(work, { recursive: true, force: true });
}

// --- D2: wire-role compartment names are validated too ------------------------
// `validateResourceRoles` skipped every non-resource contract, so a resource spec naming a
// nonexistent compartment was named and explained while the identical mistake in
// `x-wiregraph-producers` produced `derived 0 WIRE edges` and no message at all — which is
// exactly what a compartment rename does to every bare-basename role name in every wire
// spec, all at once.
//
// The false positive another wave fixed in this same function is re-asserted: on the
// `--files` path the graph holds only the EDITED files' compartments, and the authoritative
// set arrives via opts.knownCompartments. Extending the check must not re-arm it.
async function deferred2WireRoleValidationTest() {
  const C = await import('../src/extract/contracts.js');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d2role-')));
  const dir = join(work, 'contracts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'wire.asyncapi.yaml'),
    "asyncapi: 3.0.0\ninfo:\n  title: Client Wire\n  version: '1.0.0'\nchannels:\n"
    + '  refresh:\n    address: /player/session/refresh\n'
    + '    x-wiregraph-producers: [network]\n    x-wiregraph-consumers: [netsrv]\n');

  // A graph whose compartments are the post-rename, QUALIFIED names — the situation the
  // disambiguation warning tells users to act on.
  const g = new Graph(work);
  for (const n of ['client/network', 'netsrv']) g.addCompartment(n, join(work, n));
  const logs = [];
  C.loadAllContracts(g, [dir], (m) => logs.push(m));
  const warn = logs.find((m) => m.includes('⚠') && m.includes('/player/session/refresh'));
  ok(warn, `D2: a wire role naming a compartment that does not exist is REPORTED (got: ${logs.join(' | ') || 'nothing'})`);
  has(String(warn), 'network', 'D2: …naming the offending role value');
  has(String(warn), 'client/network', 'D2: …and listing the compartments that DO exist, so the rename is obvious');
  has(String(warn), 'MISSING SEAM HALF', 'D2: …and saying the consequence is a silent missing half, not an error');

  // Correct names => silence. Without this the check is just noise.
  const g2 = new Graph(work);
  for (const n of ['network', 'netsrv']) g2.addCompartment(n, join(work, n));
  const clean = [];
  C.loadAllContracts(g2, [dir], (m) => clean.push(m));
  ok(!clean.some((m) => m.includes('⚠')), `D2: a spec whose roles all resolve warns about nothing (got: ${clean.join(' | ')})`);

  // THE FALSE POSITIVE THAT MUST NOT COME BACK: the incremental graph holds one
  // compartment; the authoritative set is threaded in via opts.knownCompartments.
  const g3 = new Graph(work);
  g3.addCompartment('netsrv', join(work, 'netsrv'));
  const inc = [];
  C.loadAllContracts(g3, [dir], (m) => inc.push(m), { knownCompartments: ['network', 'netsrv'] });
  ok(!inc.some((m) => m.includes('⚠')),
    `D2: …and on the --files path the caller's authoritative set is honoured, so an ordinary save does not warn about a compartment that exists (got: ${inc.join(' | ')})`);
  const inc2 = [];
  C.loadAllContracts(g3, [dir], (m) => inc2.push(m), { knownCompartments: ['netsrv'] });
  ok(inc2.some((m) => m.includes('⚠') && m.includes('network')),
    'D2: …while a genuinely misspelled name still warns on that same path');

  rmSync(work, { recursive: true, force: true });
}

// --- D3: the SCOPE block no longer contradicts itself -------------------------
// It printed `written UNSCOPED at <root>/contracts` and then listed `<root>/contracts`
// among the "nested (scoped) contracts dirs that it does NOT go into" — the destination
// named as a dir the draft avoids. Cause: rootContractsEntries gives every non-root dir a
// scopeRoot of dirname(dir), so the ROOT's own contracts/ is scoped to <root> and survived
// a `scopeRoot !== null` filter.
async function deferred2ScopeNoteTest() {
  const CONTRACTS = join(HERE, '..', 'scripts', 'contracts.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d2scope-')));
  for (const d of ['client', 'server']) mkdirSync(join(work, d, '.git'), { recursive: true });
  // A real cross-compartment seam so there is something to write.
  writeFileSync(join(work, 'server', 'app.js'),
    "import express from 'express';\nconst app = express();\napp.post('/api/session/refresh', (q, s) => s.send('ok'));\nexport default app;\n");
  writeFileSync(join(work, 'client', 'api.js'),
    "export async function refresh() { return fetch('/api/session/refresh', { method: 'POST' }); }\n");
  mkdirSync(join(work, 'contracts'), { recursive: true });
  mkdirSync(join(work, 'client', 'contracts'), { recursive: true });
  mkdirSync(join(work, '.wiregraph'), { recursive: true });
  writeFileSync(join(work, '.wiregraph', 'state.json'), JSON.stringify({ project: work, mode: 'recursive' }));

  const out = (await execFileP('node', [CONTRACTS, 'scan', work])).stdout;
  has(out, 'SCOPE:', 'D3: the recursive-mode scope note is printed');
  const note = out.slice(out.indexOf('SCOPE:'));
  const dest = join(work, 'contracts');
  const nestedLine = note.split('\n').find((l) => l.includes('does NOT go into')) || '';
  ok(nestedLine.includes(join(work, 'client', 'contracts')),
    `D3: the genuinely nested dir is still listed as one the draft avoids (got: ${nestedLine || 'no such line'})`);
  ok(!nestedLine.includes(`${dest},`) && !nestedLine.endsWith(`${dest}.`),
    `D3: …but the DESTINATION is no longer listed among the dirs it does not go into (got: ${nestedLine})`);
  ok(!note.includes('written UNSCOPED'),
    `D3: …and the note no longer calls a <root>-scoped destination UNSCOPED (got:\n${note})`);
  has(note, `whose scope root is ${work}`, 'D3: …it states the destination\u2019s ACTUAL scope root');
  has(note, 'the whole project tree', 'D3: …and what that scope amounts to');

  rmSync(work, { recursive: true, force: true });
}

// --- D4: the wire side declines out loud, like the resource side --------------
// The resource clusterer has printed "Named constants considered and DECLINED (nothing is
// dropped silently)" since 1b. The wire clusterer printed a reason for exactly ONE case,
// so on a Rust-server project it proposed 2 of 5 real seams, one of them one-sided, and
// said nothing at all about the other three — the user could not tell "no seams exist"
// from "I cannot see your seams". The single-compartment case is the important one: it
// never even reached the reporting loop, because the >=2-compartment gate is what drops it.
async function deferred2WireDeclinedTest() {
  const I = await import('../src/contracts/infer.js');

  const cands = [
    // proposed, complete
    { kind: 'wire', token: '/api/config/reload', role: 'in', compartment: 'web', label: 'post' },
    { kind: 'wire', token: '/api/config/reload', role: 'out', compartment: 'edge', label: 'post' },
    // proposed, but only the caller side is visible — no WIRE edge derives from it
    { kind: 'wire', token: '/api/telemetry/ingest', role: 'out', compartment: 'web', label: 'post' },
    { kind: 'wire', token: '/api/telemetry/ingest', role: 'out', compartment: 'edge', label: 'post' },
    // the server half is Rust, so only the caller emits a candidate at all
    { kind: 'wire', token: '/api/session/refresh', role: 'out', compartment: 'web', label: 'post' },
    // shared by two compartments but too generic to be a join key
    { kind: 'wire', token: '/api', role: 'out', compartment: 'web', label: 'get' },
    { kind: 'wire', token: '/api', role: 'in', compartment: 'edge', label: 'get' },
  ];
  const rejected = [];
  const seams = I.clusterSeams(cands, { rejected });
  eq(JSON.stringify(seams.map((s) => s.token)), JSON.stringify(['/api/config/reload', '/api/telemetry/ingest']),
    'D4: the seam list itself is unchanged — grouping before the distinctiveness gate proposes nothing new');
  ok(rejected.some((r) => r.startsWith('/api/session/refresh (web): seen in only ONE compartment')),
    `D4(a): a token only ONE compartment emits is now DECLINED BY NAME — the case that never reached the reporting loop (got: ${rejected.join(' | ') || 'nothing'})`);
  ok(rejected.some((r) => r.startsWith('/api (')),
    `D4(b): …and a token two compartments share but that is too generic to join on (got: ${rejected.join(' | ') || 'nothing'})`);
  // A token only one compartment mentions AND that is not distinctive is NOT listed: that
  // is every string in the repo, and it would bury the answer.
  const noisy = [];
  I.clusterSeams([{ kind: 'wire', token: '/x', role: 'out', compartment: 'web', label: 'get' }], { rejected: noisy });
  eq(noisy.length, 0, `D4(b): …while a non-distinctive token only one compartment mentions is not listed at all (got ${JSON.stringify(noisy)})`);

  // The report prints it, and flags the incomplete proposal as incomplete.
  const report = I.formatSeams(seams, rejected);
  has(report, 'Seams considered and NOT proposed (nothing is dropped silently)', 'D4(c): the scan report prints the declined list');
  has(report, 'seen in only ONE compartment', 'D4(c): …including the single-compartment case');
  has(report, 'only the CALLER side was recognised', 'D4(c): …and marks the proposal that derives NO edge as incomplete');

  // THE COVERAGE HALF: a route in a language with no route rule produces no candidate at
  // all, so nothing downstream can decline it. The walk's own language census is what makes
  // that sayable.
  const langFiles = new Map([
    ['rust', new Map([['server', 12], ['netcli', 3]])],
    ['typescript', new Map([['web', 4]])],
  ]);
  eq(JSON.stringify(I.wireBlindLanguages(langFiles)),
    JSON.stringify([{ lang: 'rust', files: 15, compartments: ['netcli', 'server'] }]),
    'D4(d): the indexed languages with no route/topic rule are identified');
  const covered = I.formatSeams(seams, rejected, langFiles);
  has(covered, 'COVERAGE — route/topic detection is LANGUAGE-LIMITED', 'D4(d): …and the report says so');
  has(covered, 'rust: 15 file(s) in netcli, server', 'D4(d): …naming the language and the compartments it blinds');
  // A pure TS/JS workspace must see no coverage note at all.
  ok(!I.formatSeams(seams, rejected, new Map([['typescript', new Map([['web', 4]])]])).includes('COVERAGE'),
    'D4(d): …and a workspace with no blind language is not told about a limitation that does not apply to it');
  // The empty case is where the question actually gets asked.
  has(I.formatSeams([], [], langFiles), 'COVERAGE — route/topic detection is LANGUAGE-LIMITED',
    'D4(e): "no seams to infer" carries the coverage note too — that is the answer a user cannot otherwise get');
}

// --- D4e2e: a Rust-server project, through the real CLI -----------------------
// Five real seams. Two are TS<->TS and are proposed (one of them one-sided); two have a
// Rust handler, so only the caller emits a candidate; one is Rust<->Rust and emits nothing
// at all. Before: 2 proposed, silence about the other three.
async function deferred2RustScanTest() {
  const CONTRACTS = join(HERE, '..', 'scripts', 'contracts.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d2rust-')));
  for (const d of ['server', 'netcli']) mkdirSync(join(work, d, 'src'), { recursive: true });
  for (const d of ['web', 'edge']) mkdirSync(join(work, d, 'src'), { recursive: true });
  writeFileSync(join(work, 'server', 'Cargo.toml'), '[package]\nname = "server"\n');
  writeFileSync(join(work, 'netcli', 'Cargo.toml'), '[package]\nname = "netcli"\n');
  writeFileSync(join(work, 'web', 'package.json'), '{ "name": "web" }\n');
  writeFileSync(join(work, 'edge', 'package.json'), '{ "name": "edge" }\n');
  writeFileSync(join(work, 'server', 'src', 'main.rs'),
    'use axum::{routing::post, routing::get, Router};\n\n'
    + 'pub fn build_router() -> Router {\n    Router::new()\n'
    + '        .route("/api/session/refresh", post(refresh_session))\n'
    + '        .route("/api/world/snapshot", get(world_snapshot))\n'
    + '        .route("/api/telemetry/ingest", post(ingest_telemetry))\n}\n\n'
    + 'pub async fn refresh_session() -> &\'static str { "ok" }\n'
    + 'pub async fn world_snapshot() -> &\'static str { "snap" }\n'
    + 'pub async fn ingest_telemetry() -> &\'static str { "ok" }\n');
  writeFileSync(join(work, 'netcli', 'src', 'lib.rs'),
    'pub async fn fetch_snapshot(c: &reqwest::Client) -> String {\n'
    + '    c.get("http://server/api/world/snapshot").send().await.unwrap().text().await.unwrap()\n}\n');
  writeFileSync(join(work, 'web', 'src', 'api.ts'),
    "export async function refreshSession() { return fetch('/api/session/refresh', { method: 'POST' }); }\n"
    + "export async function sendTelemetry(b) { return fetch('/api/telemetry/ingest', { method: 'POST', body: b }); }\n");
  writeFileSync(join(work, 'web', 'src', 'admin.ts'),
    "import express from 'express';\nconst app = express();\napp.post('/api/config/reload', (q, s) => s.send('ok'));\nexport default app;\n");
  writeFileSync(join(work, 'edge', 'src', 'relay.ts'),
    "export async function relayTelemetry(b) { return fetch('/api/telemetry/ingest', { method: 'POST', body: b }); }\n"
    + "export async function reloadConfig() { return fetch('/api/config/reload', { method: 'POST' }); }\n");

  const out = (await execFileP('node', [CONTRACTS, 'scan', work])).stdout;
  has(out, 'Found 2 cross-compartment seam(s)', 'D4-e2e: the two TS<->TS seams are still proposed (the fix adds no seam)');
  has(out, '/api/telemetry/ingest', 'D4-e2e: …including the one with no handler side');
  has(out, 'only the CALLER side was recognised', 'D4-e2e: …which is now marked as deriving no edge, instead of looking complete');
  has(out, '/api/session/refresh (web): seen in only ONE compartment',
    'D4-e2e: the seam whose handler is a Rust route is DECLINED BY NAME (it was absent from every list)');
  has(out, 'rust: 2 file(s) in netcli, server',
    'D4-e2e: …and the Rust<->Rust seam, which emits no candidate at all, is covered by the language census — the only way it can be reported');
  has(out, 'declare the seam by hand in a *.asyncapi.yaml spec', 'D4-e2e: …with the action that actually works today');

  rmSync(work, { recursive: true, force: true });
}

// --- D5: the two ALSO findings, as inspected ----------------------------------
// (a) A resource spec that loses every id to a collision mints NO node, and
//     `trace_contract` answers "No contract matches" with nothing tying the two facts
//     together. Keeping a token-less node was REJECTED — it has no defined-token set,
//     derives nothing, and would report as total drift on every build, and
//     wave2HandWrittenPrecedenceTest pins the opposite deliberately. What was missing is
//     the sentence that makes the disappearance findable, so that is what was added.
// (b) A 2.x and a 3.0 spec sharing a title MERGE, and the 2.x channel KEY becomes a token
//     of the merged node. Refusing the merge was REJECTED: each doc's tokens are harvested
//     under ITS OWN version's rules, so the 2.x key is a legitimate address, and refusing
//     would split a contract in two for anyone migrating one file at a time. The merge is
//     named instead.
async function deferred2AlsoFindingsTest() {
  const C = await import('../src/extract/contracts.js');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cg-d2also-')));
  const dir = join(work, 'contracts');
  mkdirSync(dir, { recursive: true });

  // (a) two hand-written specs, one of which loses its only id.
  writeFileSync(join(dir, 'a-first.resource.yaml'),
    'title: First Resources\nresources:\n  - id: LEDGER_STATE_PATH\n    kind: path\n    writers: [alpha]\n    readers: [beta]\n');
  writeFileSync(join(dir, 'b-second.resource.yaml'),
    'title: Second Resources\nresources:\n  - id: LEDGER_STATE_PATH\n    kind: path\n    writers: [gamma]\n    readers: [delta]\n');
  const logs = [];
  const merged = C.loadAllContracts(new Graph(work), [dir], (m) => logs.push(m));
  ok(!merged.some((c) => c.name === 'Second Resources'),
    'D5(a): a resource contract with no surviving ids still mints no node (keeping a token-less node was rejected — see the comment)');
  const gone = logs.find((m) => m.includes('NO surviving resource ids'));
  ok(gone, `D5(a): …but the loader now SAYS the contract disappeared (got: ${logs.join(' | ')})`);
  has(String(gone), 'No contract matches',
    'D5(a): …and names the exact symptom the user will hit in trace_contract, so the two are connectable');

  // (b) a cross-version title merge.
  writeFileSync(join(dir, 'modern.asyncapi.yaml'),
    "asyncapi: 3.0.0\ninfo:\n  title: Shared Title\n  version: '1.0.0'\nchannels:\n  m:\n    address: /modern/route/here\n");
  writeFileSync(join(dir, 'legacy.asyncapi.yaml'),
    "asyncapi: 2.6.0\ninfo:\n  title: Shared Title\n  version: '1.0.0'\nchannels:\n  player/updates/stream:\n    publish:\n      message:\n        payload:\n          type: object\n");
  const logs2 = [];
  const merged2 = C.loadAllContracts(new Graph(work), [dir], (m) => logs2.push(m));
  const shared = merged2.find((c) => c.name === 'Shared Title');
  ok(shared, 'D5(b): the cross-version merge is NOT refused');
  eq(JSON.stringify([...(shared?.tokens || [])].sort()), JSON.stringify(['/modern/route/here', 'player/updates/stream']),
    'D5(b): …so both specs keep their tokens, each harvested under its own version\u2019s rules');
  const xver = logs2.find((m) => m.includes('DIFFERENT AsyncAPI versions'));
  ok(xver, `D5(b): …and the merge is reported rather than silent (got: ${logs2.join(' | ')})`);
  has(String(xver), '2.x and 3.x', 'D5(b): …naming both versions');
  has(String(xver), 'distinct info.titles', 'D5(b): …and the remedy, since it is intended rather than an error');

  rmSync(work, { recursive: true, force: true });
}
// === DEFERRED-2 TESTS END ===

await rootFallbackPartitionTest();
await legacyCodegraphHookLogTest();
await unmountedMemberFanOutTest();
await resourceRoleScopeTest();

await polishSharedPartitionMemoTest();
await polishInferredSeamsExcludeDeclaredTest();
await polishBuildWarningsRenderedTest();
await polishProjectCopyTest();

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
await resourceSpecFormatTests();
await resourceContractTests();
await resourceIncrementalSeamTest();
await resourceInferenceTests();
await phantomSeamDefinitionSiteTest();
await resourceInferenceCliTest();
await definitionSitePositionTest();
await commentIsNotAReferenceTest();
await resourceValueRuleTests();
await valueUnknownExclusionTest();
await resourceSpecTitleMergeTest();
await totalOverlapWarningTest();
await fanOutCapTest();
await resourceKindTest();
await duplicateContractSeamTest();
await pruneFileDerivedEdgeTest();
await recursiveDiscoveryTest();
await initContractsStructureTest();
await contractScopingTest();
await unscopedContractSourcesTest();
await distinctContractTitleTest();
await recursiveIncrementalParityTest();
await nestedFixtureGlobalModeTest();
await contractsFingerprintUnitTest();
await contractsDirMoveTest();
await contractsOverrideThenIncrementalTest();
await contractsAddGapTest();
await contractsSpecMoveTest();
await contractsTitleEditTest();
await globalContractsStalenessTest();
await legacyNoContractsStampTest();
await contractsHookHealTest();
await sameProcessDiscoveryTest();
await mergedUnscopedStaysUnscopedTest();
await rootIsContractsHomeScopeTest();
await scopePrefixGuardTest();
await traceShadowedTokenTest();
await traceShadowedSiblingTest();
await nudgeGatePluralTest();
// --- WAVE 3 ---
await renamePruneTest();
await renameSwapCompartmentsTest();
await healMarkerUnreadableTest();
await hookWarningsPersistedTest();
await inferredBasenameCollisionTest();
await lockDebrisTests();
await wave2ImportProseTest();
await wave2ImportProseE2ETest();
await wave2HandWrittenPrecedenceTest();
await wave2HandWrittenPrecedenceE2ETest();
await wave2InferenceExcludesDeclaredTest();
await wave2ContractsCliExcludesDeclaredTest();
await wave2AsyncApi2xTest();
await wave2AsyncApi2xE2ETest();

// --- DEFERRED-3 ---
await d3ShadowedNotDriftTest();
await d3ShadowedVerdictSiblingGateTest();
await d3BuildWarningsEveryPathTest();
await d3MultiLineWarningBlockTest();
await d3RenameIsNotALossTest();
await d3MalformedFingerprintTest();
await d3ClearNothingToClearTest();
await d3SymbolCountAgreementTest();
await d3TraceContractListingTest();
await d3SchemaStampDisagreementTest();
await d3ForeignDbTest();

// --- DEFERRED-2 ---
await deferred2AuthorshipTest();
await deferred2AuthorshipE2ETest();
await deferred2WireRoleValidationTest();
await deferred2ScopeNoteTest();
await deferred2WireDeclinedTest();
await deferred2RustScanTest();
await deferred2AlsoFindingsTest();
rmSync(process.env.WIREGRAPH_REGISTRY, { force: true }); // drop the throwaway registry
rmSync(process.env.WIREGRAPH_LINKS_HISTORY, { force: true }); // and the throwaway tombstone
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
