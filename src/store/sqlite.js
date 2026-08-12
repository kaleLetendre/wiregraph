// Embedded SQLite backend — a daemon-free, ZERO-NATIVE-BUILD, cross-platform
// alternative to the Neo4j server. Backed by sql.js (SQLite compiled to WASM):
// the .wasm ships inside the npm package, so install needs no prebuilt-binary
// match and no C/C++ toolchain — it works on a bare machine with only Node. The
// graph is small (thousands of nodes), so a single .db file (standard SQLite
// format) loaded into memory + in-JS traversals matches Neo4j's behavior with no
// JVM, no server, no port. Every row carries `project` so one file can hold many
// projects' graphs (namespaced), exactly like the Neo4j backend.
//
// A thin adapter below presents the small slice of the better-sqlite3 API the
// store uses (prepare().run/get/all, exec, transaction, close) on top of sql.js,
// so the query + loader code is backend-agnostic. sql.js is in-memory: a writable
// connection persists on close() by exporting the db and atomically replacing the
// file; a readonly connection just frees memory.
//
// Because the whole writable session is read-file -> mutate-in-memory ->
// rename-file, two concurrent writers (e.g. the PostToolUse refresh worker firing
// for two quick edits) would each load the same snapshot and the later rename
// would clobber the earlier writer's changes — a lost update, not just a torn
// read. A writable connect() therefore takes a cross-process advisory lock
// (<db>.lock) for the lifetime of the session, so writers serialize. Read-only
// connections (the MCP query path) never lock and never wait.

import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync, rmSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { readState } from '../../scripts/lib/state.mjs';
import { walkSources } from '../extract/walk.js';
import { buildWireEdges, buildResourceEdges, buildInprocEdges } from '../extract/contracts.js';

// Edge types that are DERIVED from contract REFERENCES rather than parsed from
// source: the wire seam (producer->consumer), the resource seam (writer->reader) and the
// in-process seam (provider->consumer).
// Every place that prunes or re-derives one must handle ALL of them — pruneFile and
// rederiveWireEdges below — or the type that was forgotten is deleted on every file
// save and never rebuilt, while every full-build test still passes.
//
// APPEND-ONLY, and the append is the WHOLE registration for a new derived type: this list
// drives DERIVED_EDGE_SQL_LIST (the prune's DELETE and the re-derive's DELETE), the
// contract-keyed dedup in loadGraph, and the re-derive's log line. Adding a type here
// WITHOUT adding its builder to rederiveWireEdges below silently drops that type's seams
// on the first file save after a full build — see the note there.
export const DERIVED_EDGE_TYPES = ['WIRE', 'RESOURCE', 'INPROC'];
const DERIVED_EDGE_SQL_LIST = DERIVED_EDGE_TYPES.map((t) => `'${t}'`).join(',');

const require = createRequire(import.meta.url);
// Resolve the bundled wasm next to the sql.js package (no network, no compile).
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });

// Bump when the on-disk schema changes shape. A .db stamped with an older version
// is reported stale (server turns this into "run /wiregraph-rebuild") rather than
// queried with the wrong assumptions.
// v2 adds files.mtime/size so staleness is "differs from what was indexed" (disk
// mtime/size vs recorded), not "differs from the last committed git sha" — the
// latter falsely flags an uncommitted-but-already-reindexed file as stale forever.
// v3 renames the graph-attribution unit from "repo" to "compartment": the `repos`
// table -> `compartments`, and the `repo` column on files/symbols -> `compartment`
// (a compartment is a .git repo OR a module manifest boundary — see walk.js).
// v4 adds the `contract_tokens` table: the FULL set of wire tokens each contract
// defines, persisted so trace_contract can diff defined-vs-referenced and report
// DRIFT (a contract token no code references, or a token only one side touches).
// Before v4 the token set was computed at build time, used to mint REFERENCES
// edges, then discarded — so a drifted-away contract left no trace to detect.
// v5 adds files.hash: a per-file CONTENT hash stamped at index time, so the
// invalid-baseline content-reconcile (build.js) can CONFIRM a "probably unchanged"
// candidate (mtime+size still match the recorded stamp) by content. Without it a
// same-size, mtime-PRESERVED edit (cp -p / rsync -a / tar / coarse-mtime FS) reads
// as unchanged and its stale symbols linger — a real correctness miss (MED-2).
export const SCHEMA_VERSION = 5;

// better-sqlite3 binds a single object arg as NAMED params (SQL `@key` <- obj.key)
// and any other args as POSITIONAL (`?`). sql.js wants the `@` sigil in the keys
// for named, and an array for positional — translate here.
function normParams(args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const o = {};
    for (const k of Object.keys(args[0])) o['@' + k] = args[0][k];
    return o;
  }
  return args.length ? args : undefined;
}

class Stmt {
  constructor(raw) { this.raw = raw; }
  run(...a) { const p = normParams(a); p === undefined ? this.raw.run() : this.raw.run(p); return this; }
  get(...a) { const p = normParams(a); this.raw.reset(); if (p !== undefined) this.raw.bind(p); const got = this.raw.step() ? this.raw.getAsObject() : undefined; this.raw.reset(); return got; }
  all(...a) { const p = normParams(a); this.raw.reset(); if (p !== undefined) this.raw.bind(p); const out = []; while (this.raw.step()) out.push(this.raw.getAsObject()); this.raw.reset(); return out; }
}

