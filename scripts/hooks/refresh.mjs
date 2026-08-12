#!/usr/bin/env node
// Background graph-refresh worker, spawned detached by the SessionStart and
// PostToolUse hooks (and usable by hand). Re-indexes into the embedded SQLite db
// (no daemon to keep alive), so the hook dispatchers stay instant.
//
//   node refresh.mjs                 # auto: re-index files changed since last index, advance shas
//   node refresh.mjs --files <path> [path ...]   # re-index exactly these (no sha advance — used by post-edit)
//   node refresh.mjs --full          # full project-scoped rebuild
//
// PROJECT comes from CLAUDE_PROJECT_DIR (set for hooks) or cwd. Failures are
// non-fatal and logged to <project>/.wiregraph/refresh.log — a missed
// background refresh is recovered by the next SessionStart catch-up or a manual
// /wiregraph-update / /wiregraph-rebuild.

import { realpathSync, appendFileSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild, reindexFiles, reconcileRepoByContent, resolveDbPath, discoveryContext, installBuildWarningCapture, onBuildWarnings, drainBuildWarnings } from '../../src/build.js';
import { readState, updateState, refreshLogPath, findIndexedRoot, fanOutGraphs, compartmentsFingerprint, compartmentsDrift, contractsFingerprint, contractsDrift } from '../lib/state.mjs';
import { changedSince, projectRepos } from '../lib/git.mjs';
import { schemaOutdated, shouldStealLock } from '../../src/store/sqlite.js';

function resolveProject() {
  const raw = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Resolve the indexed WORKSPACE root so a refresh fired from a nested sub-repo
  // (or a linked member's own tree) targets the graph that actually indexes it,
  // not the bare cwd. Falls back to the realpath'd cwd when nothing up the tree is
  // indexed (an uninitialized project just no-ops below).
  return findIndexedRoot(raw) || (() => { try { return realpathSync(raw); } catch { return raw; } })();
}
const PROJECT = resolveProject();

function logLine(msg) {
  try {
    const p = refreshLogPath(PROJECT);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* logging is best-effort */ }
}

// --- content-dropping warnings must survive the hook path --------------------
// Every warning the build emits is a bare `process.stderr.write` (src/build.js `log`),
// and BOTH hook dispatchers spawn this worker detached with the child's stderr wired to
// /dev/null. So on the hook path — which now includes the full rebuilds the schema and
// drift heals trigger — five refusals that DELETE GRAPH CONTENT were invisible: unrecorded
// in state, absent from refresh.log, absent from graph_status. They are
//   - enforceDistinctTitlePerScope   (an entire spec's tokens SKIPPED)
//   - the cross-format title collision (the whole resource spec dropped)
//   - a duplicate resource id        (the join key dropped from one contract)
//   - validateResourceRoles          (a misspelled compartment — "the maximally
//                                     misleading report", by the code's own comment)
//   - the fan-out cap                ("N WIRE edge(s) NOT derived", under a comment
//                                     asserting NO SILENT CAPS)
// plus walk.js's IGNORING-an-unusable-declaration and its compartment-name-collision
// notice. The DECISION lines already reach refresh.log because they go through logLine();
// it is only the content-dropping ones that vanished.
//
// The fix is a TEE rather than plumbing at the origin, because the build writes them from
// src/extract/contracts.js and friends, several call frames down. Teeing a process's stderr
// catches every one of them wherever it is raised, in-process, with no plumbing through five
// signatures — and it keeps working for warnings added later, since it keys on the markers
// the build already uses.
//
// Deliberately NOT a raw redirect of the whole stream into refresh.log: that file is a
// timestamped decision log that /wiregraph-status tails and tests read line-wise, and
// interleaving phase bars and a stats JSON into it would destroy that. The raw stream is
// captured separately by the hook dispatchers (scripts/lib/hooklog.mjs).
// THE CAPTURE ITSELF NOW LIVES IN src/build.js (installBuildWarningCapture), for the
// defect that made it necessary to move: installed HERE it covered only the hook path, so
// `update_graph {full:true}` — which /wiregraph-rebuild prefers — and `node src/build.js
// --reset` — which /wiregraph-init runs — recorded nothing at all, and graph_status went on
// displaying an OLDER build's warnings captioned as the current one. runBuild is the funnel
// every build path shares, so that is where the tee belongs, and where the state record is
// written (with a full build's record protected from an incremental — see
// recordBuildWarnings in scripts/lib/state.mjs).
//
// WHAT REMAINS HERE IS THE LOG. refresh.log gets every warning of THIS run, per build, which
// is the per-run truth a user greps; state gets only the replaceable snapshot. The sink is
// registered before anything can build, and the tee is installed EARLY — before the
// discovery walk in main() — because walk.js memoizes its warnings per process: a collision
// or IGNORING warning raised while comparing fingerprints is not re-emitted inside the build
// that follows, so a capture that started at the build would miss it entirely.
//
// `didFullBuild` is GONE, and this is the one place its removal is visible. It was a
// process-wide latch set before the rebuild so a throwing rebuild still counted as full; the
// kind is now decided per build by runBuild itself, from the build it actually ran, which is
// strictly more accurate — a run that escalates one graph to a full rebuild and incrementally
// updates another no longer labels both with one verdict.
function logWarningBlocks(blocks) {
  for (const b of blocks || []) {
    const label = b.kind === 'note' ? 'notice (graph content RENAMED, not dropped)' : 'warning (graph content dropped)';
    logLine(`${label}: ${b.text}`);
  }
}

