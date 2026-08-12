#!/usr/bin/env node
// PostToolUse hook (matcher Edit|Write|MultiEdit). Keeps the graph current with
// Claude's OWN edits: take the edited file from the payload and re-index just
// that file in a detached background worker. Instant + non-blocking — it spawns
// refresh.mjs and exits; it never touches the graph db itself.
//
// Gated on the project's autoUpdate posture: only 'balanced' and 'aggressive'
// re-index on every edit. Posture lives in <project>/.wiregraph/state.json.

import { realpathSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readState, findIndexedRoot, owningMember } from '../lib/state.mjs';
import { openRefreshErrFd } from '../lib/hooklog.mjs';
import { langForFile } from '../../src/extract/lang.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function readStdin() {
  return new Promise((res) => {
    let buf = '';
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => res(buf));
    process.stdin.on('error', () => res(buf));
  });
}

function project() {
  const raw = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Indexed workspace root so an edit in a sub-repo re-indexes the workspace graph.
  return findIndexedRoot(raw) || (() => { try { return realpathSync(raw); } catch { return raw; } })();
}

async function main() {
  let payload = {};
  try { payload = JSON.parse(await readStdin()); } catch { /* no payload — no-op */ }
  const file = payload?.tool_input?.file_path;
  if (!file) return;

  const PROJECT = project();
  const state = readState(PROJECT);
  const posture = state?.autoUpdate || 'balanced';
  if (posture !== 'balanced' && posture !== 'aggressive') return; // SessionStart-only or off
  if (!state) return; // project not initialized

  // Only re-index source files that live under this graph's union — its own root
  // OR a linked member (membership gate, not a bare subtree check). A file under no
  // member is not ours to index.
  let abs;
  try { abs = realpathSync(file); } catch { abs = file; }
  if (!owningMember(abs, PROJECT)) return;
  if (!langForFile(abs)) return;

  // Give the child a REAL fd 2. With `stdio: 'ignore'` every byte the build wrote to
  // stderr went to /dev/null — including the refusals that DELETE graph content and any
  // failure that happens before refresh.mjs's own warning tee is installed (an import-time
  // throw after a plugin update left no record anywhere and the graph silently stopped
  // updating). Falls back to 'ignore' when the log can't be opened: losing the log must
  // never stop the refresh from being spawned.
  const errFd = openRefreshErrFd(PROJECT);
  const child = spawn('node', [join(HERE, 'refresh.mjs'), '--files', abs], {
    detached: true,
    stdio: ['ignore', 'ignore', errFd === null ? 'ignore' : errFd],
    env: process.env,
  });
  child.unref();
  if (errFd !== null) { try { closeSync(errFd); } catch { /* the child holds its own dup */ } }
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
