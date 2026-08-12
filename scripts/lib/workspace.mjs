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
//   node scripts/lib/workspace.mjs repos          <target>
//   node scripts/lib/workspace.mjs contracts-dirs <target>

import { existsSync, realpathSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { findCompartmentRoots } from '../../src/extract/walk.js';
import { detectContractsDirs } from '../../src/contracts-dirs.js';

// Every contracts dir under `target`, at any depth, classified as none / root-only /
// nested. /wiregraph-init step 2a asks this before it asks the user which mode they want,
// so it has to apply the ENGINE's rule rather than an approximation — and it now does so
// by CALLING the engine: `detectContractsDirs(target, { recursive: true })` is literally
// what a recursive-mode build discovers. This started life as a hand-written scan (there
// was no recursive discovery to call yet), which is exactly the kind of second copy the
// contracts-dir rule has drifted into twice before; there is nothing to drift now.
//
// What the shared implementation buys, and why a `find` cannot substitute for it:
//   - isContractsDirName is case-INSENSITIVE, so `Contracts/` counts. A
//     `find -name contracts` misses it and reports "none", and the mode question then
//     gets asked on a false premise.
//   - It skips IGNORE_DIRS exactly as the walk does. A `find` that prunes only
//     node_modules/.git counts a `contracts/` under `vendor/`, `dist/` or `.venv/` and
//     inflates the answer to "nested", when the build will never load it.
//   - It follows a symlinked contracts dir, and promotes `target` itself when it holds
//     top-level specs — both things the build does and a naive scan does not.
//
// Depth is what distinguishes the two structures the mode question is about: specs at one
// level (root-only) vs specs at two or more (nested, each governing its own subtree).
function contractsDirs(target) {
  return detectContractsDirs(target, { recursive: true }).sort();
}

function main(argv) {
  const [cmd, targetArg] = argv;
  if ((cmd !== 'repos' && cmd !== 'contracts-dirs') || !targetArg) {
    process.stderr.write('usage: workspace.mjs <repos|contracts-dirs> <target>\n');
    process.exit(2);
  }
  let target = targetArg;
  try { target = realpathSync(targetArg); } catch { /* keep as given */ }

  if (cmd === 'contracts-dirs') {
    const dirs = contractsDirs(target);
    const out = [`Target: ${target}`];
    // Depth 0 = the target itself or one of its immediate children; anything deeper is a
    // second level. `structure:` is the line the command classifies on.
    const depthOf = (d) => (d === target ? 0 : relative(target, d).split('/').length - 1);
    const depths = new Set(dirs.map(depthOf));
    if (!dirs.length) out.push('Contracts dirs found: 0');
    else {
      out.push(`Contracts dirs found (${dirs.length}):`);
      for (const d of dirs) out.push(`  - ${d === target ? '. (the target itself)' : relative(target, d)}`);
    }
    // NESTED means "at least one contracts dir governs a SUBTREE rather than the whole
    // target" — i.e. any depth >= 1. The old test (`depths.size > 1 || some(x > 1)`)
    // misclassified the CANONICAL nested layout: `server/contracts` + `client/contracts`
    // with NO root `contracts/` gives depths={1}, so size>1 was false and some(x>1) was
    // false, and the motivating structure of this whole feature reported `root-only` —
    // making /wiregraph-init ask the mode question on a false premise. `some(x >= 1)`
    // subsumes both old clauses: {0,1} and {0,2} still read nested, {0} still root-only.
    const structure = !dirs.length ? 'none' : ([...depths].some((x) => x >= 1) ? 'nested' : 'root-only');
    out.push(`structure: ${structure} (dirs=${dirs.length})`);
    process.stdout.write(out.join('\n') + '\n');
    return;
  }

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