export function parseArgs(argv) {
  const o = { files: null, full: false };
  for (let i = 0; i < argv.length; i++) {
    // --files: each following arg is ONE path (a comma delimiter can't represent a path
    // that contains a comma). Consume args until the next --flag.
    if (argv[i] === '--files') {
      o.files = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) if (argv[++i] !== '') o.files.push(argv[i]);
    }
    else if (argv[i] === '--full') o.full = true;
  }
  return o;
}

// Full project-scoped rebuild, then restamp every repo's sha from the fresh HEADs.
// Shared by the explicit --full path and the auto-catch-up escalation (a new repo
// or an invalid stored baseline, where an incremental apply would silently miss code).
// `project` defaults to PROJECT; the schema gate below also drives this for a LINKED
// PEER whose own db needs migrating.
async function fullRebuildAndRestamp(logMsg, project = PROJECT) {
  await runBuild({ target: project, project, reset: true });
  const newShas = {};
  for (const r of projectRepos(project)) if (r.head) newShas[r.root] = r.head;
  // MERGE onto the stored baseline rather than REPLACING it. projectRepos only sees the
  // repos mounted right now, so a whole-map replacement silently drops the baseline of a
  // member that happens to be unmounted at this moment — and changedSince then reads the
  // missing entry back as a "new repo" and escalates to yet another full rebuild on the
  // next catch-up (scripts/lib/git.mjs), turning a transient mount blip into a rebuild.
  // A leftover entry for a repo that is genuinely gone is inert: changedSince only ever
  // looks up the repos it discovers.
  updateState(project, {
    lastFullBuild: new Date().toISOString(),
    reposLastSha: { ...(readState(project)?.reposLastSha || {}), ...newShas },
  });
  logLine(logMsg);
}

// --- schema gate ------------------------------------------------------------
// Every non-`--full` path in main() is INCREMENTAL, and an incremental against an
// OLDER-schema db does not fail loudly: loadGraph re-execs its `IF NOT EXISTS` schema
// (a no-op on the existing tables) and then stamps schema_version to the CURRENT value,
// so the db ends up CLAIMING to be current while physically on the old shape —
// permanently defeating every downstream schema check, including the MCP server's. Only
// a full --reset build migrates (drop + recreate). The verdict itself (and the cheap
// file-header probe behind it, including the trap where an ABSENT stamp means UNKNOWN
// rather than OUTDATED) lives in src/store/sqlite.js, shared with the MCP server's
// ensureSchemaCurrent so the two gates cannot drift apart.

