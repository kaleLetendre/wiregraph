#!/usr/bin/env node
// Tests for scripts/review.mjs — the deterministic engine behind /wiregraph-review,
// STAGE 1 (drift axes A, B, F, G).
//
//   node test/review.mjs
//
// STANDALONE ON PURPOSE, and not appended to test/run.mjs. That file is ~12k lines and is
// edited concurrently; a concurrent append to it has already silently lost 30 tests on this
// project once. Integration into the main runner is a merge-time step: add
// `await reviewTests()` (or `node test/review.mjs`) to run.mjs's tail.
//
// The three fixtures are the whole design argument:
//   fixture-review-clean     — the FALSE-POSITIVE GUARD. Correct in every respect; must
//                              yield zero drift and zero questions. A review that cries
//                              wolf on a correct tree is worse than no review.
//   fixture-review-flagship  — a faithful miniature of the flagship's project-structure.md
//                              §01 (same levels, same contracts/ placement, the same
//                              `client/network` vs `server/network` basename collision, the
//                              same server↔client ROLE contract) with TWO contracts
//                              deliberately misfiled: one an R4 violation with a settled
//                              fix, one the §05 ambiguity that must be ASKED, not guessed.
//   fixture-review-drift     — one deliberate drift per finding code.
//
// Also asserted: the engine never writes to the tree it reviews. The flagship repo is
// reviewed read-only from outside, and two stray `.wiregraph/` dirs have already been
// created in it by tools that assumed a cwd.

import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { review } from '../scripts/review.mjs';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW = join(HERE, '..', 'scripts', 'review.mjs');
const CLEAN = join(HERE, 'fixture-review-clean');
const FLAGSHIP = join(HERE, 'fixture-review-flagship');
const DRIFT = join(HERE, 'fixture-review-drift');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function has(haystack, needle, msg) { ok(String(haystack).includes(needle), `${msg} — missing "${needle}" in:\n${haystack}`); }

const codes = (res) => res.findings.map((f) => f.code);
const byCode = (res, code) => res.findings.find((f) => f.code === code);
const itemText = (res, code) => (byCode(res, code)?.items || []).join('\n');

// Every file under `dir`, relative and sorted — the read-only assertion's subject.
function snapshot(dir) {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(d, e.name);
      if (e.isDirectory()) { out.push(relative(dir, full) + '/'); walk(full); }
      else out.push(relative(dir, full));
    }
  })(dir);
  return out.join('\n');
}

function tmpCopy(fixture) {
  const work = mkdtempSync(join(tmpdir(), 'wg-review-'));
  const dst = join(work, 'proj');
  cpSync(fixture, dst, { recursive: true });
  return { work, root: realpathSync(dst) };
}

// --- 1. the false-positive guard ---------------------------------------------
function cleanTest() {
  const res = review(realpathSync(CLEAN));
  eq(res.counts.drift, 0, 'clean fixture reports no drift');
  eq(res.counts.ask, 0, 'clean fixture asks nothing');
  ok(codes(res).includes('A0'), 'clean fixture still reports that axis A could not run (undeclared)');
  eq(byCode(res, 'A0').severity, 'note', 'an undeclared project with no basename collision is a NOTE, not drift');
  ok(codes(res).includes('B2'), 'clean fixture accounts for its one deliberately-unwritten contract');
  has(itemText(res, 'B2'), 'contracts/a-b.md', 'B2 names the unwritten contract');
  // The parse is REPORTED, so a structure doc that silently parses to nothing is visible.
  eq(res.parsed.indexRows, 1, 'clean fixture: one index row parsed');
  eq(res.parsed.compartmentRows, 2, 'clean fixture: two compartment rows parsed');
  eq(res.parsed.treeNodes, 3, 'clean fixture: three tree nodes parsed');
}

