#!/usr/bin/env node
// PreCompact hook. Records a "boundary" event (reason:'compact') at the moment
// just before the context is compacted — where resident context is dropped, which
// ENDS the residency window for every get_source that came before it in this
// session. Fires for BOTH auto-compaction and manual /compact (no matcher), which
// is what we want: both drop context identically.
//
// The matching /clear boundary is recorded by session-start.mjs (SessionStart
// source==='clear'); compaction boundaries live HERE, and session-start.mjs
// deliberately does NOT record source==='compact' so a single compaction isn't
// double-counted.
//
// Best-effort append via record() (no-op on 'off' posture, never throws). NO db,
// NO graph load. Exit 0 with no stdout — recording the boundary is the whole job.

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
  return findIndexedRoot(raw) || (() => { try { return realpathSync(raw); } catch { return raw; } })();
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(await readStdin()); } catch { /* tolerate empty */ }
  record(project(payload), { sessionId: payload?.session_id || null, kind: 'boundary', reason: 'compact' });
  process.exit(0);
}

main().catch(() => process.exit(0));