// Cross-process advisory lock for writable sessions. A lockfile is created with
// the exclusive 'wx' flag (atomic create-or-fail) and holds the writer's PID;
// contenders spin with a blocking sleep until it frees. On contention we decide
// whether to STEAL the lock by the HOLDER'S LIVENESS, not by a wall-clock timer,
// because the writable session is NOT always short. fullBuild connects late
// (after the parse/walk), but incrementalBuild (src/build.js) connects EARLY and
// holds the lock through extractCode + resolveCalls + loadProjectSymbols +
// loadAllContracts + matchContracts (which walks every source file in the owner
// roots) — so a legitimate live writer can hold the lock for well over any fixed
// 30s window on a big changed file / large contracts dir / loaded machine. An
// mtime-based steal would rip the lock out from under such a writer and let a
// second writer's rename clobber its update — the lost update the lock exists to
// prevent (bug M9).
//
// So: a lock held by a LIVE pid is a live session (however slow) and is waited
// out; a lock whose holder is DEAD (crashed) is stolen immediately — which also
// makes crash recovery instant instead of waiting out a timer. Two backstops:
//   - LOCK_HARD_MAX_MS: even a live holder is stolen once the lock is this old,
//     guarding against PID reuse (an unrelated live process now owns the number)
//     or a wedged holder that never releases.
//   - LOCK_STALE_MS (mtime): used ONLY when the PID is missing/unparseable — the
//     tiny race where the lockfile exists (openSync 'wx' won) but its PID has not
//     been written yet. We don't know the holder, so we fall back to the old
//     staleness check rather than steal a possibly-fresh live lock.
// A third case sits outside shouldStealLock entirely: a lock path we cannot STAT
// or READ at all (a DIRECTORY at <db>.lock, a chmod-000 file, another user's
// file, a dangling symlink, a symlink to a directory). That is debris, not a
// claim by anyone, and acquireLock steals it immediately — waiting on it could
// never end because nothing about it will ever change.
// ms-scale blocking is fine in these one-shot CLI/worker processes.
//
// Invariant: the wait deadline (LOCK_TIMEOUT_MS) is > LOCK_HARD_MAX_MS, so a
// contender always waits long enough to either steal a dead holder or outlast a
// legit long-but-live one — the hard-max steal fires before we give up. (The old
// 60s timeout was shorter than a long incremental build and would throw early.)
const LOCK_STALE_MS = 30_000;          // mtime staleness — used only for the unparseable-PID fallback
const LOCK_HARD_MAX_MS = 5 * 60_000;   // steal even a LIVE holder past this age (PID reuse / wedged holder)
const LOCK_TIMEOUT_MS = LOCK_HARD_MAX_MS + LOCK_STALE_MS; // absolute wait deadline; > HARD_MAX so a steal can fire first
const LOCK_MAX_BYTES = 64;             // a lock file holds a decimal PID; anything larger is not one (don't read it)

function sleepSync(ms) {
  // Block the thread without burning CPU (no async context to await in).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Is `pid` a live process? process.kill(pid, 0) sends no signal, it only probes:
// success => alive; EPERM => the process EXISTS but we can't signal it (still
// alive); ESRCH => no such process (dead).
function defaultAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// Pure steal decision, injectable for tests. Given the parsed holder pid (or null
// when the lockfile has no readable PID yet), the lock's age in ms, and a liveness
// probe, return 'steal' or 'wait':
//   - pid known + holder DEAD     -> 'steal' (crash recovery, immediate)
//   - pid known + holder ALIVE    -> 'wait', unless ageMs > LOCK_HARD_MAX_MS
//                                    (PID reuse / wedged holder) -> 'steal'
//   - pid null/unparseable        -> mtime fallback: 'steal' only if
//                                    ageMs > LOCK_STALE_MS, else 'wait'
export function shouldStealLock({ pid, ageMs, aliveFn = defaultAlive }) {
  if (pid == null || !Number.isInteger(pid)) {
    return ageMs > LOCK_STALE_MS ? 'steal' : 'wait';
  }
  if (ageMs > LOCK_HARD_MAX_MS) return 'steal';
  return aliveFn(pid) ? 'wait' : 'steal';
}

function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Something occupies the lock path. Inspect it and decide steal-vs-wait.
      //
      // A lock we cannot STAT or READ is NOT evidence of a live claim — it is
      // debris: a DIRECTORY at <db>.lock, a chmod-000 file, a file owned by
      // another user, a dangling symlink, a symlink to a directory, or a lock
      // that vanished between the open and the read. Waiting on debris can never
      // end, because nothing about it will ever change on its own; so anything we
      // cannot inspect is STEALABLE. (This is the same conclusion the <db>.heal
      // marker reaches in scripts/hooks/refresh.mjs.) The old code `continue`d on
      // a read/stat throw, which skipped the deadline check below and turned a
      // directory at <db>.lock into an unbounded, silent spin.
      let decision = 'steal';
      try {
        const st = statSync(lockPath); // follows symlinks: a link to a real lock is a real lock
        // Only a regular file can be a lock. A directory / symlink-to-directory /
        // fifo / socket here is debris, and must never be read (reading a fifo
        // would block forever — a second way to hang).
        if (st.isFile()) {
          const ageMs = Date.now() - st.mtimeMs;
          // A lock holds a decimal PID and nothing else. Anything bigger is not a
          // PID: treat it as unparseable (the mtime fallback below) WITHOUT
          // reading it, so a huge file is not slurped once per 50ms poll.
          let pid = null;
          if (st.size <= LOCK_MAX_BYTES) {
            const raw = readFileSync(lockPath, 'utf8').trim();
            const n = Number.parseInt(raw, 10);
            pid = Number.isInteger(n) && String(n) === raw ? n : null; // reject empty/garbage/partial writes
          }
          decision = shouldStealLock({ pid, ageMs });
        }
      } catch { decision = 'steal'; /* unstat-able / unreadable -> debris, not a claim */ }

      let cleared = false;
      if (decision === 'steal') {
        // force: tolerate the lock vanishing under us (another contender stole it
        // first). recursive: a DIRECTORY at the lock path has to go too — plain
        // rmSync refuses one with ERR_FS_EISDIR, which is how the spin started.
        // A failed removal (e.g. read-only parent dir) is NOT fatal: we fall
        // through to the poll + deadline below and eventually time out loudly.
        try { rmSync(lockPath, { force: true, recursive: true }); cleared = true; }
        catch { /* could not clear it — wait it out and let the deadline fire */ }
      }
      // Reached on EVERY path through the loop, the steal path included: a lock we
      // can neither read nor remove must still end in a thrown timeout rather than
      // an unbounded spin. Nothing here may `continue` past this check.
      if (Date.now() > deadline) throw new Error(`wiregraph: timed out waiting for db lock ${lockPath}`);
      if (!cleared) sleepSync(50); // a successful steal retries at once (instant crash recovery)
    }
  }
}

