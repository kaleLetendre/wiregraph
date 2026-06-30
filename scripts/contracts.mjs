#!/usr/bin/env node
// CLI behind /wiregraph-contracts. Infers cross-repo wire contracts from code
// (HTTP routes shared across repos) and, on confirmation, writes them as a draft
// AsyncAPI 3.0 spec the existing pipeline already consumes.
//
//   node scripts/contracts.mjs scan  [project]   propose seams + draft spec (NO writes)
//   node scripts/contracts.mjs apply [project]   write the draft into the contracts home
//
// The inference is heuristic — a draft to REVIEW and commit, not authoritative.
// See docs/contracts.md. Works from any subdir of an indexed workspace.

import { readdirSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { findIndexedRoot, readState, updateState } from './lib/state.mjs';
import { extractRoutes, clusterSeams, synthesizeAsyncApi, formatSeams } from '../src/contracts/infer.js';

const SPEC_NAME = 'wiregraph-inferred.asyncapi.yaml';

function resolveRoot(arg) {
  const raw = arg || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Prefer the indexed workspace root so this works from inside a sub-repo too.
  const indexed = findIndexedRoot(raw);
  if (indexed) return indexed;
  try { return realpathSync(raw); } catch { return raw; }
}

// Look for an existing contracts home directly under the workspace root: a dir
// named `contracts`/`asyncapi`, or any `*-contracts` dir (this also catches a
// sibling repo named `*-contracts`). Mirrors resolveContractsDir in src/build.js
// so a freshly written spec is auto-detected on the next build. null = none yet.
function contractsHome(root) {
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && (e.name === 'contracts' || e.name === 'asyncapi' || /-contracts$/.test(e.name))) {
        return join(root, e.name);
      }
    }
  } catch { /* unreadable root */ }
  return null;
}

function main(argv) {
  const [cmd, projectArg] = argv;
  if (cmd !== 'scan' && cmd !== 'apply') {
    process.stderr.write('usage: contracts.mjs <scan|apply> [project]\n');
    process.exit(2);
  }
  const root = resolveRoot(projectArg);
  const seams = clusterSeams(extractRoutes(root));

  process.stdout.write(formatSeams(seams) + '\n');
  if (!seams.length) {
    process.stdout.write(
      '\nTip: cross-repo contracts need related repos indexed TOGETHER in one workspace '
      + '(each its own git repo, side by side under one folder). If your repos are indexed '
      + 'separately, wiregraph can\'t see the shared routes.\n');
    return;
  }

  const yaml = synthesizeAsyncApi(seams);
  const home = contractsHome(root);

  if (cmd === 'scan') {
    process.stdout.write('\n--- proposed contract (NOT written) ---\n');
    process.stdout.write(yaml);
    const dest = home ? join(home, SPEC_NAME) : join(root, 'contracts', SPEC_NAME) + '  (new contracts/ dir)';
    process.stdout.write(`\nWould write to: ${dest}\n`);
    process.stdout.write('Review the seams above, then run apply to write it.\n');
    return;
  }

  // apply — write the draft into the contracts home (create one if none exists).
  let dir = home;
  let created = false;
  if (!dir) { dir = join(root, 'contracts'); mkdirSync(dir, { recursive: true }); created = true; }
  const out = join(dir, SPEC_NAME);
  writeFileSync(out, yaml);

  // Record the contracts home + seam count so the SessionStart nudge can stop and
  // status can report precisely. Only touch state if the project is indexed.
  if (readState(root)) updateState(root, { contractsDir: dir, wireSeams: seams.length });

  process.stdout.write(`\nWrote ${seams.length} channel(s) to ${out}${created ? ' (created contracts/)' : ''}.\n`);
  process.stdout.write(
    'This is a DRAFT — review/commit it as your own. Refresh the graph (the read tools '
    + 'self-heal, or run /wiregraph-update), then walk the seams with trace_contract / '
    + 'path_between or check /wiregraph-status.\n');
}

main(process.argv.slice(2));
