#!/usr/bin/env node
// UserPromptSubmit hook. Records exactly ONE "turn" event per user prompt so
// /wiregraph-stats can MEASURE how long an avoided read stays resident in the
// prompt — the number of turns between a get_source and the next context boundary
// (compaction or /clear) — instead of ASSUMING a fixed 20–50-turn window.
//
// Dead simple + best-effort: read the stdin JSON, resolve the indexed project
// from cwd, append {kind:'turn', sessionId} via record(). record() no-ops on an
// 'off' posture and NEVER throws, and it is a plain file append — NO db open, NO
// graph load, nothing heavy on this hot per-prompt path. All correlation happens
// later, at report time in summarize().
//
// STDOUT DISCIPLINE: on UserPromptSubmit any stdout on exit 0 is injected verbatim
// into Claude's prompt as additionalContext (JSON is NOT parsed for this event) —
// so this hook writes NOTHING to stdout and just exits 0.

import { realpathSync } from 'node:fs';
import { findIndexedRoot } from '../lib/state.mjs';
import { record } from '../lib/metrics.mjs';

function readStdin() {
  return new Promise((res) => {
    let buf = '';
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => res(buf));
    process.stdin.on('error', () => res(buf));
  });
}

function project(payload) {
  const raw = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  // Resolve the indexed workspace root so a prompt from a sub-repo still logs
  // against the workspace graph; fall back to the raw dir (record() then no-ops
  // since there's no state there).
  return findIndexedRoot(raw) || (() => { try { return realpathSync(raw); } catch { return raw; } })();
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(await readStdin()); } catch { /* tolerate empty */ }
  record(project(payload), { sessionId: payload?.session_id || null, kind: 'turn' });
  process.exit(0); // silent — no stdout on UserPromptSubmit
}

main().catch(() => process.exit(0));
