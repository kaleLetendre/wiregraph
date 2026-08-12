// Where a DETACHED refresh worker's raw stderr goes.
//
// Both hook dispatchers (post-edit.mjs, session-start.mjs) spawn scripts/hooks/refresh.mjs
// detached, and both used `stdio: 'ignore'` — so everything the build wrote to stderr went
// to /dev/null. refresh.mjs now tees its own WARNING lines into refresh.log and state
// (that is the fix for the content-dropping refusals), but a tee installed inside the
// child cannot capture what happens BEFORE it runs: an import-time throw, a syntax error
// after a plugin update, a node that refuses to start. Those produced literally no record
// anywhere — the graph just silently stopped updating.
//
// So point the child's fd 2 at a real file. It is a RAW stream, deliberately kept OUT of
// refresh.log: that file is a timestamped decision log which /wiregraph-status tails and
// tests read line-wise, and interleaving phase bars and a stats JSON into it would wreck
// both.
//
// Bounded by a single truncate rather than a rotation scheme: it is a debugging tail, not
// an audit trail, and a save loop appends a few lines per save. Truncating on open keeps
// the file at most CAP + one run's output with one stat and no bookkeeping.

import { openSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { wiregraphDir } from './state.mjs';

const CAP_BYTES = 512 * 1024;

// THROUGH wiregraphDir(), NEVER a hand-built `join(project, '.wiregraph')`. This was the
// one place that spelled the folder by hand, and openRefreshErrFd MKDIRS it — so on a
// project still running on the legacy `.codegraph` folder, a single hook fire CREATED
// `.wiregraph/` and thereby FLIPPED the back-compat shim (wiregraphDir prefers
// `.wiregraph` the moment it exists). After that readState looked into the empty new
// folder and returned null forever: refresh logged "no state file — project not
// initialized; skipping", resolveDbPath named a db that does not exist (MCP reports
// NOT_BUILT), and the next updateState wrote a fresh default — orphaning the links, the
// posture, both partition fingerprints and the metrics baseline. No self-heal at any
// point. Every other path into that folder already goes through wiregraphDir; this one
// must too.
export function refreshErrLogPath(project) {
  return join(wiregraphDir(project), 'refresh.err.log');
}

// An appendable fd for the child's stderr, or null when one can't be opened (read-only
// checkout, missing dir, anything else) — callers fall back to 'ignore', because losing
// the log must never stop the refresh from being spawned. The caller owns closing it.
export function openRefreshErrFd(project) {
  try {
    const p = refreshErrLogPath(project);
    mkdirSync(dirname(p), { recursive: true });
    let big = false;
    try { big = statSync(p).size > CAP_BYTES; } catch { /* absent — not big */ }
    return openSync(p, big ? 'w' : 'a');
  } catch {
    return null;
  }
}