// --- 2. the flagship miniature, and the two misfilings ------------------------
function flagshipMiniatureTest() {
  const res = review(realpathSync(FLAGSHIP));

  // Structure recognised: the same shape as the flagship's §01.
  eq(res.compartments.length, 10, 'flagship miniature: ten compartments found on disk');
  eq(res.contractsDirs.length, 4, 'flagship miniature: four contracts dirs found');
  ok(res.compartments.includes('server/ecs/queries'), 'a compartment two levels down is found');

  // AXIS F, the R4 case — one cause, one fix, no question.
  const f2 = byCode(res, 'F2');
  ok(!!f2, 'axis F catches the contract filed inside one of its own sides (R4)');
  eq(f2.severity, 'drift', 'the R4 misfiling is DRIFT, not a question');
  eq(f2.fix, 'determined', 'the R4 misfiling has a determined fix direction');
  has(itemText(res, 'F2'), 'server/ecs/contracts/ecs-sim.md', 'F2 names the misfiled contract');
  has(itemText(res, 'F2'), 'filed INSIDE server/ecs', 'F2 says WHICH side owns it');
  has(itemText(res, 'F2'), 'move to server/contracts/', 'F2 states the destination, which is the shared parent');

  // AXIS F, the §05 case — two causes, and the engine must not pick one.
  const f3 = byCode(res, 'F3');
  ok(!!f3, 'axis F catches the contract whose sides sit at different levels (§05)');
  eq(f3.severity, 'ask', 'the §05 misfiling is an ASK, not settled drift');
  eq(f3.fix, 'ask', 'the §05 misfiling has no determined fix direction');
  has(itemText(res, 'F3'), 'server/contracts/sim-queries.md', 'F3 names the contract');
  has(itemText(res, 'F3'), 'level 2', 'F3 states the depth of the shallower side');
  has(itemText(res, 'F3'), 'level 3', 'F3 states the depth of the deeper side');
  has(itemText(res, 'F3'), 'MISFILED:', 'F3 names the misfiled diagnosis');
  has(itemText(res, 'F3'), 'LEAKING:', 'F3 names the boundary-leak diagnosis');
  has(f3.direction, 'stage 2', 'F3 says why it cannot tell them apart here');

  // The basename collision the flagship really has, surfaced before it can bite.
  const a0 = byCode(res, 'A0');
  eq(a0.severity, 'drift', 'an undeclared project WITH a basename collision is drift');
  has(itemText(res, 'A0'), 'client/network, server/network', 'A0 names both sides of the collision');

  // Side resolution: a bare `network/` in a client-scoped contract must resolve to
  // client/network and not go unresolved just because server/network exists too.
  ok(!codes(res).includes('F4'), 'the ambiguous bare side `network` resolves via the contract\'s own level');
  ok(!codes(res).includes('F0'), 'the unticked `server ↔ client *(role)*` row parses to two sides');
  ok(!codes(res).includes('F1'), 'no R1 violation in the miniature');

  // Deliberate absence survives: three contracts are unwritten and all three are noted.
  eq(byCode(res, 'B2').items.length, 3, 'three deliberately-unwritten contracts, all accounted for');
  ok(!codes(res).includes('B1'), 'no unaccounted missing contract');
  ok(!codes(res).includes('B3'), 'both on-disk contracts are listed in the index');
  ok(!codes(res).includes('B4'), 'every contracts dir carries a note');

  // Axis G is clean: the tree block matches disk exactly.
  ok(!codes(res).includes('G1'), 'no tree path is absent from disk');
  ok(!codes(res).includes('G2'), 'no annotated file is missing');
  ok(!codes(res).includes('G3'), 'every compartment and contracts dir on disk is named in the tree');
  ok(!codes(res).includes('G4'), 'every compartment-table row resolves (via its section heading)');

  // The budget: a review that emits forty findings has moved the maintenance cost.
  ok(res.findings.length <= 5, `the miniature yields few findings, not many (got ${res.findings.length})`);
  eq(res.counts.ask, 1, 'exactly one question is asked');
}