// Cross-process single-flight for the escalation. Every PostToolUse spawns a FRESH
// detached process, so the MCP server's in-process promise dedup (ensureSchemaCurrent's
// schemaHealPromise) has no analogue here: six edits in twenty seconds after a plugin
// update would start six concurrent full rebuilds, and only the final load phase
// serializes on the <db>.lock — extract and parse run fully parallel. So claim a sibling
// <db>.heal marker FIRST, using the same O_EXCL-create + steal-a-dead-holder protocol
// sqlite.js uses for its write lock (shouldStealLock is shared, so a crashed builder's
// marker can never wedge healing permanently). Returns a release fn, or null when someone
// else already holds the claim.
// A marker is at most a decimal PID. Anything larger is not one, so it is NOT READ — the
// old code slurped whatever was there once per attempt (a 20MB file, twice).
const HEAL_MAX_BYTES = 64;

function claimHeal(dbPath) {
  const p = dbPath + '.heal';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { rmSync(p, { force: true }); } catch { /* best-effort */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      // INSPECT BEFORE READING, exactly as acquireLock (src/store/sqlite.js) does — the
      // twin fix that was written ~40 lines away and never copied here. Two shapes bit:
      //
      //  - A FIFO at <db>.heal. `readFileSync` on it BLOCKS FOREVER with no timeout and no
      //    signal, wedging the refresh WORKER, and every subsequent PostToolUse spawned
      //    another permanently-hung process. acquireLock guards this with `st.isFile()`
      //    and the comment "reading a fifo would block forever"; claimHeal went straight
      //    to the read.
      //  - A DANGLING SYMLINK. `readFileSync` on one returns ENOENT — which is the benign
      //    -race branch — so it `continue`d, burned both attempts without ever reaching
      //    shouldStealLock, and claimHeal returned null. healPartitionDrift then logged the
      //    verbatim-false "another process is already rebuilding" and ended the round, and
      //    every escalation (and every plain `--files` save behind it) was wedged FOREVER;
      //    ageing the marker did not help, because the age-based steal was unreachable. The
      //    previous fix's own comment called a dangling symlink "ELOOP" — ELOOP is a symlink
      //    LOOP; a dangling one is ENOENT, so its unreadable branch never ran.
      //
      // LSTAT, not stat: it SEES the symlink instead of resolving it, so a dangling link is
      // a link (debris) rather than a vanished file, and the benign race stays exactly the
      // benign race — an lstat ENOENT means nothing is at that path at all.
      let pid = null, ageMs = 0, unreadable = false;
      let st = null;
      try { st = lstatSync(p); }
      catch (statErr) {
        if (statErr && statErr.code === 'ENOENT') continue; // genuinely vanished between the open and here
        unreadable = true; // EACCES on the parent dir, anything else — no evidence of a holder
      }
      if (st) {
        // Only a REGULAR FILE can be a claim. A directory, a symlink (dangling or not), a
        // fifo or a socket is debris and must never be read.
        if (!st.isFile()) unreadable = true;
        else {
          ageMs = Date.now() - st.mtimeMs;
          if (st.size <= HEAL_MAX_BYTES) {
            try {
              const raw = readFileSync(p, 'utf8').trim();
              const n = Number.parseInt(raw, 10);
              pid = Number.isInteger(n) && String(n) === raw ? n : null; // reject empty/garbage/partial writes
            } catch (readErr) {
              // Still the benign race: it was a regular file a moment ago and is gone now.
              if (readErr && readErr.code === 'ENOENT') continue;
              unreadable = true; // chmod 000, another user's file — no evidence of a holder
            }
          }
          // Oversized: left as pid null, so the mtime fallback in shouldStealLock decides.
        }
      }
      // An UNREADABLE marker carries NO evidence of a live holder — that evidence is the
      // pid it was supposed to contain — so it is STEALABLE, exactly like the empty or
      // garbage marker. Waiting on debris could never end: nothing about it will change.
      if (!unreadable && shouldStealLock({ pid, ageMs }) !== 'steal') return null;
      // `recursive` because a DIRECTORY is one of the shapes an unreadable marker takes
      // (`mkdir graph.db.heal`), and a non-recursive rmSync on it throws EISDIR/EPERM.
      try { rmSync(p, { force: true, recursive: true }); } catch { /* the retry re-checks */ }
    }
  }
  return null;
}