function releaseLock(lockPath) {
  try { rmSync(lockPath, { force: true }); } catch { /* best-effort */ }
}

class DB {
  constructor(db, path, readonly, lockPath = null) { this._db = db; this._path = path; this._readonly = readonly; this._lockPath = lockPath; }
  prepare(sql) { return new Stmt(this._db.prepare(sql)); }
  exec(sql) { this._db.exec(sql); return this; }
  pragma() { /* no-op: in-memory WASM db, no WAL/journal to set */ return this; }
  transaction(fn) {
    return (...args) => {
      this._db.exec('BEGIN');
      try { const r = fn(...args); this._db.exec('COMMIT'); return r; }
      catch (e) { try { this._db.exec('ROLLBACK'); } catch { /* */ } throw e; }
    };
  }
  // persist:true (default) writes the in-memory db back to disk on a writable
  // connection; persist:false DISCARDS the in-memory mutations, leaving the
  // last-good on-disk file untouched — used by the incremental path to bail out
  // without persisting a half-applied prune+reload after an error. Either way the
  // WASM db is freed and the lock is always released.
  close({ persist = true } = {}) {
    try {
      if (persist && !this._readonly) {
        const tmp = this._path + '.tmp';
        writeFileSync(tmp, Buffer.from(this._db.export()));
        renameSync(tmp, this._path); // atomic replace, so a concurrent reader never sees a torn file
      }
      this._db.close();
    } finally {
      if (this._lockPath) releaseLock(this._lockPath);
    }
  }
}

export function connect(dbPath, { readonly = false } = {}) {
  if (readonly) {
    const db = existsSync(dbPath) ? new SQL.Database(readFileSync(dbPath)) : new SQL.Database();
    return new DB(db, dbPath, true);
  }
  // Writable: lock first, THEN read — so the read-modify-write is atomic against
  // other writers (a lock taken after the read would not protect the snapshot).
  mkdirSync(dirname(dbPath), { recursive: true });
  const lockPath = dbPath + '.lock';
  acquireLock(lockPath);
  try {
    const db = existsSync(dbPath) ? new SQL.Database(readFileSync(dbPath)) : new SQL.Database();
    return new DB(db, dbPath, false, lockPath);
  } catch (e) {
    releaseLock(lockPath);
    throw e;
  }
}

// The schema version stored in the db (0 if absent / pre-versioning). Safe on a
// readonly connection and on a db built before the meta table existed.
export function schemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return row ? Number(row.value) : 0;
  } catch {
    return 0; // meta table doesn't exist yet
  }
}

// The file header's `user_version` read from an ALREADY-OPEN db (the cheap 64-byte probe
// below reads it from the path instead). 0 when absent, matching stampedSchemaVersion's
// "absent means UNKNOWN, never outdated" rule.
function userVersion(db) {
  try { return Number(db.prepare('PRAGMA user_version').get()?.user_version) || 0; }
  catch { return 0; }
}

// One `meta` row, or null. Total: the table may not exist on a pre-versioning db.
function metaValue(db, key) {
  try { return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null; }
  catch { return null; }
}

// --- cheap schema probe -----------------------------------------------------
// Both incremental entry points — the hook worker (scripts/hooks/refresh.mjs) and the
// MCP server (src/mcp/server.js) — must gate on "is this db older than the schema I
// write?" before every incremental, for EVERY graph they can write into. That is a
// per-edit, per-graph question about an event that happens once per release, so it
// lives here (next to the loader that writes both stamps) rather than being duplicated
// at each caller.

// The schema version stamped in a db WITHOUT opening it: the SQLite file header's
// user_version field is a fixed 4-byte big-endian slot at byte 60, so this is one
// 64-byte read no matter how big the graph is. connect() is NOT an acceptable
// substitute on this path — sql.js has no partial read, so it copies the entire file
// into the WASM heap (sub-ms on a small graph, ~13ms on a 20MB one). loadGraph writes
// this slot in the same transaction as meta.schema_version. Returns 0 when the stamp is
// ABSENT — a db written before that mirror existed, or not a SQLite file at all.
export function stampedSchemaVersion(dbPath) {
  let fd;
  try {
    fd = openSync(dbPath, 'r');
    const head = Buffer.alloc(64);
    if (readSync(fd, head, 0, 64, 0) < 64) return 0;
    if (head.subarray(0, 15).toString('latin1') !== 'SQLite format 3') return 0;
    return head.readUInt32BE(60);
  } catch { return 0; }
  finally { try { if (fd !== undefined) closeSync(fd); } catch { /* */ } }
}