// --- 3. one deliberate drift per code ----------------------------------------
async function driftTest() {
  const { work, root } = tmpCopy(DRIFT);
  // An EMPTY contracts dir cannot be committed (git does not track empty directories), so
  // the B4 case is created in the copy.
  mkdirSync(join(root, 'b', 'contracts'), { recursive: true });
  const res = review(root);
  const c = codes(res);
  for (const [code, why] of [
    ['B1', 'a contract in the index with no file and no note'],
    ['B3', 'a contract on disk that the index does not list'],
    ['B4', 'an empty contracts dir with no note'],
    ['F0', 'an index row whose sides cannot be read'],
    ['F1', 'a contract naming three sides (R1)'],
    ['F4', 'a side naming no compartment, unmarked as a role'],
    ['G1', 'a tree path that does not exist'],
    ['G2', 'an annotated file that is not there'],
    ['G3', 'a compartment on disk the tree does not name'],
  ]) ok(c.includes(code), `drift fixture reports ${code} — ${why}`);

  has(itemText(res, 'B3'), 'contracts/x-y.md', 'B3 names the unlisted contract');
  has(itemText(res, 'B4'), 'b/contracts', 'B4 names the silent dir');
  has(itemText(res, 'F1'), 'names 3 sides', 'F1 says how many sides it found');
  has(itemText(res, 'F4'), 'z', 'F4 names the side that resolves to nothing');
  has(itemText(res, 'G1'), 'ghost/', 'G1 names the path the doc promises');
  has(itemText(res, 'G2'), 'a/Cargo.toml', 'G2 names the annotated file that is absent');
  has(itemText(res, 'G3'), 'b/hidden/', 'G3 names the undocumented compartment');
  // Every stage-1 fix direction except the §05 one is settled by the spec, so nothing here
  // is a question: the structure document yields to disk (§11).
  eq(res.counts.ask, 0, 'none of these drifts is a question — §11 settles the direction');
  for (const f of res.findings.filter((x) => x.severity === 'drift')) {
    ok(f.fix === 'determined', `${f.code} states a determined fix direction`);
    ok(!!f.direction, `${f.code} says what the fix IS`);
  }
  rmSync(work, { recursive: true, force: true });
}

// --- 4. axis A, which needs a declaration (never committable — .wiregraph/ is ignored) --
function declarationTest() {
  const { work, root } = tmpCopy(CLEAN);
  const declare = (compartments) => {
    mkdirSync(join(root, '.wiregraph'), { recursive: true });
    writeFileSync(join(root, '.wiregraph', 'state.json'),
      JSON.stringify({ project: root, mode: 'recursive', compartments }, null, 2));
  };

  // Matching declaration → axis A runs and is clean.
  declare([{ path: 'a', name: 'a' }, { path: 'b', name: 'b' }]);
  let res = review(root);
  eq(res.declaration.state, 'declared', 'the declaration is in force');
  ok(!codes(res).includes('A0'), 'axis A runs once compartments are declared');
  ok(!codes(res).includes('A1') && !codes(res).includes('A2'), 'a matching declaration is clean');

  // A compartment on disk that the declaration omits.
  declare([{ path: 'a', name: 'a' }]);
  res = review(root);
  ok(codes(res).includes('A2'), 'A2: a compartment on disk the declaration does not name');
  has(itemText(res, 'A2'), 'b', 'A2 names the undeclared compartment');
  eq(byCode(res, 'A2').fix, 'determined', 'A2 fix direction is determined — disk wins (§11)');

  // A declared path that is not a compartment. validateDeclaration refuses the whole
  // declaration when the directory is absent, so this lands as A3 (UNUSABLE) — which is
  // the more important finding: the build is silently running on inferred compartments.
  declare([{ path: 'a', name: 'a' }, { path: 'b', name: 'b' }, { path: 'nope', name: 'nope' }]);
  res = review(root);
  eq(res.declaration.state, 'unusable', 'a declaration naming an absent directory is unusable');
  ok(codes(res).includes('A3'), 'A3: the declaration is present but the build refuses it');
  has(itemText(res, 'A3'), 'nope', 'A3 names the offending entry');

  // A declared directory that exists but carries no whoami — usable, and A1's case.
  mkdirSync(join(root, 'c'), { recursive: true });
  writeFileSync(join(root, 'c', 'placeholder.txt'), 'not a compartment\n');
  declare([{ path: 'a', name: 'a' }, { path: 'b', name: 'b' }, { path: 'c', name: 'c' }]);
  res = review(root);
  eq(res.declaration.state, 'declared', 'a declared directory that exists is usable');
  ok(codes(res).includes('A1'), 'A1: a declared path that is not a compartment on disk');
  has(itemText(res, 'A1'), 'c', 'A1 names the declared non-compartment');

  rmSync(work, { recursive: true, force: true });
}

