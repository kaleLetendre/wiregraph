#!/usr/bin/env node
// Background graph-refresh worker, spawned detached by the SessionStart and
// PostToolUse hooks (and usable by hand). Re-indexes into the embedded SQLite db
// (no daemon to keep alive), so the hook dispatchers stay instant.
//
//   node refresh.mjs                 # auto: re-index files changed since last index, advance shas
//   node refresh.mjs --files a,b     # re-index exactly these (no sha advance — used by post-edit)
//   node refresh.mjs --full          # full project-scoped rebuild
//
// PROJECT comes from CLAUDE_PROJECT_DIR (set for hooks) or cwd. Failures are
// non-fatal and logged to <project>/.wiregraph/refresh.log — a missed
// background refresh is recovered by the next SessionStart catch-up or a manual
// /wiregraph-update / /wiregraph-rebuild.

import { realpathSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runBuild } from '../../src/build.js';
import { readState, updateState, refreshLogPath } from '../lib/state.mjs';
import { changedSince, projectRepos } from '../lib/git.mjs';

function resolveProject() {
  const raw = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try { return realpathSync(raw); } catch { return raw; }
}
const PROJECT = resolveProject();

function logLine(msg) {
  try {
    const p = refreshLogPath(PROJECT);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* logging is best-effort */ }
}

function parseArgs(argv) {
  const o = { files: null, full: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--files') o.files = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--full') o.full = true;
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const state = readState(PROJECT);
  if (!state && !o.full) {
    logLine('no state file — project not initialized; skipping');
    return;
  }

  if (o.full) {
    await runBuild({ target: PROJECT, project: PROJECT, reset: true });
    const newShas = {};
    for (const r of projectRepos(PROJECT)) if (r.head) newShas[r.root] = r.head;
    updateState(PROJECT, { lastFullBuild: new Date().toISOString(), reposLastSha: newShas });
    logLine('full rebuild complete');
    return;
  }

  if (o.files && o.files.length) {
    // Explicit set (post-edit): re-index just these; do NOT advance shas, since
    // committed changes between the stored sha and HEAD may not be in this set.
    await runBuild({ target: PROJECT, project: PROJECT, files: o.files });
    logLine(`reindexed ${o.files.length} explicit file(s)`);
    return;
  }

  // Auto (SessionStart catch-up): re-index everything changed since last index
  // and advance the per-repo shas.
  const c = changedSince(PROJECT, state.reposLastSha || {});
  if (!c.files.length) { logLine('auto: nothing changed'); return; }
  await runBuild({ target: PROJECT, project: PROJECT, files: c.files });
  updateState(PROJECT, { reposLastSha: { ...(state.reposLastSha || {}), ...c.newShas } });
  logLine(`auto: reindexed ${c.files.length} changed file(s)`);
}

main().catch((e) => { logLine('ERROR: ' + (e.message || e)); process.exit(0); });
