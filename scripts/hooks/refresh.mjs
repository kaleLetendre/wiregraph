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

import { realpathSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild, reindexFiles } from '../../src/build.js';
import { readState, updateState, refreshLogPath, findIndexedRoot } from '../lib/state.mjs';
import { changedSince, projectRepos } from '../lib/git.mjs';

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
async function fullRebuildAndRestamp(logMsg) {
  await runBuild({ target: PROJECT, project: PROJECT, reset: true });
  const newShas = {};
  for (const r of projectRepos(PROJECT)) if (r.head) newShas[r.root] = r.head;
  updateState(PROJECT, { lastFullBuild: new Date().toISOString(), reposLastSha: newShas });
  logLine(logMsg);
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

  if (o.files && o.files.length) {
    // Explicit set (post-edit): re-index just these; do NOT advance shas, since
    // committed changes between the stored sha and HEAD may not be in this set.
    // Fan out so an edit under a linked member updates every graph that includes
    // it (owningMember attribution + graphsListing reverse index inside reindexFiles).
    const rebuilt = await reindexFiles(o.files, PROJECT, { fanOut: true });
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
  if (!c.files.length) { logLine('auto: nothing changed'); return; }
  const rebuilt = await reindexFiles(c.files, PROJECT, { fanOut: true });
  updateState(PROJECT, { reposLastSha: { ...(state.reposLastSha || {}), ...c.newShas } });
  logLine(`auto: reindexed ${c.files.length} changed file(s) into ${rebuilt.length} graph(s)`);
}

// Only auto-run when invoked directly as a script, not when imported (e.g. by tests).
const isCli = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((e) => { logLine('ERROR: ' + (e.message || e)); process.exit(0); });
}