// --- 5. degenerate inputs — it must run on a repo with nothing in it ----------
function degenerateTest() {
  const work = mkdtempSync(join(tmpdir(), 'wg-review-empty-'));
  const res = review(realpathSync(work));
  eq(res.compartments.length, 0, 'an empty directory has no compartments');
  ok(codes(res).includes('B0'), 'no structure document is reported, not crashed on');
  eq(res.counts.drift, 0, 'an empty directory is not drift');
  eq(res.structureDoc, null, 'no structure document resolved');

  // A tree with compartments but no structure document: axes B/F/G stand down, axis A
  // still speaks. This is the shape of a project that adopted whoami files first.
  const dst = join(work, 'proj');
  cpSync(CLEAN, dst, { recursive: true });
  rmSync(join(dst, 'project-structure.md'));
  const res2 = review(realpathSync(dst));
  eq(res2.compartments.length, 2, 'compartments are found without a structure document');
  ok(codes(res2).includes('B0'), 'the missing structure document is reported');
  ok(!codes(res2).some((x) => /^[FG]/.test(x)), 'axes F and G emit nothing without an index');
  rmSync(work, { recursive: true, force: true });
}

// --- 6. the engine writes NOTHING into the tree it reviews --------------------
async function readOnlyTest() {
  const { work, root } = tmpCopy(FLAGSHIP);
  const before = snapshot(root);
  review(root);
  await execFileP(process.execPath, [REVIEW, root, '--json']);
  await execFileP(process.execPath, [REVIEW, root, '--no-color']);
  eq(snapshot(root), before, 'reviewing a tree creates and removes nothing in it (no stray .wiregraph/)');
  rmSync(work, { recursive: true, force: true });
}

// --- 7. the CLI ---------------------------------------------------------------
async function cliTest() {
  const { stdout } = await execFileP(process.execPath, [REVIEW, FLAGSHIP, '--json']);
  const res = JSON.parse(stdout);
  eq(res.stage, 1, 'the CLI reports which stage ran');
  ok(res.findings.some((f) => f.code === 'F3'), 'the CLI surfaces the §05 question');
  ok(Number.isInteger(res.counts.drift), 'counts are machine-readable');

  const { stdout: text } = await execFileP(process.execPath, [REVIEW, FLAGSHIP, '--no-color']);
  has(text, 'STAGE 1', 'the human report names the stage');
  has(text, 'VERDICT:', 'the human report ends with a verdict');
  has(text, 'NOT CHECKED AT STAGE 1:', 'the human report says what it did NOT check');
  has(text, 'trace_contract', 'the deferred list points axis E at the existing tool');
  ok(!/\x1b\[/.test(text), '--no-color emits no escape codes');

  // An explicit --structure path is honoured, and a bad one degrades to B0 rather than
  // throwing.
  const { stdout: bad } = await execFileP(process.execPath,
    [REVIEW, FLAGSHIP, '--structure', join(FLAGSHIP, 'nope.md'), '--json']);
  ok(JSON.parse(bad).findings.some((f) => f.code === 'B0'), 'a missing --structure path degrades to B0');

  // Exit code is 0 even with drift — the caller is an agent, and a non-zero exit reads as
  // "the script broke".
  const { stdout: d } = await execFileP(process.execPath, [REVIEW, DRIFT, '--json']);
  ok(JSON.parse(d).counts.drift > 0, 'the drift fixture exits 0 while reporting drift');
}

cleanTest();
flagshipMiniatureTest();
await driftTest();
declarationTest();
degenerateTest();
await readOnlyTest();
await cliTest();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