// Where `dbPath` sits relative to the schema this wiregraph writes:
//   'missing'    — nothing built yet (not a schema problem; the caller surfaces NOT_BUILT)
//   'current'    — safe to write incrementally
//   'older'      — MIGRATE (a full --reset build) before any incremental touches it
//   'newer'      — written by a later wiregraph; leave it alone. A reset would recreate
//                  the tables at THIS (older) schema, silently downgrading, so this is
//                  deliberately NOT reported as a problem to fix — loadGraph's explicit
//                  refusal and the server's "update wiregraph" message handle it.
//   'unreadable' — corrupt / not a db. Not a schema verdict; whatever the caller does
//                  next hits the same error and reports it through its own path.
//
// The ABSENT header stamp is the case that matters. A 0 stamp means "unknown", NEVER
// "outdated": reading it as outdated would force a full rebuild of every project built
// before the mirror existed, on its very next edit — a far worse regression than the
// cost being saved here. So 0 falls back to the authoritative `meta` row, which does
// need the full open; correctness is unchanged, only the price. Once any build stamps
// the header, every later probe takes the cheap path.
export function schemaStatus(dbPath) {
  if (!existsSync(dbPath)) return 'missing';
  const rank = (v) => (v === SCHEMA_VERSION ? 'current' : v < SCHEMA_VERSION ? 'older' : 'newer');
  const stamped = stampedSchemaVersion(dbPath);
  if (stamped > 0) return rank(stamped);
  let db;
  try { db = connect(dbPath, { readonly: true }); return rank(schemaVersion(db)); }
  catch { return 'unreadable'; }
  finally { try { db?.close(); } catch { /* */ } }
}

