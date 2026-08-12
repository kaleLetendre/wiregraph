// Declared compartments (`recursive` mode) — validation and the write path.
//
// In the legacy/global mode a compartment boundary is INFERRED: a `.git` dir or a
// build manifest (src/extract/walk.js). In `recursive` mode the project DECLARES its
// compartments instead, and that declaration becomes the whole partition:
//
//   .wiregraph/state.json
//   { "mode": "recursive",
//     "compartments": [ { "path": "server/ecs", "name": "ecs" }, ... ] }
//
// The declaration is read back by findCompartmentRoots (src/extract/walk.js), the
// single funnel every consumer already goes through — the build walk, incremental
// attribution, the link collision guard, the link preview, the init scope report — so
// declaring here carries attribution, relPath, every node id and every guard with it.
//
// THIS MODULE IS NOT A USER-FACING COMMAND. Mode is set only by /wiregraph-init;
// switching later is a teardown + re-init, because it invalidates the graph anyway.
//
//   node scripts/lib/compartments.mjs show     <project>
//   node scripts/lib/compartments.mjs validate <project> '<json>'   # dry run
//   node scripts/lib/compartments.mjs declare  <project> '<json>' [--new]
//   node scripts/lib/compartments.mjs clear    <project>
//
// `clear` is not decoration: /wiregraph-init's GLOBAL branch and /wiregraph-teardown both
// run it, because "switching modes = teardown + re-init" is a promise both files make and
// nothing else in the flow drops a stale declaration. Without it, answering GLOBAL on a
// project that had been declared left the old declaration live and step 9 read back
// `Mode: recursive`.
//
// `--new` is for /wiregraph-init only — see the guard in `declare`.
//
// <json> is the compartment array, e.g.
//   '[{"path":"server/ecs","name":"ecs"},{"path":"client/network","name":"client_network"}]'

import { realpathSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readState, updateState, wiregraphDir, isRecursiveMode, compartmentsFingerprint, contractsFingerprint } from './state.mjs';
import { detectContractsDirs } from '../../src/contracts-dirs.js';
import { resolveDeclaration } from '../../src/extract/walk.js';

// THE RULES LIVE IN ONE PLACE, AND THE BUILD USES THE SAME ONES.
//
// This module used to own its own copy of the validation, which meant the WRITE path
// (here) and the READ path (src/extract/walk.js#findCompartmentRoots, what the build
// actually partitions on) could disagree — and they did, on every rule. state.json is a
// plain editable file, so everything `declare` rejected still reached the build by hand
// edit: a duplicate compartment NAME (one row, files from both roots, get_source reading
// the wrong file), a half-written entry, a path that is a file, a name containing the id
// separator, a path that does not exist. The read path skipped what it could not honour
// and built the remainder, silently.
//
// Both sides now call validateDeclaration from src/extract/compartment-decl.js, which is
// also what the declaration fingerprint is derived from. Re-exported here because
// `declare`/`validate` are its user-facing surface.
export { validateDeclaration } from '../../src/extract/compartment-decl.js';
import { validateDeclaration } from '../../src/extract/compartment-decl.js';

// Which SPEC FILES on disk this declaration would invalidate.
//
// src/contracts/infer.js writes compartment NAME STRINGS into specs as
// x-wiregraph-producers / -consumers (and the resource specs' writers/readers), and those
// are string-matched against sym.compartment. Declared names that differ from the walk's
// basename(dir) make every such spec stale, and every WIRE / RESOURCE edge derived from
// it silently disappears — satisfied tokens flip to one-sided rather than erroring.
//
// BOTH HOMES, and the second one is the one that matters. This used to list only
// `.wiregraph/inferred/`, which is scripts/lib/links.mjs's out-of-source dir for
// link-inferred seams. `/wiregraph-contracts apply` writes into contractsHome(root) --
// `<project>/contracts/` — and that file is the canonical carrier of
// x-wiregraph-producers, alongside whatever the user HAND-WROTE there. Naming only the
// out-of-source copy pointed the user at the one spec they did not write.
function invalidatedSpecs(project) {
  const out = [];
  const seen = new Set();
  const scan = (dir) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const f of names.sort()) {
      if (!/\.ya?ml$/i.test(f)) continue;
      const full = join(dir, f);
      if (seen.has(full)) continue;
      seen.add(full);
      out.push(full);
    }
  };
  scan(join(wiregraphDir(project), 'inferred'));
  // The build's own answer for where this project's specs live, plus whatever the last
  // full build recorded (which is where `apply` wrote).
  for (const d of detectContractsDirs(project)) scan(d);
  // …plus whatever the last full build recorded. The PLURAL matters here: in recursive
  // mode the specs a declaration invalidates routinely live in NESTED dirs
  // (`server/contracts/`), which the depth-1 call above cannot see, so listing only the
  // singular would report a reassuringly short list that omits most of the damage.
  const st = readState(project);
  for (const d of Array.isArray(st?.contractsDirs) ? st.contractsDirs : []) scan(d);
  if (st?.contractsDir) scan(st.contractsDir);
  return out;
}

