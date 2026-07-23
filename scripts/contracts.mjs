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

import { readdirSync, statSync, mkdirSync, writeFileSync, realpathSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { findIndexedRoot, readState, updateState, memberRoots, wiregraphDir } from './lib/state.mjs';
import { extractCandidatesAcross, clusterSeams, synthesizeAsyncApi, formatSeams } from '../src/contracts/infer.js';

const SPEC_NAME = 'wiregraph-inferred.asyncapi.yaml';

function resolveRoot(arg) {
  const raw = arg || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Prefer the indexed workspace root so this works from inside a sub-repo too.
  const indexed = findIndexedRoot(raw);
  if (indexed) return indexed;
  try { return realpathSync(raw); } catch { return raw; }
}

// Look for an existing contracts home for the workspace root. Mirrors
// detectContractsDirs in src/build.js so a freshly written spec is auto-detected on
// the next build, returning the FIRST home found: `root` itself when its basename
// looks like a contracts dir or it directly holds *.asyncapi.y(a)ml files (a
// standalone *-contracts repo), else the first child dir named `contracts`/
// `asyncapi`/`*-contracts` — matched case-insensitively, following a symlink-to-dir.
// null = none yet.
function isContractsDirName(name) {
  return /^(contracts|asyncapi)$/i.test(name) || /-contracts$/i.test(name);
}
function hasTopLevelSpec(dir) {
  try {
    for (const f of readdirSync(dir)) if (/\.asyncapi\.ya?ml$/i.test(f)) return true;
  } catch { /* unreadable */ }
  return false;
}
function contractsHome(root) {
  if (isContractsDirName(basename(root)) || hasTopLevelSpec(root)) return root;
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!isContractsDirName(e.name)) continue;
      const full = join(root, e.name);
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try { isDir = statSync(full).isDirectory(); } catch { isDir = false; }
      }
      if (isDir) return full;
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
  // Span every linked member so /wiregraph-contracts infers across the union, not
  // just the home root.
  const seams = clusterSeams(extractCandidatesAcross(memberRoots(root)));

  process.stdout.write(formatSeams(seams) + '\n');
  if (!seams.length) return; // formatSeams already explains the likely reasons

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

  // Never silently clobber a hand-edited draft. The spec is meant to be reviewed,
  // extended (payload schemas, direction), and committed as the user's own — a
  // re-run that overwrote those edits with regenerated skeletons would destroy
  // real work. If the file exists and differs from what we'd write, back it up
  // first so the edits are always recoverable. The backup lands under the
  // gitignored .wiregraph/ (timestamped), NOT as a stray .bak in the tracked
  // source contracts/ — a committable backup file would be noise in the user's diff.
  let backupPath = null;
  if (existsSync(out) && readFileSync(out, 'utf8') !== yaml) {
    const backupDir = join(wiregraphDir(root), 'contract-backups');
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = join(backupDir, `${basename(out)}.${stamp}.bak`);
    copyFileSync(out, backupPath);
  }
  writeFileSync(out, yaml);

  // Record the contracts home + seam count so the SessionStart nudge can stop and
  // status can report precisely. Only touch state if the project is indexed.
  if (readState(root)) updateState(root, { contractsDir: dir, wireSeams: seams.length });

  process.stdout.write(`\nWrote ${seams.length} channel(s) to ${out}${created ? ' (created contracts/)' : ''}.\n`);
  if (backupPath) process.stdout.write(`Existing draft differed — backed it up to ${backupPath} before overwriting.\n`);
  process.stdout.write(
    'This is a DRAFT — review/commit it as your own. Refresh the graph (the read tools '
    + 'self-heal, or run /wiregraph-update), then walk the seams with trace_contract / '
    + 'path_between or check /wiregraph-status.\n');
}

main(process.argv.slice(2));