// Sugar for the callers that only need the one verdict that demands action.
export function schemaOutdated(dbPath) {
  return schemaStatus(dbPath) === 'older';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta        (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS compartments(id TEXT PRIMARY KEY, project TEXT, name TEXT, root TEXT);
CREATE TABLE IF NOT EXISTS files       (id TEXT PRIMARY KEY, project TEXT, compartment TEXT, path TEXT, lang TEXT, mtime REAL, size INTEGER, hash TEXT);
CREATE TABLE IF NOT EXISTS symbols     (id TEXT PRIMARY KEY, project TEXT, compartment TEXT, file TEXT, name TEXT, kind TEXT, lang TEXT, startLine INTEGER, endLine INTEGER);
CREATE TABLE IF NOT EXISTS contracts   (id TEXT PRIMARY KEY, project TEXT, name TEXT, file TEXT);
CREATE TABLE IF NOT EXISTS contract_tokens(project TEXT, contract TEXT, token TEXT, direction TEXT, producers TEXT, consumers TEXT);
CREATE TABLE IF NOT EXISTS edges       (type TEXT, src TEXT, dst TEXT, project TEXT, token TEXT, cnt INTEGER, resolution TEXT, evidence TEXT, direction TEXT, contract TEXT);
CREATE INDEX IF NOT EXISTS idx_sym_name ON symbols(project, name);
CREATE INDEX IF NOT EXISTS idx_sym_file ON symbols(project, compartment, file);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(project, type, src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(project, type, dst);
CREATE INDEX IF NOT EXISTS idx_edges_proj ON edges(project, type);
CREATE INDEX IF NOT EXISTS idx_ctok ON contract_tokens(project, contract);
`;

const TABLES = ['compartments', 'files', 'symbols', 'contracts', 'contract_tokens', 'edges', 'meta'];

export function loadGraph(db, graph, { reset = false, log = () => {}, allowReducedUnion = false } = {}) {
  const project = graph.project;
  // If an existing db was written by a different schema version, a full --reset
  // build migrates it by dropping + recreating the tables (the db is per-project,
  // so this is the rebuild path; incremental against a stale schema is refused by
  // the server, which prompts /wiregraph-rebuild). A fresh file reports version 0
  // and is harmlessly (re)created here too.
  const priorVersion = schemaVersion(db);
  // Never downgrade: a db written by a NEWER wiregraph must not be dropped and
  // recreated at this older schema (silent data loss). Refuse loudly instead.
  if (priorVersion > SCHEMA_VERSION) {
    throw new Error(`refusing to write: db schema v${priorVersion} is newer than this wiregraph (v${SCHEMA_VERSION}). Update wiregraph instead of downgrading the graph.`);
  }

  // --- THE TWO SCHEMA STAMPS MUST AGREE, AND A DISAGREEMENT IS NOT SELF-HEALING ---
  // `meta.schema_version` is the AUTHORITATIVE stamp and the file header's `user_version`
  // is its cheap mirror; they are written in one transaction below precisely so they cannot
  // diverge. When they HAVE diverged — a hand edit, an older tool, a partial write — the
  // cheap probe is the only gate on the hook path (schemaStatus short-circuits on a non-zero
  // header), so with meta=3 and header=5 the value the code calls authoritative was never
  // read, no migration ran, and the incremental below RESTAMPED meta to 5. The db then
  // CLAIMS to be current while physically on the old shape, permanently defeating every
  // downstream check including the MCP server's — the silent-restamp trap §1 of the design
  // describes, which is exactly the failure mode a schema gate exists to prevent.
  //
  // So detect it and REFUSE, rather than restamp. Only on the incremental path: a `reset`
  // build DROPs and recreates every table below when priorVersion !== SCHEMA_VERSION, which
  // is a real migration and the remedy this error names. A 0 on either side means ABSENT,
  // never "disagrees" — a pre-mirror db (header 0) and a pre-meta db (meta 0) are both
  // legitimate and must keep working, the same rule schemaStatus applies to its own probe.
  const headerVersion = userVersion(db);
  if (!reset && priorVersion > 0 && headerVersion > 0 && priorVersion !== headerVersion) {
    throw new Error(
      `refusing to write: this db's two schema stamps DISAGREE — meta.schema_version=${priorVersion} but the file `
      + `header's user_version=${headerVersion}. They are written in one transaction, so a mismatch means the file was `
      + 'edited or written by another tool, and the cheap header probe every incremental gates on is therefore lying. '
      + 'An incremental would restamp it as current WITHOUT migrating. Run a full rebuild (/wiregraph-rebuild, or '
      + 'update_graph {full:true}) — it recreates the tables at the current schema and rewrites both stamps together.',
    );
  }

  // --- WHOSE GRAPH IS THIS? ------------------------------------------------------
  // A `graph.db` from ANOTHER project, dropped in place, was never detected. Every id is
  // project-FREE (src/model.js), so the file looks like a plausible graph; one incremental
  // then prunes under THIS project's tag, misses every foreign row, and re-inserts — leaving
  // hundreds of rows carrying the other project's tag, while `INSERT OR REPLACE` on the
  // compartment id means this project's own compartment row is REPLACED by the foreign one.
  // No warning, no escalation, and no self-heal short of a full rebuild. A `cp -a` of a whole
  // PROJECT is caught by the copy sentinel (scripts/lib/state.mjs) because it carries a
  // state.json to compare; the bare-db case carries nothing, so the db has to say who owns it.
  //
  // A MOVE IS NOT A FOREIGN DB, and the test is the same decisive existsSync the copy
  // sentinel uses: after `mv proj proj2` the recorded owner path no longer holds a wiregraph
  // project, so this is a move and the incremental proceeds (and restamps the owner). If the
  // recorded owner is STILL a wiregraph project sitting there, this db belongs to it.
  const owner = metaValue(db, 'project_root');
  if (!reset && project && owner && owner !== project) {
    let ownerLives = false;
    try { ownerLives = !!readState(owner); } catch { /* unreadable — treat as gone */ }
    if (ownerLives) {
      throw new Error(
        `refusing to write: this graph db was built for a DIFFERENT project (${owner}), which still exists — so this is `
        + `a foreign db, not a moved one. Incrementally updating it would prune under ${project} while hundreds of rows `
        + `stay tagged ${owner}, and the compartment rows would silently overwrite each other. Delete `
        + '.wiregraph/graph.db and run a full rebuild (/wiregraph-rebuild, or update_graph {full:true}).',
      );
    }
    log(`  adopting a graph db previously owned by ${owner} (that path is no longer a wiregraph project — treating it as a move)`);
  }
  if (reset && !project) throw new Error('sqlite loadGraph --reset requires graph.project');

  // Member-losing-reset backstop (last line of defense for the link feature), run
  // BEFORE any destructive table op (the schema-migration DROP below, and the
  // in-transaction DELETE further down). A --reset wipes every row tagged with this
  // project, then reloads only what the incoming graph holds. If this graph has
  // linked members but the incoming graph was built from a single root (a stray
  // rebuild that didn't go through the union walk), that wipe would silently erase
  // the members — so refuse BEFORE dropping/recreating anything. Ordering matters:
  // if a member-losing reset ALSO crosses a schema version, running this check after
  // the DROP would empty the tables, then throw, and close() would persist the
  // emptied db — defeating the backstop exactly when it is needed. A member whose
  // directory no longer exists is exempt (dropping a vanished member is legitimate),
  // and so is a member that produces NO indexable source (a docs/proto-only repo, or
  // a language wiregraph doesn't parse): it contributes no compartments even during
  // a correct union rebuild, so its absence from the rebuilt graph is expected — not
  // evidence of a stray reset.
  //
  // allowReducedUnion opts OUT of this backstop: the caller passed an EXPLICIT root
  // union (build's opts.roots override) that is the declared source of truth, so a
  // member present in state.json but absent from the rebuild is INTENTIONAL — not a
  // stray narrow reset. unlink relies on this: it rebuilds each graph over the reduced
  // union (peer dropped) WHILE the link records still exist, retracting them only after
  // both rebuilds succeed, so a crash leaves a re-runnable fully-linked pair.
  if (reset && project && !allowReducedUnion) {
    try {
      const st = readState(project);
      const links = (st && Array.isArray(st.links)) ? st.links : [];
      if (links.length) {
        const memberRootPaths = links.map((l) => (typeof l === 'string' ? l : l && l.root)).filter(Boolean);
        const graphRoots = [...graph.compartments.values()].map((c) => c.root).filter(Boolean);
        const covers = (m) => graphRoots.some((gr) => gr === m || gr.startsWith(m + sep) || m.startsWith(gr + sep));
        // A member counts as "lost" only if it actually holds indexable code — else a
        // correct union rebuild would legitimately produce no compartments for it, and
        // its absence is not a stray-reset symptom. walkSources yields exactly the
        // parseable files extractCode turns into compartments, so an empty walk ⇔ no
        // compartments. This walk only runs for members NOT already covered by the
        // rebuild (the rare/error path), so it costs nothing on a normal union reset.
        const hasSource = (m) => { try { for (const _ of walkSources(m)) return true; } catch { /* unreadable — treat as no code */ } return false; };
        const missing = memberRootPaths.filter((m) => existsSync(m) && !covers(m) && hasSource(m));
        if (missing.length) {
          throw new Error(`refusing to --reset: the rebuild graph for project ${project} is missing linked member(s) ${missing.join(', ')} — a single-root reset would erase them. Rebuild over the full union (memberRoots).`);
        }
      }
    } catch (e) {
      if (/refusing to --reset/.test(e.message)) throw e;
      // A readState/walk failure must not block the reset on the backstop's own error.
    }
  }

  if (reset && priorVersion !== SCHEMA_VERSION) {
    for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    if (priorVersion) log(`  migrating store schema v${priorVersion} -> v${SCHEMA_VERSION} (recreate)`);
  }
  db.exec(SCHEMA);

  const insCompartment = db.prepare('INSERT OR REPLACE INTO compartments (id,project,name,root) VALUES (@id,@project,@name,@root)');
  const insFile = db.prepare('INSERT OR REPLACE INTO files (id,project,compartment,path,lang,mtime,size,hash) VALUES (@id,@project,@compartment,@path,@lang,@mtime,@size,@hash)');
  const insSym = db.prepare('INSERT OR REPLACE INTO symbols (id,project,compartment,file,name,kind,lang,startLine,endLine) VALUES (@id,@project,@compartment,@file,@name,@kind,@lang,@startLine,@endLine)');
  const insCon = db.prepare('INSERT OR REPLACE INTO contracts (id,project,name,file) VALUES (@id,@project,@name,@file)');
  const insTok = db.prepare('INSERT INTO contract_tokens (project,contract,token,direction,producers,consumers) VALUES (@project,@contract,@token,@direction,@producers,@consumers)');
  const delTok = db.prepare('DELETE FROM contract_tokens WHERE project=? AND contract=?');
  const insEdge = db.prepare('INSERT INTO edges (type,src,dst,project,token,cnt,resolution,evidence,direction,contract) VALUES (@type,@src,@dst,@project,@token,@cnt,@resolution,@evidence,@direction,@contract)');

  const tx = db.transaction(() => {
    // The reset wipe runs in the SAME transaction as the reload, so a failure
    // mid-insert rolls the wipe back too. Otherwise a crashed --reset would leave
    // the project's rows deleted and close() would persist the emptied db over a
    // good file — i.e. a transient error during /wiregraph-rebuild could destroy
    // the existing graph, the opposite of the backstop it's meant to be. (The
    // separate schema-migration DROP path above is exempt: that data is an
    // already-incompatible old schema the server refuses to query anyway.)
    if (reset) {
      // A graph.db holds exactly ONE project (its own root ∪ members, ALL tagged with
      // the owning root), so a reset clears EVERY row — not just rows tagged with the
      // current project path. Scoping to `project` left a renamed/moved project's old
      // rows (tagged with the now-dead path) behind as a GHOST compartment, doubling
      // symbols + edges. Any row under a different project value is residue → purge it.
      for (const t of ['compartments', 'files', 'symbols', 'contracts', 'contract_tokens', 'edges']) {
        db.prepare(`DELETE FROM ${t}`).run();
      }
    }
    db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    // Mirror the same number into the SQLite file header's user_version slot — a fixed
    // 4-byte big-endian field at byte 60 — written in the SAME transaction as the `meta`
    // row so the two can never disagree. `meta` stays authoritative; this exists purely
    // so a reader can learn the version with a 64-byte read instead of a full open.
    // connect() has no partial-read mode (sql.js slurps the whole file into the WASM
    // heap), which is fine for anything that then QUERIES the db and far too expensive
    // for a probe — see stampedSchemaVersion / schemaStatus above, which the hook worker
    // and the MCP server run on every incremental, once per graph.
    db.exec(`PRAGMA user_version = ${Number(SCHEMA_VERSION)}`);
    // WHO OWNS THIS FILE. Read back by the foreign-db refusal above, on the incremental
    // path only. Written on EVERY load (not just a reset) so a legitimately MOVED project —
    // which the refusal lets through precisely because its old path is no longer a wiregraph
    // project — re-stamps itself and is guarded again from its very next save, instead of
    // carrying a dead owner path forever. `meta` survives the reset wipe above (that loop
    // deliberately excludes it), so the value is not lost on a rebuild either.
    if (project) db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('project_root', ?)").run(String(project));
    for (const r of graph.compartments.values()) insCompartment.run(r);
    for (const f of graph.files.values()) insFile.run({ mtime: null, size: null, hash: null, ...f });
    for (const s of graph.symbols.values()) insSym.run({ lang: null, ...s });
    for (const c of graph.contracts.values()) {
      insCon.run({ file: null, ...c });
      // Persist the contract's full token set (delete-then-insert so an
      // incremental reload, which re-loads ALL contracts, replaces rather than
      // duplicates). A contract with no distinctive tokens simply gets no rows.
      if (Array.isArray(c.tokenMeta)) {
        delTok.run(project, c.id);
        for (const t of c.tokenMeta) {
          insTok.run({ project, contract: c.id, token: t.token, direction: t.direction ?? null, producers: t.producers ?? null, consumers: t.consumers ?? null });
        }
      }
    }
    // Match Neo4j's load semantics exactly:
    //  (a) it MATCHes both endpoints against nodes ALREADY IN THE STORE, so an
    //      edge is kept iff both endpoints exist there now (just-inserted above
    //      OR pre-existing). Computing valid ids from the DB — not just this
    //      graph batch — is what lets an incremental reload of one file keep its
    //      cross-file edges to symbols in files we didn't re-parse; it also still
    //      drops genuine orphans (endpoint in no file).
    //  (b) MERGE dedups on (type, src, dst) (+ token for REFERENCES/WIRE).
    const nodeIds = new Set();
    for (const t of ['compartments', 'files', 'symbols', 'contracts'])
      for (const r of db.prepare(`SELECT id FROM ${t} WHERE project = ?`).all(project)) nodeIds.add(r.id);
    const seen = new Set();
    for (const e of graph.edges) {
      if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue; // drop dangling
      const tok = e.props?.token ?? null;
      // A DERIVED seam also keys on its CONTRACT. Two contracts can legitimately name the
      // same token between the same two symbols (two specs declaring one resource id, or
      // a hand-written channel duplicated in the inferred spec) — those are two findings
      // under two contract names, and without the contract in the key the second addEdge
      // was silently DROPPED. The losing contract then reported status `ok` while
      // `export-gexf --contract <it>` found no edges at all, and which one lost came down
      // to directory read order. REFERENCES needs no such term: its `to` IS the contract.
      const key = DERIVED_EDGE_TYPES.includes(e.type)
        ? `${e.type}\0${e.from}\0${e.to}\0${tok}\0${e.props?.contract ?? ''}`
        : (e.type === 'REFERENCES'
          ? `${e.type}\0${e.from}\0${e.to}\0${tok}`
          : `${e.type}\0${e.from}\0${e.to}`);
      if (seen.has(key)) continue;
      seen.add(key);
      insEdge.run({
        type: e.type, src: e.from, dst: e.to, project,
        token: tok, cnt: e.props?.count ?? null,
        resolution: e.props?.resolution ?? null, evidence: e.props?.evidence ?? null,
        direction: e.props?.direction ?? null, contract: e.props?.contract ?? null,
      });
    }
  });
  tx();
  if (reset) log(`  reset project ${project}`);
  const n = graph.stats();
  log(`  loaded ${n.symbols} symbols, ${n.files} files, ${n.edges} edges into sqlite`);
}

