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

import { mkdirSync, writeFileSync, realpathSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { findIndexedRoot, readState, updateState, memberRoots, wiregraphDir } from './lib/state.mjs';
import { contractsHome, rootContractsEntries } from '../src/contracts-dirs.js';
import { handWrittenTokens } from '../src/extract/contracts.js';
import {
  extractSignals, clusterSeams, clusterResourceSeams,
  synthesizeAsyncApi, synthesizeResourceSpec, formatSeams, formatResourceSeams,
} from '../src/contracts/infer.js';

// TWO inferred spec files, one per contract type. Distinct names AND distinct titles:
// contractId derives solely from info.title / the resource spec's title, and
// loadAllContracts refuses a title collision that spans formats (keeping the AsyncAPI
// side and SKIPPING the resource side), so a shared title would silently discard every
// inferred resource seam.
const SPEC_NAME = 'wiregraph-inferred.asyncapi.yaml';
const RESOURCE_SPEC_NAME = 'wiregraph-inferred.resource.yaml';

function resolveRoot(arg) {
  const raw = arg || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Prefer the indexed workspace root so this works from inside a sub-repo too.
  const indexed = findIndexedRoot(raw);
  if (indexed) return indexed;
  try { return realpathSync(raw); } catch { return raw; }
}

// The contracts home for the workspace root is `contractsHome` from
// src/contracts-dirs.js — the SAME function src/build.js#detectContractsDirs is built
// on, so `apply` can no longer write into a dir the build would not load. This file used
// to carry a hand-synced duplicate of that rule, with a comment on each copy telling the
// other not to drift; there is now nothing to drift.

// Write ONE spec into the contracts home, never silently clobbering a hand-edited
// draft. The spec is meant to be reviewed, extended (payload schemas, direction,
// writer/reader roles), and committed as the user's own — a re-run that overwrote those
// edits with regenerated skeletons would destroy real work. If the file exists and
// differs from what we'd write, back it up first so the edits are always recoverable.
// The backup lands under the gitignored .wiregraph/ (timestamped), NOT as a stray .bak
// in the tracked source contracts/ — a committable backup file would be noise in the
// user's diff. Returns the backup path, or null. Shared by both formats so neither can
// grow a backup rule the other lacks.
function writeSpec(root, dir, name, yaml) {
  const out = join(dir, name);
  let backupPath = null;
  if (existsSync(out) && readFileSync(out, 'utf8') !== yaml) {
    const backupDir = join(wiregraphDir(root), 'contract-backups');
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = join(backupDir, `${basename(out)}.${stamp}.bak`);
    copyFileSync(out, backupPath);
  }
  writeFileSync(out, yaml);
  return { out, backupPath };
}

function main(argv) {
  const [cmd, projectArg] = argv;
  if (cmd !== 'scan' && cmd !== 'apply') {
    process.stderr.write('usage: contracts.mjs <scan|apply> [project]\n');
    process.exit(2);
  }
  const root = resolveRoot(projectArg);
  // Span every linked member so /wiregraph-contracts infers across the union, not
  // just the home root. ONE extraction feeds BOTH clusterers — they read different
  // candidate kinds out of the same pass (wire/message/state vs. const).
  const roots = memberRoots(root);
  // Comment ranges travel with the candidates: a constant named only in a `// TODO`
  // must not make that compartment a participant in the seam.
  // `langFiles` says which languages were actually indexed, which is what lets the wire
  // report name the ones it has no route rule for instead of going quietly empty.
  const { candidates, comments, langFiles } = extractSignals(roots);
  // Every token the user has ALREADY declared by hand, across every member root's
  // contracts dirs. Inference must not re-propose these: a scan that hands back the nine
  // seams already sitting in contracts/ contradicts its own "nothing left to infer"
  // explainer, and an `apply` that writes them into a draft puts a machine-generated spec
  // into direct competition with the specs it copied them from.
  //
  // Read with the SAME discovery the build uses (rootContractsEntries), per member root
  // and at that root's own mode, so a nested hand-written spec in a recursive project is
  // seen. Drafts are excluded from the exclusion set by handWrittenTokens itself.
  const declaredTokens = handWrittenTokens(
    roots.flatMap((r) => rootContractsEntries(r, readState(r)?.mode === 'recursive')));
  // Every DECLINED constant, with its reason. Printed, not swallowed — "it proposed
  // nothing" with no explanation is the one answer a user cannot act on.
  const rejected = [];
  const wireRejected = [];
  const seams = clusterSeams(candidates, { exclude: declaredTokens, rejected: wireRejected });
  const resourceSeams = clusterResourceSeams(candidates, roots, { comments, rejected, exclude: declaredTokens });

  process.stdout.write(formatSeams(seams, wireRejected, langFiles) + '\n');
  process.stdout.write('\n' + formatResourceSeams(resourceSeams, rejected) + '\n');
  // Both formatters already explain the likely reasons for their own emptiness.
  if (!seams.length && !resourceSeams.length) return;

  const yaml = seams.length ? synthesizeAsyncApi(seams) : null;
  const resourceYaml = resourceSeams.length ? synthesizeResourceSpec(resourceSeams) : null;
  const home = contractsHome(root);
  const destOf = (name) => (home ? join(home, name) : join(root, 'contracts', name) + '  (new contracts/ dir)');

  // --- THE DRAFT IS TREE-WIDE. IN RECURSIVE MODE, SAY SO. ----------------------
  // In a recursive project every contracts dir governs only its own subtree, and that
  // scoping is the thing the user opted into. The draft written here does NOT respect it:
  // it lands in the OUTERMOST contracts home (contractsHome is deliberately depth-1) and is
  // therefore scoped to the whole tree, so a root-scoped draft claiming `sim.tick.completed`
  // pulls server code into what the user thinks of as a client contract.
  //
  // THE DRAFT IS NOT MADE SCOPE-AWARE, and this is the reasoning, recorded here because the
  // alternative looks obviously right and is not. Inference is UNION-WIDE by construction:
  // clusterSeams sees every compartment in the graph at once and a seam is BY DEFINITION
  // the thing that spans two of them. Splitting the result per subtree would have to
  // decide, for each seam, which subtree owns it — and for a seam whose two halves live in
  // DIFFERENT subtrees (client/netcli <-> server/netsrv, the motivating case for the whole
  // recursive feature) there is no such subtree below the root. Writing it into either
  // one's contracts dir would scope out the other half and take the seam dark, which is the
  // exact failure contractsHome's depth-1 comment already warns about. The honest split is
  // per-seam and needs a title per scope plus a rule for cross-subtree seams — a feature,
  // not a bug fix.
  //
  // So the draft stays tree-wide and the SCOPE IS DISCLOSED instead of assumed: the user is
  // told, at the moment of writing, that this file governs the whole tree, which nested
  // dirs exist, and what to do about it (move a channel into the nested spec and retitle
  // it). Silence was the defect — the scoping simply stopped applying and nothing said so.
  const recursive = readState(root)?.mode === 'recursive';
  // THE DESTINATION IS NOT ONE OF THE DIRS THE DRAFT AVOIDS, and the message used to say
  // it was. Two things were wrong, both from the same cause — `rootContractsEntries` gives
  // EVERY non-root dir a `scopeRoot` of `dirname(dir)`, so the root's own `contracts/` is
  // scoped to `<root>` and therefore appeared in a list filtered on `scopeRoot !== null`:
  //
  //   1. the destination was named among the "nested (scoped) dirs it does NOT go into",
  //      i.e. the message said the draft both goes there and avoids it;
  //   2. "written UNSCOPED" was false. `<root>/contracts` is scoped to `<root>` — which
  //      does cover every compartment, so the practical claim held, but it is NOT the
  //      null scope `--contracts` and `.wiregraph/inferred/` get, and the difference is
  //      observable: a null scope never competes in the longest-prefix contest, whereas a
  //      `<root>`-scoped draft IS displaced by a nested spec for files inside that
  //      nested dir's subtree. Saying "unscoped" hid exactly the interaction the rest of
  //      the note is about.
  //
  // The destination's scope is computed with rootContractsEntries' OWN rule rather than
  // looked up, because on `apply` the dir may not exist yet when this runs.
  const destDir = home || join(root, 'contracts');
  const destScope = destDir === root ? null : dirname(destDir);
  const nested = recursive
    ? rootContractsEntries(root, true).filter((e) => e.scopeRoot !== null && e.dir !== destDir).map((e) => e.dir)
    : [];
  const scopeNote = () => {
    if (!recursive) return;
    const where = destScope === null
      ? `at ${destDir}, which is UNSCOPED — it is the root's own contracts home, so it matches every file in the tree`
      : `at ${destDir}, whose scope root is ${destScope}${destScope === root ? ' — the whole project tree, so it governs every compartment' : ' — so it governs only that subtree'}`;
    process.stdout.write(
      `\nSCOPE: this project is in RECURSIVE mode, but the draft is inferred across the WHOLE tree and is written `
      + `${where}.\n`
      + (nested.length
        ? `  Other (nested, scoped) contracts dirs, which the draft does NOT go into: ${nested.join(', ')}.\n`
        + '  A nested spec declaring the SAME token wins for files inside its own subtree (longest scope\n'
        + '  root), so this draft sees only the halves outside those subtrees.\n'
        : '  There are no other (nested) contracts dirs yet.\n')
      + '  A seam is cross-compartment by definition, so a seam whose halves sit in two different\n'
      + '  subtrees has no nested dir that could hold it. For a seam that IS contained in one subtree,\n'
      + "  move that channel/resource into that subtree's own spec and give it a DISTINCT info.title\n"
      + '  (recursive mode requires one per scope), then delete it from this draft.\n');
  };

  if (cmd === 'scan') {
    if (yaml) {
      process.stdout.write('\n--- proposed WIRE contract (NOT written) ---\n');
      process.stdout.write(yaml);
      process.stdout.write(`\nWould write to: ${destOf(SPEC_NAME)}\n`);
    }
    if (resourceYaml) {
      process.stdout.write('\n--- proposed RESOURCE contract (NOT written) ---\n');
      process.stdout.write(resourceYaml);
      process.stdout.write(`\nWould write to: ${destOf(RESOURCE_SPEC_NAME)}\n`);
    }
    scopeNote();
    process.stdout.write('Review the seams above, then run apply to write it.\n');
    return;
  }

  // apply — write the draft(s) into the contracts home (create one if none exists).
  let dir = home;
  let created = false;
  if (!dir) { dir = join(root, 'contracts'); mkdirSync(dir, { recursive: true }); created = true; }

  const written = [];
  const backups = [];
  if (yaml) {
    const r = writeSpec(root, dir, SPEC_NAME, yaml);
    written.push(`${seams.length} channel(s) to ${r.out}`);
    if (r.backupPath) backups.push(r.backupPath);
  }
  if (resourceYaml) {
    const r = writeSpec(root, dir, RESOURCE_SPEC_NAME, resourceYaml);
    written.push(`${resourceSeams.length} resource(s) to ${r.out}`);
    if (r.backupPath) backups.push(r.backupPath);
  }

  // Record the contracts home + seam count so the SessionStart nudge can stop and status
  // can report precisely. Only touch state if the project is indexed.
  //
  // The key is `inferredSeams` — the one SessionStart and /wiregraph-status actually read
  // (and the one fullBuild stamps). This used to write `wireSeams`, which nothing has
  // ever read; adding a second dead key for resources would have doubled that. The count
  // is the union of both seam kinds, matching fullBuild's.
  //
  // `contractsDirs` (plural) is stamped alongside, with `dir` UNIONED into whatever the
  // last full build recorded. The nudge gate reads both keys, and in recursive mode the
  // list is the interesting one; writing only the singular here would leave a project that
  // just gained its first (freshly created) contracts dir reporting a plural that does not
  // mention it until the next full build.
  if (readState(root)) {
    const prior = readState(root)?.contractsDirs;
    const dirs = Array.isArray(prior) ? [...prior] : [];
    if (!dirs.includes(dir)) dirs.push(dir);
    updateState(root, { contractsDir: dir, contractsDirs: dirs, inferredSeams: seams.length + resourceSeams.length });
  }

  process.stdout.write(`\nWrote ${written.join(' and ')}${created ? ' (created contracts/)' : ''}.\n`);
  scopeNote();
  for (const b of backups) process.stdout.write(`Existing draft differed — backed it up to ${b} before overwriting.\n`);
  if (resourceYaml) {
    process.stdout.write(
      'The resource draft lists every compartment as BOTH writer and reader — nothing in '
      + 'the code says which side writes. Prune each list before committing — and prune '
      + 'writers: down to the real writer BEFORE adding single_writer:, or it reports an '
      + 'immediate violation against a placeholder.\n');
  }
  // A FULL REBUILD, not an incremental, and not the read tools' self-heal. Writing a draft
  // CHANGES THE SET OF SPECS IN FORCE, which is the exact condition contractsFingerprint
  // exists to catch: contract scope is applied when REFERENCES are minted and stored
  // nowhere, so an incremental over the new set re-derives seams from rows minted under the
  // old one. With a baseline the incremental is REFUSED (a detour at best); without one it
  // proceeds and is silently wrong. This line used to say "the read tools self-heal, or run
  // /wiregraph-update" — advice that predated the fingerprint and was wrong for the state
  // `apply` had just created, so /wiregraph-contracts had to instruct the agent to override
  // its own script out loud.
  process.stdout.write(
    'This is a DRAFT — review/commit it as your own. Now run /wiregraph-rebuild (a FULL '
    + 'rebuild — writing a spec changes the set of contracts in force, so an incremental '
    + 'update is refused or, with no baseline, silently wrong), then walk the seams with '
    + 'trace_contract / path_between or check /wiregraph-status.\n');
}

main(process.argv.slice(2));
