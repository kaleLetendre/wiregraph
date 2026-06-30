#!/usr/bin/env node
// Hard uninstall of wiregraph from a project. Deletes EVERYTHING wiregraph put in
// or around the project, and nothing else:
//   1. the managed directive block in <project>/CLAUDE.md (between the sentinels)
//   2. the wiregraph entry in <project>/.gitignore (+ its comment)
//   3. the <project>/.wiregraph/ folder (state, log, and the graph.db itself)
//   4. a dangling ~/.wiregraph symlink left pointing at a deleted .wiregraph
//
//   node remove.mjs <project> [--dry-run]
//
// The graph is a single SQLite file inside .wiregraph/, so deleting that folder
// removes this project's graph entirely — no daemon to stop, no shared DB to
// scrub. Everything outside that footprint — your source, the rest of CLAUDE.md,
// the rest of .gitignore — is left untouched.

import { existsSync, readFileSync, writeFileSync, rmSync, lstatSync, realpathSync, readlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { wiregraphDir, GITIGNORE_LINE } from './lib/state.mjs';
import { targetPath as claudeMdPath, present as blockPresent, withoutBlock } from './lib/claudemd.mjs';

function parse(argv) {
  const o = { project: null, dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') o.dryRun = true;
    else if (!o.project) o.project = a;
  }
  return o;
}

const log = (m) => process.stdout.write(m + '\n');

// Strip the wiregraph entry (and the contiguous wiregraph comment lines above it)
// from .gitignore content, leaving every other line intact.
function stripGitignore(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === GITIGNORE_LINE || t === '/.wiregraph/') {
      // drop any contiguous wiregraph comment lines we just emitted
      while (out.length && out[out.length - 1].trim().startsWith('#') &&
             /wiregraph/i.test(out[out.length - 1])) out.pop();
      continue; // drop the ignore line itself
    }
    out.push(lines[i]);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (!o.project) { process.stderr.write('usage: remove.mjs <project> [--dry-run]\n'); process.exit(2); }
  let project = o.project;
  try { project = realpathSync(project); } catch { /* keep */ }
  const cgDir = wiregraphDir(project);
  const did = (m) => log(`${o.dryRun ? '  • would ' : '  ✓ '}${m}`);

  log(`wiregraph removal for ${project}${o.dryRun ? '  (DRY RUN — no changes)' : ''}`);

  // 1. CLAUDE.md managed block ----------------------------------------------
  const cmPath = claudeMdPath(project);
  if (existsSync(cmPath) && blockPresent(readFileSync(cmPath, 'utf8'))) {
    if (!o.dryRun) writeFileSync(cmPath, withoutBlock(readFileSync(cmPath, 'utf8')));
    did(`remove the managed directive block from ${cmPath}`);
  } else log('  – no managed CLAUDE.md block (skipped)');

  // 2. .gitignore entry ------------------------------------------------------
  const gi = join(project, '.gitignore');
  if (existsSync(gi)) {
    const cur = readFileSync(gi, 'utf8');
    const next = stripGitignore(cur);
    if (next !== cur) { if (!o.dryRun) writeFileSync(gi, next.replace(/\n*$/, '\n')); did('remove the .wiregraph/ entry from .gitignore'); }
    else log('  – no wiregraph entry in .gitignore (skipped)');
  }

  // 3. the .wiregraph/ folder (contains graph.db + state) --------------------
  if (existsSync(cgDir)) { if (!o.dryRun) rmSync(cgDir, { recursive: true, force: true }); did(`delete ${cgDir} (graph.db + state)`); }
  else log('  – no .wiregraph/ folder (skipped)');

  // 4. dangling ~/.wiregraph symlink (legacy runtime pointer) ----------------
  const home = join(process.env.HOME || '', '.wiregraph');
  try {
    if (lstatSync(home).isSymbolicLink()) {
      const target = readlinkSync(home);
      if (!existsSync(home) || target === cgDir) { // dangling, or pointed at what we deleted
        if (!o.dryRun) unlinkSync(home);
        did(`remove the dangling ~/.wiregraph symlink (was -> ${target})`);
      }
    }
  } catch { /* no ~/.wiregraph */ }

  log(o.dryRun ? 'Dry run complete — nothing was changed.' : 'wiregraph removed. Your source, the rest of CLAUDE.md, and the rest of .gitignore are untouched.');
}

main().catch((e) => { process.stderr.write('remove failed: ' + (e.stack || e.message) + '\n'); process.exit(1); });
