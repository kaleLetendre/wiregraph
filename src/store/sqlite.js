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
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, statSync, rmSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { readState } from '../../scripts/lib/state.mjs';
import { walkSources } from '../extract/walk.js';
import { buildWireEdges } from '../extract/contracts.js';

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
export const SCHEMA_VERSION = 4;

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
// the exclusive 'wx' flag (atomic create-or-fail); contenders spin with a blocking
// sleep until it frees. A lock older than STALE_MS is assumed to belong to a
// crashed writer and is stolen — the writable session is short (only the SQLite
// load + export + rename, never the parse/walk), so a live holder never approaches
// it. ms-scale blocking is fine in these one-shot CLI/worker processes.
//
// Invariant: TIMEOUT > STALE. A contender must be willing to wait longer than the
// staleness window, or it would give up and throw before it could ever steal a
// crashed holder's lock (the steal can only fire once the lock is STALE_MS old).
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 60_000;

function sleepSync(ms) {
  // Block the thread without burning CPU (no async context to await in).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) { rmSync(lockPath, { force: true }); continue; }
      } catch { continue; /* lock vanished between open and stat — retry immediately */ }
      if (Date.now() > deadline) throw new Error(`wiregraph: timed out waiting for db lock ${lockPath}`);
      sleepSync(50);
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
  close() {
    try {
      if (!this._readonly) {
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta        (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS compartments(id TEXT PRIMARY KEY, project TEXT, name TEXT, root TEXT);
CREATE TABLE IF NOT EXISTS files       (id TEXT PRIMARY KEY, project TEXT, compartment TEXT, path TEXT, lang TEXT, mtime REAL, size INTEGER);
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
  const insFile = db.prepare('INSERT OR REPLACE INTO files (id,project,compartment,path,lang,mtime,size) VALUES (@id,@project,@compartment,@path,@lang,@mtime,@size)');
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
    for (const r of graph.compartments.values()) insCompartment.run(r);
    for (const f of graph.files.values()) insFile.run({ mtime: null, size: null, ...f });
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
      const key = (e.type === 'REFERENCES' || e.type === 'WIRE')
        ? `${e.type}\0${e.from}\0${e.to}\0${tok}`
        : `${e.type}\0${e.from}\0${e.to}`;
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
//   - for surviving symbols, ALSO drop any WIRE edge touching them (either
//     direction). WIRE is a derived cross-compartment seam that the incremental path
//     never re-derives (a full rebuild is its backstop). Keeping it would leave a
//     stale WIRE hanging off a symbol whose backing REFERENCES were just re-matched —
//     a dangling seam with no live backing. Dropping it is honest: the seam simply
//     goes dark in export/visualize until the next full rebuild (query tools don't
//     read WIRE). Deleted symbols' WIRE goes with delEdgesOf already.
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
  const delWireOf = db.prepare(
    "DELETE FROM edges WHERE project = ? AND type = 'WIRE' AND (src = ? OR dst = ?)",
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

// Incremental WIRE self-heal (Change 1). The incremental path re-matches REFERENCES
// (M1), but pruneFile deletes every WIRE edge touching a changed/surviving symbol —
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

  const del = db.prepare("DELETE FROM edges WHERE project = ? AND type = 'WIRE'");
  const ins = db.prepare('INSERT INTO edges (type,src,dst,project,token,cnt,resolution,evidence,direction,contract) VALUES (@type,@src,@dst,@project,@token,@cnt,@resolution,@evidence,@direction,@contract)');
  const tx = db.transaction(() => {
    del.run(project);
    // Dedup on (src,dst,token) exactly as loadGraph does for WIRE. buildWireEdges
    // already dedups; this makes a re-run byte-identical regardless.
    const seen = new Set();
    for (const e of emitted) {
      const tok = e.props?.token ?? null;
      const key = `${e.from}\0${e.to}\0${tok}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ins.run({
        type: 'WIRE', src: e.from, dst: e.to, project,
        token: tok, cnt: null, resolution: null,
        evidence: e.props?.evidence ?? null, direction: e.props?.direction ?? null,
        contract: e.props?.contract ?? null,
      });
    }
  });
  tx();
  log(`  re-derived ${emitted.length} WIRE edge(s) from db REFERENCES`);
  return emitted.length;
}
