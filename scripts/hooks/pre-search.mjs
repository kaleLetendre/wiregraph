#!/usr/bin/env node
// PreToolUse hook on Grep|Glob|Read. The token win is gated on Claude actually
// reaching for the graph, and the CLAUDE.md directive (loaded once at session
// start) decays as context grows — so on an indexed project the model drifts
// back to its grep/Read priors and wiregraph goes unused until asked.
//
// This puts the nudge at the decision point: when Claude is about to search or
// open a source file, inject a one-line reminder (additionalContext) to prefer
// the graph. It NEVER blocks — it just reminds, and Claude still chooses. To stay
// true to wiregraph's "fewer tokens" promise it is rate-limited to NUDGE_CAP
// times per session (counter under .wiregraph/nudges/) and silent unless the
// project is indexed with a non-'off' posture.
//
// Grep/Glob always qualify — they're inherently code search. Read is gated: only
// a FULL read of a sizable SOURCE file qualifies (where get_source/trace would
// actually save tokens). A partial read, a small file, or a non-code file (md,
// json, logs, images) is left alone — both because the graph can't help there and
// so the small per-session budget isn't spent on irrelevant reads.

import { realpathSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readState, wiregraphDir, findIndexedRoot } from '../lib/state.mjs';
import { record } from '../lib/metrics.mjs';
import { langForFile } from '../../src/extract/lang.js';

const NUDGE_CAP = 3;
// A full read worth nudging on: ~200+ lines, where get_source's single-symbol
// slice meaningfully beats opening the whole file. ~8 KB ≈ 200 lines of code.
const READ_NUDGE_MIN_BYTES = 8 * 1024;

function readStdin() {
  return new Promise((res) => {
    let buf = '';
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => res(buf));
    process.stdin.on('error', () => res(buf));
  });
}

// Silent exit: emit nothing, let the tool call proceed untouched.
function quiet() {
  process.exit(0);
}

function nudge(ctx) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ctx },
  }));
  process.exit(0);
}

function project(payload) {
  const raw = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  // Indexed workspace root (so nudges/metrics work from a sub-repo), else raw dir.
  return findIndexedRoot(raw) || (() => { try { return realpathSync(raw); } catch { return raw; } })();
}

// Per-session nudge counter under .wiregraph/nudges/<session>. Returns the count
// BEFORE this call (0 on first grep of the session); bumps it on the way out.
function bumpCount(proj, sessionId) {
  const dir = join(wiregraphDir(proj), 'nudges');
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  const file = join(dir, safe);
  let n = 0;
  try { n = parseInt(readFileSync(file, 'utf8'), 10) || 0; } catch { /* first time */ }
  try {
    mkdirSync(dir, { recursive: true });
    if (n === 0) pruneOldNudges(dir); // once per session: stale counters don't accumulate forever
    writeFileSync(file, String(n + 1));
  } catch { /* best-effort; a write failure just means we may re-nudge */ }
  return n;
}

// A counter file is written per session and was never cleaned up — a long-lived
// checkout would grow one file per session indefinitely. Drop counters untouched
// for a week (any session that stale is long over). Best-effort, once per session.
function pruneOldNudges(dir) {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  try {
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try { if (now - statSync(p).mtimeMs > WEEK) rmSync(p, { force: true }); } catch { /* skip */ }
    }
  } catch { /* dir missing or unreadable — nothing to prune */ }
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(await readStdin()); } catch { /* tolerate empty */ }

  const proj = project(payload);
  const state = readState(proj);

  // Not indexed, or the user opted all the way out → say nothing.
  if (!state || state.autoUpdate === 'off') quiet();

  // Relevance gate. Grep/Glob pass through; Read must be a full read of a sizable
  // source file. This runs BEFORE bumpCount so the budget is only ever spent on a
  // moment where the graph could actually help.
  const tool = payload?.tool_name || '';

  // Tier-3 adoption signal: record every grep (cheap append, NO db access — the
  // summary classifies which patterns name a symbol the graph already knows).
  // Done here, before the nudge budget below, so the full-session denominator is
  // captured even after the per-session nudge cap is spent.
  if (tool === 'Grep') {
    const pat = payload?.tool_input?.pattern;
    record(proj, { sessionId: payload?.session_id || null, kind: 'grep',
      pattern: typeof pat === 'string' ? pat.slice(0, 200) : null });
  }

  if (tool === 'Read') {
    const ti = payload?.tool_input || {};
    const file = ti.file_path;
    if (!file || ti.limit || ti.offset) quiet();  // missing path or an already-targeted partial read
    if (!langForFile(file)) quiet();               // non-code file — the graph doesn't index it
    try { if (statSync(file).size < READ_NUDGE_MIN_BYTES) quiet(); } catch { quiet(); } // small/unreadable
  }

  const seen = bumpCount(proj, payload?.session_id);
  if (seen >= NUDGE_CAP) quiet();

  const msg = tool === 'Read'
    ? 'wiregraph is indexed for this project — before reading a whole source file, ' +
      'prefer get_source (returns just one function/symbol\'s body) or ' +
      'trace_callers/trace_callees/path_between (whole call chains in one call). ' +
      'They cost ~50% fewer tokens; open the full file only when you need broad context.'
    : 'wiregraph is indexed for this project — prefer its MCP tools over grep for ' +
      'code navigation: find_symbol (locate a symbol), get_source (read one ' +
      "function's body), trace_callers/trace_callees/path_between (whole call chains " +
      'in one call). They cost ~50% fewer tokens. Fall back to grep for string ' +
      'literals, callback/function-pointer edges, or non-code files.';
  nudge(msg);
}

main().catch(() => process.exit(0));
