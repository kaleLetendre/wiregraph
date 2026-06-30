// Workspace inspection for init safety. Before /wiregraph-init builds, it shows
// which git repos the target folder would cover, so the user can confirm the scope
// is what they meant (the two footguns: running init inside ONE repo when they
// meant the parent workspace, or pointing it at a huge tree like $HOME).
//
//   node scripts/lib/workspace.mjs repos <target>

import { existsSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { findRepoRoots } from '../../src/extract/walk.js';

function main(argv) {
  const [cmd, targetArg] = argv;
  if (cmd !== 'repos' || !targetArg) {
    process.stderr.write('usage: workspace.mjs repos <target>\n');
    process.exit(2);
  }
  let target = targetArg;
  try { target = realpathSync(targetArg); } catch { /* keep as given */ }

  const selfIsRepo = existsSync(join(target, '.git'));
  const roots = findRepoRoots(target); // [{dir, name}], includes target if it has .git
  const repos = roots.map((r) => ({
    name: r.name,
    rel: r.dir === target ? '.' : r.dir.slice(target.length + 1),
  }));

  const out = [];
  out.push(`Target: ${target}`);
  out.push(`Target is itself a git repo: ${selfIsRepo ? 'yes' : 'no'}`);
  if (!repos.length) {
    out.push('Git repos found: 0 — wiregraph will index the whole folder as a single '
      + `unit named "${basename(target)}". (Cross-repo contracts need separate git repos.)`);
  } else {
    out.push(`Git repos wiregraph would index (${repos.length}):`);
    for (const r of repos) out.push(`  - ${r.name}${r.rel === '.' ? ' (the target itself)' : `  [${r.rel}]`}`);
  }
  // A flag line the command can key on for its scope warnings.
  const onlySelf = selfIsRepo && repos.length === 1 && repos[0].rel === '.';
  out.push(`scope: ${onlySelf ? 'SINGLE-REPO' : repos.length === 0 ? 'NO-GIT' : 'WORKSPACE'} (repos=${repos.length})`);
  process.stdout.write(out.join('\n') + '\n');
}

main(process.argv.slice(2));