// Every indexed source file for `project` with the on-disk stamp recorded at index
// time (mtime+size, schema v2) and its compartment ROOT, so an absolute path can be
// reconstructed as join(root, path). Used by the invalid-baseline content-reconcile
// (build.js) to compare disk-vs-graph WITHOUT a git diff — the diff is exactly what's
// unavailable once the baseline sha was gc'd. mtime/size may be null on a file indexed
// before v2 populated them; the caller treats a null stamp as "differs" (reindex) and
// bails to a full rebuild if NO file under the repo carries a usable stamp. hash (v5) is
// the authoritative tiebreaker for a mtime+size MATCH (see reconcileRepoByContent); it is
// NULL on any row indexed before v5 stamped it → the caller treats a null hash as "cannot
// confirm" and reindexes that file (superset-safe).
//
// The JOIN is on compartment NAME (files store the compartment by name, not id), so two
// compartments that share a basename within one project cross-join — one file row yields
// one row per same-named compartment root. This predates this helper (files/pruneFile are
// name-keyed project-wide) and the reconcile's `startsWith(root+sep)` scope guard filters
// the stray root out in every realistic case; a note for the maintainer, not a live bug.
export function listIndexedFiles(db, project) {
  // The reconcile connects READONLY, and this SELECT runs with no schema gate ahead of it
  // — so a pre-v5 db (files table without the hash column) would throw here on the upgrade
  // before any full rebuild recreates the table. Add the column defensively: on a readonly
  // connection the mutation lives only in memory (close never persists), and on a v5+ db
  // the column already exists so the ALTER is a harmless no-op. Old rows then read
  // hash=NULL, which the caller already treats as "reindex".
  try { db.exec('ALTER TABLE files ADD COLUMN hash TEXT'); } catch { /* column already present */ }
  return db.prepare(
    'SELECT f.compartment AS compartment, f.path AS path, f.mtime AS mtime, f.size AS size, f.hash AS hash, c.root AS root ' +
    'FROM files f JOIN compartments c ON c.name = f.compartment AND c.project = f.project ' +
    'WHERE f.project = ?',
  ).all(project);
}