// Migrate every graph this refresh can write into that is on an older schema. Returns
// true when the round is OVER — either because we rebuilt (a reset build is a complete
// re-derivation, so the incremental below has nothing left to do) or because another
// process is already healing and starting an incremental now would hit the stale schema
// anyway. A skipped round is recovered by the next SessionStart catch-up, exactly like
// any other missed background refresh.
async function healOutdatedSchemas() {
  const stale = fanOutGraphs(PROJECT).filter((g) => schemaOutdated(resolveDbPath({}, g)));
  if (!stale.length) return false;
  for (const g of stale) {
    const where = g === PROJECT ? '' : `: ${g}`;
    const release = claimHeal(resolveDbPath({}, g));
    if (!release) {
      logLine(`skipped: db schema older than this wiregraph but another process is already rebuilding it${where}`);
      return true;
    }
    // Log the DECISION before the build, not after it: a rebuild that throws is swallowed
    // by main().catch, and without this line the log would show only the raw error with no
    // record of why a full rebuild was attempted at all.
    logLine(`escalating to full rebuild (db schema older than this wiregraph)${where}`);
    try { await fullRebuildAndRestamp(`full rebuild complete (schema migration)${where}`, g); }
    finally { release(); }
  }
  return true;
}

// --- declared-compartment drift gate ----------------------------------------
// The partition changed since the last full build (the declaration was edited, or a
// declared source directory was renamed/deleted). incrementalBuild REFUSES in that
// state — correctly, because an incremental would attribute files to the NEW
// compartments while pruning under the OLD ones — but a refusal thrown from HERE was
// invisible: main().catch appends one ERROR line to refresh.log and exits 0, which
// nothing surfaces. Every post-edit save then failed silently, and with posture `off`
// (where the SessionStart catch-up that would normally escalate never runs at all) the
// project wedged until someone happened to run /wiregraph-rebuild by hand.
//
// So do here what the schema gate above already does for the analogous condition:
// ESCALATE. A full rebuild is the exact remedy the refusal asks for and is safe by
// construction, it restamps the fingerprint so the next update is cheap again, and the
// DECISION is logged before the build (a rebuild that throws is swallowed by
// main().catch, and without that line the log would show the error with no record of
// why a rebuild was attempted). Single-flighted through the same <db>.heal claim, since
// a burst of edits would otherwise start a rebuild per edit.
// It covers the CONTRACT SPEC SET too, for the identical reason and with the identical
// remedy: contract scope is applied at mint time and stored nowhere, so once the resolved
// `{spec, scopeRoot, digest}` set moves, an incremental re-derive groups rows minted under
// the OLD scopes and fabricates seams a full rebuild does not produce. incrementalBuild
// refuses that as well, and a refusal thrown from here would be just as invisible. Two
// conditions, one gate, because the remedy is one full rebuild either way — and reporting
// both reasons when both moved is strictly more useful than picking one.
//
// THIS HALF IS THE ONLY PART OF THE GUARD THAT TURNS A REFUSAL INTO A VISIBLE REMEDY, and
// it had no coverage at all: deleting the two `contract specs changed` lines below used to
// pass the entire suite. Without them the project wedges SILENTLY — exit 0, empty stdout,
// one `ERROR:` line in refresh.log, no index update, forever. contractsHookHealTest pins it.
//
// `ctx` is the ONE discoveryContext for this hook invocation (see src/build.js): the walk
// this comparison needs is the same walk the incremental below then needs, and resolving it
// twice a function call apart cost ~76ms per save on a large recursive tree.
//
// BOTH halves are taken from it — `ctx.specs` for the contract set and `ctx.compartments`
// for the partition. The partition half was left unthreaded when this gate was written
// (the memo did not exist yet), which cost an UNSHARED boundary walk on every save: with
// the inferred partition fingerprinted too, resolving it is a full findCompartmentRoots
// walk of the tree, and incrementalBuild then resolved it a second time one function call
// later. Same context, same values, one walk.
async function healPartitionDrift(ctx) {
  const drifted = [];
  for (const g of fanOutGraphs(PROJECT)) {
    // `labels` are the stable, detail-free reason names (what the completion line says, so
    // it stays greppable); `detail` carries the per-root before -> after summary.
    const labels = [], detail = [];
    try {
      const st = readState(g);
      const cd = compartmentsDrift(st?.compartmentsFingerprint, compartmentsFingerprint(g, { partitionOf: (r) => ctx.compartments(r) }));
      if (cd) { labels.push('compartment partition changed'); detail.push(`compartment partition changed: ${cd}`); }
      const kd = contractsDrift(st?.contractsFingerprint, contractsFingerprint(g, { specsOf: (r) => ctx.specs(r) }));
      if (kd) { labels.push('contract specs changed'); detail.push(`contract specs changed: ${kd}`); }
    } catch { labels.length = 0; detail.length = 0; } // a broken state file is not this gate's problem
    if (labels.length) drifted.push([g, labels.join('; '), detail.join('; ')]);
  }
  if (!drifted.length) return false;
  for (const [g, labels, detail] of drifted) {
    const where = g === PROJECT ? '' : `: ${g}`;
    const release = claimHeal(resolveDbPath({}, g));
    if (!release) {
      logLine(`skipped: ${detail} but another process is already rebuilding${where}`);
      return true;
    }
    logLine(`escalating to full rebuild (${detail})${where}`);
    try { await fullRebuildAndRestamp(`full rebuild complete (${labels})${where}`, g); }
    finally { release(); }
  }
  return true;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const state = readState(PROJECT);
  if (!state && !o.full) {
    logLine('no state file — project not initialized; skipping');
    return;
  }

  if (o.full) {
    await fullRebuildAndRestamp('full rebuild complete');
    return;
  }

  // Every path below is incremental, so a stale schema has to be healed first — the
  // migration only happens on a reset build, which also restamps the shas correctly.
  if (await healOutdatedSchemas()) return;

  // ONE contracts resolve for this whole invocation. The drift gate below and the
  // incremental after it both need the live `{spec, scopeRoot, digest}` set; before this
  // was threaded, the same process walked the tree twice per save (~38ms each on a 4,300
  // -directory tree). Deliberately created HERE, per invocation, not at module scope: a
  // process-lifetime memo is exactly the staleness bug the disco cache had.
  const ctx = discoveryContext();

  // ...and so has a partition that no longer matches the graph. Same shape, same reason:
  // only a full reset build is safe once the compartments moved.
  if (await healPartitionDrift(ctx)) return;

  if (o.files && o.files.length) {
    // Explicit set (post-edit): re-index just these; do NOT advance shas, since
    // committed changes between the stored sha and HEAD may not be in this set.
    // Fan out so an edit under a linked member updates every graph that includes
    // it (owningMember attribution + graphsListing reverse index inside reindexFiles).
    const rebuilt = await reindexFiles(o.files, PROJECT, { fanOut: true, ctx });
    logLine(`reindexed ${o.files.length} explicit file(s) into ${rebuilt.length} graph(s)`);
    return;
  }

  // Auto (SessionStart catch-up): re-index everything changed since last index
  // (across the whole union — changedSince now iterates members) and advance the
  // per-repo shas. Fan out so a member's committed change lands in both graphs.
  const c = changedSince(PROJECT, state.reposLastSha || {});
  if (c.fullBuildNeeded) {
    // Incremental would advance shas past unindexed history — escalate to a full rebuild.
    await fullRebuildAndRestamp(`auto: escalated to full rebuild (${c.fullBuildReasons.join('; ')})`);
    return;
  }

  // INVALID BASELINE (amend/rebase then `git gc` orphaned the stored sha). Do NOT nuke
  // the whole project as the old code did — reconcile each affected repo by on-disk
  // CONTENT (mtime+size vs what was indexed) and restamp it, leaving every other repo /
  // linked member of the graph untouched. A message-only amend that never changed a file
  // becomes a true no-op (no reindex, no rebuild), and a rebase that DID change a file
  // reindexes only that file. Only if a repo's content can't be compared reliably (store
  // lacks usable mtime/size) do we fall back to the full rebuild — safety over cleverness.
  if (c.invalidBaselineRepos && c.invalidBaselineRepos.length) {
    for (const repo of c.invalidBaselineRepos) {
      const rec = reconcileRepoByContent(repo.root, PROJECT);
      if (!rec.ok) {
        // No reliable content comparison for this repo → preserve full correctness by
        // rebuilding the whole project (the original behavior), rather than guessing.
        await fullRebuildAndRestamp(`auto: escalated to full rebuild (invalid baseline: ${repo.name}, no content comparison)`);
        return;
      }
      if (rec.files.length) {
        const rebuilt = await reindexFiles(rec.files, PROJECT, { fanOut: true, ctx });
        logLine(`auto: reconciled ${repo.name} by content (${rec.files.length} file(s)) after invalid baseline into ${rebuilt.length} graph(s)`);
      } else {
        logLine(`auto: reconciled ${repo.name} by content (0 files, content no-op) after invalid baseline`);
      }
    }
    // Any NORMAL changes changedSince also found (a sibling repo with a valid baseline, or
    // uncommitted edits) still get indexed. c.newShas already carries every repo's HEAD —
    // including the reconciled ones — so restamping past them stops the next refresh from
    // re-escalating on the same orphaned baseline.
    if (c.files.length) await reindexFiles(c.files, PROJECT, { fanOut: true, ctx });
    updateState(PROJECT, { reposLastSha: { ...(state.reposLastSha || {}), ...c.newShas } });
    return;
  }

  if (!c.files.length) { logLine('auto: nothing changed'); return; }
  const rebuilt = await reindexFiles(c.files, PROJECT, { fanOut: true, ctx });
  updateState(PROJECT, { reposLastSha: { ...(state.reposLastSha || {}), ...c.newShas } });
  logLine(`auto: reindexed ${c.files.length} changed file(s) into ${rebuilt.length} graph(s)`);
}

// Only auto-run when invoked directly as a script, not when imported (e.g. by tests).
const isCli = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  // Installed only on the CLI path so importing this module (tests do) never monkeypatches
  // the importer's stderr. The final drain runs on BOTH exits and covers the warnings no
  // build consumed — a run that decided there was nothing to index still walked the tree,
  // and the walk is where the compartment-collision and IGNORING notices come from.
  installBuildWarningCapture();
  onBuildWarnings((blocks) => logWarningBlocks(blocks));
  main().then(() => logWarningBlocks(drainBuildWarnings())).catch((e) => {
    const msg = e?.message || String(e);
    logLine('ERROR: ' + msg);
    logWarningBlocks(drainBuildWarnings());
    // Also to stderr. Exit stays 0 (a failed background refresh must never fail the
    // hook that spawned it), and a detached hook's stderr goes nowhere — but a HAND
    // run of this script is the one place a user can see why their graph stopped
    // updating, and silence there is what made the refusal unfindable.
    try { process.stderr.write('wiregraph refresh failed: ' + msg + '\n'); } catch { /* best-effort */ }
    process.exit(0);
  });
}