const INVALIDATION_NOTE = [
  'Declaring compartments INVALIDATES contract specs that name a compartment — INFERRED and',
  'HAND-WRITTEN alike.',
  'Specs record compartment NAMES (x-wiregraph-producers / -consumers, a resource spec\'s',
  'writers / readers, and an inproc spec\'s provider / consumers) and those names are',
  'string-matched against each',
  'symbol\'s compartment. Any declared name that differs from the name the walk used',
  'leaves the old spec pointing at a compartment that no longer exists: the seam does',
  'not error, it goes DARK — satisfied tokens flip to one-sided and the WIRE / RESOURCE /',
  'INPROC edges vanish. Re-run /wiregraph-contracts after the rebuild to re-infer them, and',
  'review any HAND-WRITTEN spec that names a compartment by hand.',
].join('\n');

function usage() {
  process.stderr.write('usage: compartments.mjs <show|validate|declare|clear> <project> [json] [--new]\n');
  process.exit(2);
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const [cmd, projectArg, jsonArg] = argv.filter((a) => !a.startsWith('--'));
  if (!cmd || !projectArg) usage();
  let project = projectArg;
  try { project = realpathSync(projectArg); } catch { /* keep as given */ }

  if (cmd === 'show') {
    const s = readState(project);
    if (!s) { process.stdout.write(`No state at ${project} — not indexed.\n`); return; }
    const recursive = isRecursiveMode(s);
    process.stdout.write(`project: ${project}\n`);
    process.stdout.write(`mode: ${recursive ? 'recursive' : 'global'}\n`);
    if (!Array.isArray(s.compartments)) {
      process.stdout.write('compartments: (not declared — inferred from .git / build manifests)\n');
    } else if (!s.compartments.length) {
      process.stdout.write('compartments: (declared empty — every file attributes to the root)\n');
    } else {
      process.stdout.write(`compartments: ${s.compartments.length}\n`);
      for (const c of s.compartments) process.stdout.write(`  - ${c?.name}  [${c?.path}]\n`);
    }
    // What the BUILD would actually do with that text, re-checked against disk. A
    // declaration can be present and still refused (a declared directory renamed or
    // deleted since, a hand edit), in which case the build runs on INFERRED compartments
    // and every name printed above is fiction. Say so here rather than let `show` be the
    // thing that reassures a user their declaration is live.
    const res = resolveDeclaration(project);
    if (res.state === 'unusable') {
      process.stdout.write('IN FORCE: NO — the declaration is present but UNUSABLE, so the build falls back to INFERRED compartments:\n');
      for (const e of res.errors) process.stdout.write(`  ! ${e}\n`);
    } else if (res.state === 'declared') {
      process.stdout.write('IN FORCE: yes — the build partitions on this declaration.\n');
    }
    const fp = s.compartmentsFingerprint;
    if (fp && typeof fp === 'object' && !Array.isArray(fp)) {
      process.stdout.write('compartmentsFingerprint (per root, stamped at the last full build):\n');
      for (const [root, v] of Object.entries(fp)) process.stdout.write(`  - ${root}: ${v}\n`);
    } else {
      process.stdout.write('compartmentsFingerprint: (never stamped)\n');
    }
    process.stdout.write('current:\n');
    for (const [root, v] of Object.entries(compartmentsFingerprint(project))) process.stdout.write(`  - ${root}: ${v}\n`);
    // THE OTHER BASELINE, REPORTED SEPARATELY BECAUSE A GRAPH CAN CARRY ONE WITHOUT THE
    // OTHER. The two fingerprints landed in different releases and are stamped by different
    // code, so "compartmentsFingerprint is stamped" is only a PROXY for "this graph has a
    // contracts baseline" — and it is the contracts one that decides whether an incremental
    // over a changed spec set is refused or silently wrong. /wiregraph-contracts step 1 had
    // to read the proxy and guess; it can now read the real signal. Same `(never stamped)`
    // idiom, deliberately, so the branch is the same one line of prose.
    const kfp = s.contractsFingerprint;
    if (kfp && typeof kfp === 'object' && !Array.isArray(kfp)) {
      process.stdout.write('contractsFingerprint (per root, stamped at the last full build):\n');
      for (const [root, v] of Object.entries(kfp)) process.stdout.write(`  - ${root}: ${v}\n`);
    } else {
      process.stdout.write('contractsFingerprint: (never stamped)\n');
    }
    process.stdout.write('current (contract specs):\n');
    for (const [root, v] of Object.entries(contractsFingerprint(project))) process.stdout.write(`  - ${root}: ${v}\n`);
    return;
  }

  if (cmd === 'clear') {
    // Back to the legacy/global mode. `compartmentsFingerprint` is deliberately LEFT
    // ALONE: leaving the old stamp in place is precisely what makes the next
    // catch-up escalate to a full rebuild (and any incremental refuse), which is
    // required — dropping the declaration re-partitions every file just as adding it did.
    const before = readState(project);
    if (!before) { process.stderr.write(`No state at ${project} — nothing to clear.\n`); process.exit(1); }
    // NOTHING TO CLEAR IS NOT THE SAME AS CLEARED. Run on an already-global indexed project
    // this printed "Cleared the compartment declaration … mode is now global" AND "A full
    // rebuild is REQUIRED — every node id changes when the partition changes", when nothing
    // was cleared and no id moved. Both /wiregraph-init's GLOBAL branch and
    // /wiregraph-teardown run `clear` unconditionally, so that false rebuild demand was
    // printed on the ordinary path — and a user or an agent that acts on it pays for a full
    // rebuild to change nothing. Exit 0: a no-op on an already-global project is SUCCESS,
    // and the callers above must not start failing.
    if (!isRecursiveMode(before) && before.mode == null && before.compartments == null) {
      process.stdout.write(`No compartment declaration at ${project} — mode is already global `
        + '(compartments inferred from .git / build manifests). Nothing was cleared and nothing changed; no rebuild is needed.\n');
      return;
    }
    updateState(project, { mode: null, compartments: null });
    process.stdout.write(`Cleared the compartment declaration for ${project}; mode is now global (compartments inferred from .git / build manifests).\n`);
    process.stdout.write('A full rebuild is REQUIRED — every node id changes when the partition changes.\n');
    return;
  }

  if (cmd === 'validate' || cmd === 'declare') {
    if (jsonArg === undefined) usage();
    let list;
    try { list = JSON.parse(jsonArg); }
    catch (e) { process.stderr.write(`compartments: could not parse the declaration as JSON: ${e.message}\n`); process.exit(1); }

    const res = validateDeclaration(project, list);
    if (!res.ok) {
      process.stderr.write(`compartments: REJECTED — ${res.errors.length} problem(s) with the declaration for ${project}:\n`);
      for (const e of res.errors) process.stderr.write(`  - ${e}\n`);
      process.stderr.write('Nothing was written. Fix the entries above and re-run.\n');
      process.exit(1);
    }

    if (cmd === 'validate') {
      process.stdout.write(`OK — ${res.compartments.length} compartment(s) would be declared for ${project}:\n`);
      for (const c of res.compartments) process.stdout.write(`  - ${c.name}  [${c.path}]\n`);
      process.stdout.write('(dry run — nothing written)\n');
      return;
    }

    // A project with no `.wiregraph/` at all is NOT a place to write a declaration by
    // default. updateState falls through to defaultState, so a bare `declare` on an
    // unindexed directory planted a complete, plausible-looking state.json — mode
    // recursive, lastFullBuild null, no db, no registry entry — which findIndexedRoot
    // then treats as an indexed workspace and canLink refuses to nest inside. Harmless
    // INSIDE /wiregraph-init (step 2d writes it, step 4 builds immediately), which is
    // why init passes --new; harmful anywhere else, which is everywhere else.
    if (!readState(project) && !flags.has('--new')) {
      process.stderr.write(`compartments: ${project} has no .wiregraph/ — it is not an indexed project, and declaring here would\n`
        + 'leave a half-configured footprint (mode set, no graph, never built). Run /wiregraph-init instead,\n'
        + 'which sets the mode and builds in one pass. Pass --new only if you are init itself.\n');
      process.exit(1);
    }

    // `compartmentsFingerprint` is NOT reset here. Keeping the previous stamp is what
    // makes the change detectable: it now disagrees with the new declaration, so
    // changedSince escalates the next catch-up to a full rebuild and every incremental
    // path refuses outright until that rebuild restamps it.
    updateState(project, { mode: 'recursive', compartments: res.compartments });
    process.stdout.write(`Wrote mode: recursive and ${res.compartments.length} declared compartment(s) to ${project}/.wiregraph/state.json:\n`);
    for (const c of res.compartments) process.stdout.write(`  - ${c.name}  [${c.path}]\n`);
    process.stdout.write('Every file under none of these attributes to the root compartment '
      + `"${basename(project)}"; a file under several attributes to the NEAREST one.\n`);
    process.stdout.write('A full rebuild is REQUIRED before the graph is queryable again — the compartment '
      + 'name is part of every node id, so the whole graph is re-derived.\n');
    const stale = invalidatedSpecs(project);
    if (stale.length) {
      process.stdout.write(`\n${stale.length} spec(s) on disk are now suspect (inferred AND hand-written -- both record compartment NAMES):\n`);
      for (const f of stale) process.stdout.write(`  - ${f}\n`);
    }
    process.stdout.write('\n' + INVALIDATION_NOTE + '\n');
    return;
  }

  process.stderr.write(`unknown command: ${cmd}\n`);
  process.exit(2);
}

const isCli = process.argv[1] && process.argv[1].endsWith('compartments.mjs');
if (isCli) main(process.argv.slice(2));