// Read this project's existing symbol definitions (for incremental call
// resolution): a changed file's outgoing calls resolve against the whole project,
// not just the re-parsed file. Mirrors neo4j.js loadProjectSymbols.
export function loadProjectSymbols(db, project) {
  return db.prepare(
    "SELECT id, compartment, file, name, kind FROM symbols WHERE project = ? AND kind <> 'module'",
  ).all(project);
}

// Surgical per-file prune for incremental rebuilds, mirroring neo4j.js pruneFile.
// Symbol ids are content-stable (compartment:file:name:line), so a symbol that
// survives an edit keeps the SAME id and therefore its INCOMING edges from
// unchanged files.
//   - delete this file's symbols whose id is NOT in keepIds, with all their edges;
//   - for surviving symbols, clear their OUTGOING edges (CALLS/REFERENCES AND
//     DEFINED_IN), keeping incoming, so the reload recreates exactly one of each
//     (Neo4j's MERGE deduped these implicitly; SQLite's INSERT is additive, so we
//     must clear everything the re-extraction will re-add for this file);
//   - for surviving symbols, ALSO drop any DERIVED seam edge touching them (WIRE and
//     RESOURCE, either direction). Keeping one would leave a stale seam hanging off a
//     symbol whose backing REFERENCES were just re-matched — a dangling seam with no
//     live backing. This is a DELETE-THEN-REBUILD, not a delete: the incremental caller
//     (src/build.js#incrementalBuild) runs rederiveWireEdges over the refreshed
//     REFERENCES immediately afterwards, so the seam is back before the update returns.
//     It goes dark only when that re-derive FAILS — which the caller logs and degrades
//     to the old behaviour (dark in export/visualize until the next full rebuild; the
//     query tools don't read the derived edges). Deleted symbols' seam edges go with
//     delEdgesOf already.
//   - clear the file's IN_COMPARTMENT edge for the same reason;
//   - if keepIds is empty (file deleted on disk), also drop the File node.
export function pruneFile(db, project, compartment, relPath, keepIds, log = () => {}) {
  const keep = new Set(keepIds);
  const existing = db.prepare(
    'SELECT id FROM symbols WHERE project = ? AND compartment = ? AND file = ?',
  ).all(project, compartment, relPath).map((r) => r.id);
  const toDelete = existing.filter((id) => !keep.has(id));

  const delEdgesOf = db.prepare('DELETE FROM edges WHERE project = ? AND (src = ? OR dst = ?)');
  const delSym = db.prepare('DELETE FROM symbols WHERE id = ?');
  const delOutgoing = db.prepare(
    "DELETE FROM edges WHERE project = ? AND src = ? AND type IN ('CALLS','REFERENCES','DEFINED_IN')",
  );
  // EVERY derived seam type (DERIVED_EDGE_TYPES: WIRE, RESOURCE, INPROC), not just
  // WIRE: a resource or in-process seam hanging off a symbol whose backing REFERENCES
  // were just re-matched is exactly as stale as a wire one. The list drives the SQL, so
  // a fourth type is cleared the day it is registered — and rederiveWireEdges below
  // rebuilds them all immediately after (it must; see the note on DERIVED_EDGE_TYPES).
  const delWireOf = db.prepare(
    `DELETE FROM edges WHERE project = ? AND type IN (${DERIVED_EDGE_SQL_LIST}) AND (src = ? OR dst = ?)`,
  );

  const tx = db.transaction(() => {
    for (const id of toDelete) { delEdgesOf.run(project, id, id); delSym.run(id); }
    for (const id of keepIds) { delOutgoing.run(project, id); delWireOf.run(project, id, id); }
    // The file node's IN_COMPARTMENT edge is re-added on reload too — clear it (and, if
    // the file is gone, the File node itself; its symbols + DEFINED_IN already went).
    const f = db.prepare('SELECT id FROM files WHERE project = ? AND compartment = ? AND path = ?').get(project, compartment, relPath);
    if (f) {
      db.prepare("DELETE FROM edges WHERE project = ? AND type = 'IN_COMPARTMENT' AND src = ?").run(project, f.id);
      if (!keepIds.length) db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    }
  });
  tx();
  if (!keepIds.length) log(`  pruned deleted file ${compartment}/${relPath}`);
  else log(`  pruned ${compartment}/${relPath} (kept ${keepIds.length} stable symbols' incoming edges)`);
}

