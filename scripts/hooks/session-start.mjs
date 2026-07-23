#!/usr/bin/env node
// SessionStart hook. Two jobs, both cheap and non-blocking:
//   1. If the project isn't indexed yet, nudge the user to run /wiregraph-init
//      (injected as additionalContext so Claude sees it too).
//   2. If it is indexed, catch up on any out-of-session changes — files changed
//      since the last index (git diff + uncommitted) — by spawning the detached
//      refresh worker.
//
// Gated on posture: 'off' does nothing; 'conservative'/'balanced'/'aggressive'
// all do the SessionStart catch-up (PostToolUse is the part balanced adds).

import { realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readState, findIndexedRoot, updateState } from '../lib/state.mjs';
import { changedSince } from '../lib/git.mjs';
import { record, migrateMetrics } from '../lib/metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function readStdin() {
  return new Promise((res) => {
    let buf = '';
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => res(buf));
    process.stdin.on('error', () => res(buf));
  });
}

function emit(ctx) {
  if (ctx) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx },
    }));
  }
  process.exit(0);
}

function project(payload) {
  const raw = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  // Resolve the indexed workspace root so a session started in a sub-repo still
  // sees the workspace graph; fall back to the raw dir (→ not-indexed nudge).
  return findIndexedRoot(raw) || (() => { try { return realpathSync(raw); } catch { return raw; } })();
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(await readStdin()); } catch { /* tolerate empty */ }
  const PROJECT = project(payload);

  // Soft metrics migration (CHANGE B). SessionStart is the PRIMARY post-update entry
  // point — it runs first thing every session, so it catches every updating user no
  // matter their flow. Version-gated + idempotent + best-effort: a no-op once the
  // project is already at METRICS_VERSION, a no-op on an unindexed dir (no state to
  // stamp), and it NEVER throws. Run it BEFORE this session's boundary below so that
  // boundary lands in the FRESH (post-archive) log, not in the archived one. Placed
  // ahead of the 'off' early-exit so an updating user is migrated regardless of posture.
  try { migrateMetrics(PROJECT); } catch { /* best-effort */ }

  const state = readState(PROJECT);

  if (state && state.autoUpdate === 'off') emit('');

  // Context boundary / session segmentation (CHANGE A): a NEW SESSION means the prior
  // resident context is gone, so a SessionStart CLOSES the residency window for every
  // get_source before it. Recording a boundary here segments the metrics timeline per
  // session — a read only accrues turns from its OWN session, and a pre-v2 read with no
  // following turns correctly scores ~0 recurring. Record for EVERY source
  // (startup/resume/clear/fork) EXCEPT 'compact': the PreCompact hook already marks
  // compaction, and a source==='compact' SessionStart would double-count it. reason =
  // the source. Best-effort append (record() no-ops on an 'off' posture and never throws).
  if (payload?.source && payload.source !== 'compact') {
    record(PROJECT, { sessionId: payload?.session_id || null, kind: 'boundary', reason: payload.source });
  }

  if (!state) {
    // Not initialized. Only nudge if a CLAUDE.md directive isn't already pointing
    // here; keep it to a single short line.
    emit(`wiregraph: this project is not indexed. Run /wiregraph-init to build the call graph and navigate code at ~50% fewer tokens.`);
  }

  // Heartbeat: record that the SessionStart hook actually ran. /wiregraph-status
  // reads this to tell whether plugin hooks are firing at all — a missing stamp on
  // an indexed project means catch-up, nudges, and re-index-on-edit are silently
  // off (hooks not enabled in this Claude Code), which the doctor should flag.
  try { updateState(PROJECT, { hooksLastFired: new Date().toISOString() }); } catch { /* best-effort */ }

  // Indexed: spawn the detached catch-up worker.
  const child = spawn('node', [join(HERE, 'refresh.mjs')], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  // Nudge toward inferring contracts only when there's REAL, uncovered potential:
  // the last full build found cross-repo seams (messaging/state/HTTP) AND no
  // contracts dir is present. Both come from state (persisted at build time), so
  // this stays a cheap read — no scan. Appended to whichever note fires below,
  // since emit() exits. Silent for contracted or signal-free workspaces.
  const seams = state.inferredSeams || 0;
  const contractsHint = (seams > 0 && !state.contractsDir)
    ? ` wiregraph spotted ${seams} cross-repo seam(s) (messaging/state/HTTP) with no contract yet — run /wiregraph-contracts to capture them.`
    : '';

  // Tailor a short note from a quick git check (don't block on the refresh).
  let changedCount = 0;
  try { changedCount = changedSince(PROJECT, state.reposLastSha || {}).files.length; } catch { /* ignore */ }
  if (changedCount > 0) {
    emit(`wiregraph: ${changedCount} source file(s) changed since last index — refreshing the graph in the background. Prefer the wiregraph MCP tools for code navigation.${contractsHint}`);
  }
  // Fresh: re-assert the directive cheaply. The CLAUDE.md block is loaded once
  // and decays as context grows, so a one-line reminder each session keeps the
  // graph top-of-mind without re-stating the whole directive.
  emit('wiregraph: graph is indexed and fresh — prefer its MCP tools (find_symbol, get_source, trace_callers/trace_callees, path_between) over grep/Read for code navigation, at ~50% fewer tokens.' + contractsHint);
}

main().catch(() => process.exit(0));
