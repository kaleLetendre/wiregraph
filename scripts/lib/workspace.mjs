// Workspace inspection for init safety. Before /wiregraph-init builds, it shows
// which COMPARTMENTS the target folder would cover, so the user can confirm the
// scope is what they meant (the two footguns: running init inside ONE compartment
// when they meant the parent workspace, or pointing it at a huge tree like $HOME).
//
// A compartment is what a contract connects: a git repo OR a package/module with
// its own manifest. A single git repo can hold several compartments (a monorepo of
// packages), so scope is reported in COMPARTMENTS, not just git repos — that's what
// determines whether cross-compartment contracts are even possible (needs >=2).
//
//   node scripts/lib/workspace.mjs repos <target>

import { existsSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { findCompartmentRoots } from '../../src/extract/walk.js';

function main(argv) {
  const [cmd, targetArg] = argv;
  if (cmd !== 'repos' || !targetArg) {
    process.stderr.write('usage: workspace.mjs repos <target>\n');
    process.exit(2);
  }
  let target = targetArg;
  try { target = realpathSync(targetArg); } catch { /* keep as given */ }

  const selfIsRepo = existsSync(join(target, '.git'));
  const roots = findCompartmentRoots(target); // [{dir, name}], includes target if it is a boundary
  const compartments = roots.map((r) => ({
    name: r.name,
    rel: r.dir === target ? '.' : r.dir.slice(target.length + 1),
  }));

  const out = [];
  out.push(`Target: ${target}`);
  out.push(`Target is itself a git repo: ${selfIsRepo ? 'yes' : 'no'}`);
  if (!compartments.length) {
    out.push('Compartments found: 0 — wiregraph will index the whole folder as a single '
      + `unit named "${basename(target)}". Cross-compartment contracts need >=2 compartments `
      + '(separate git repos, or packages/modules with their own manifest).');
  } else {
    out.push(`Compartments wiregraph would index (${compartments.length}):`);
    for (const c of compartments) out.push(`  - ${c.name}${c.rel === '.' ? ' (the target itself)' : `  [${c.rel}]`}`);
  }
  // A flag the command keys on for its scope guidance. MULTI => cross-compartment
  // contracts are possible (>=2 compartments, monorepo packages included). SINGLE
  // => one compartment, so contracts need the parent workspace. NO-GIT => a lone
  // non-git folder indexed as one unit.
  const n = compartments.length;
  const scope = n >= 2 ? 'MULTI' : (n === 1 || selfIsRepo ? 'SINGLE' : 'NO-GIT');
  out.push(`scope: ${scope} (compartments=${n})`);
  process.stdout.write(out.join('\n') + '\n');
}

main(process.argv.slice(2));