// Incremental DERIVED-SEAM self-heal (Change 1) — every DERIVED_EDGE_TYPES member
// (WIRE, RESOURCE and INPROC). The
// incremental path re-matches REFERENCES
// (M1), but pruneFile deletes every derived seam edge touching a changed/surviving symbol —
// so the derived producer->consumer seam went DARK in export/visualize until a full
// rebuild. This re-derives the WHOLE project's WIRE set from the db's now-fresh
// REFERENCES (no source re-parse; cost is O(references)), running the SAME
// buildWireEdges the full build uses so orientation matches exactly, then replaces
// the project's WIRE rows wholesale (delete-all-then-reinsert). Full-union recompute
// is idempotent and simpler than per-contract scoping, and WIRE is small.
//
// `contracts` MUST be the SAME merged contract set the incremental matchContracts
// used (loadAllContracts output). Returns the number of WIRE rows written. It throws
// only on a genuine db/SQL error; the caller wraps it so a failure degrades to the
// old (seam-dark) behavior rather than breaking the incremental update.
export function rederiveWireEdges(db, project, contracts, log = () => {}) {
  // ALL symbols, INCLUDING the synthetic <module> symbol: matchContracts attributes a
  // top-level route reference to <module>, so excluding it (as loadProjectSymbols
  // does) would drop those seams and break parity with the full build.
  const symbols = new Map();
  for (const r of db.prepare('SELECT id, compartment FROM symbols WHERE project = ?').all(project))
    symbols.set(r.id, { id: r.id, compartment: r.compartment });
  // The REFERENCES edges buildWireEdges reads, shaped exactly as it expects
  // (e.from, e.to, e.props.token).
  const edges = db.prepare("SELECT src, dst, token FROM edges WHERE project = ? AND type = 'REFERENCES'")
    .all(project).map((r) => ({ type: 'REFERENCES', from: r.src, to: r.dst, props: { token: r.token } }));
  // A minimal Graph-shaped sink: buildWireEdges reads only .symbols (a Map with .get)
  // and .edges, and emits via .addEdge(type, from, to, props).
  const emitted = [];
  const g = { symbols, edges, addEdge: (type, from, to, props) => emitted.push({ type, from, to, props }) };
  buildWireEdges(g, contracts, log);
  // Resource seams are derived by the SAME function the full build uses, from the same
  // merged contract set — so the incremental result is identical to a full rebuild's.
  // Omitting this while the DELETE below still clears RESOURCE would silently drop
  // every resource seam on the first file save after a full build.
  buildResourceEdges(g, contracts, log);
  // In-process seams likewise, and this is the line the DERIVED_EDGE_TYPES note warns
  // about: INPROC is in the list, so the DELETE below already clears it. Omitting this call
  // would delete every in-process seam on the first save and never rebuild it, with every
  // full-build test still green. Same function the full build uses, same merged contract
  // set, so the incremental result is identical to a full rebuild's.
  buildInprocEdges(g, contracts, log);

  const del = db.prepare(`DELETE FROM edges WHERE project = ? AND type IN (${DERIVED_EDGE_SQL_LIST})`);
  const ins = db.prepare('INSERT INTO edges (type,src,dst,project,token,cnt,resolution,evidence,direction,contract) VALUES (@type,@src,@dst,@project,@token,@cnt,@resolution,@evidence,@direction,@contract)');
  const tx = db.transaction(() => {
    del.run(project);
    // Dedup on (src,dst,token) exactly as loadGraph does for WIRE. buildWireEdges
    // already dedups; this makes a re-run byte-identical regardless.
    const seen = new Set();
    for (const e of emitted) {
      const tok = e.props?.token ?? null;
      // Same key as the full-build loader above, contract term included — the incremental
      // re-derive must not collapse two contracts' seams where a full rebuild keeps both,
      // or a file save would silently delete one of them.
      const key = `${e.type}\0${e.from}\0${e.to}\0${tok}\0${e.props?.contract ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ins.run({
        type: e.type, src: e.from, dst: e.to, project,
        token: tok, cnt: null, resolution: null,
        evidence: e.props?.evidence ?? null, direction: e.props?.direction ?? null,
        contract: e.props?.contract ?? null,
      });
    }
  });
  tx();
  log(`  re-derived ${emitted.length} derived seam edge(s) (${DERIVED_EDGE_TYPES.join('/')}) from db REFERENCES`);
  return emitted.length;
}
