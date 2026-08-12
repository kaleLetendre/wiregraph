#!/usr/bin/env node
// Tests for the COMPARTMENT BOUNDARY rules, the declared-name namespace, and the
// /wiregraph-contracts nudge gate.
//
//   node test/compartments.mjs
//
// STANDALONE ON PURPOSE, following test/review.mjs. test/run.mjs is ~13k lines and is
// edited concurrently; a concurrent append to it has already silently lost 30 tests on this
// project once. Integration into the main runner is a merge-time step: add
// `node test/compartments.mjs` (or `await compartmentTests()`) to run.mjs's tail.
//
// Three defects, one theme: a thing that LOOKS like a declaration was treated as one.
//
//   1. A MANIFEST FILE was treated as a module. `Cargo.toml` was a bare name in a Set, so
//      a VIRTUAL manifest (`[workspace]`, no `[package]` — Cargo's own term for "this
//      directory is not a crate") minted a compartment. `package.json` alone had a rule.
//   2. AN AUTO-DISAMBIGUATED NAME was printed as if it were a declarable one. The collision
//      warning prints `server/network` and says "or declare compartments explicitly to
//      choose your own"; validateDeclaration rejects a name containing '/'.
//   3. A CONTRACTS DIRECTORY was treated as a written contract. The nudge gate asked
//      whether a contracts dir exists — and an empty one is the correct state for code
//      whose contract is not written yet.
//
// The fixtures carry the shapes; the temp trees carry the one-off variants.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, cpSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findCompartmentRoots, walkSources, isCompartmentBoundary, MODULE_MANIFESTS } from '../src/extract/walk.js';
import { validateDeclaration, DISAMBIGUATION_CHARS, INFERRED_PATH_SEP, INFERRED_UNIQ_SEP } from '../src/extract/compartment-decl.js';
import { uncoveredSeams } from '../scripts/lib/state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CARGO_WS = realpathSync(join(HERE, 'fixture-cargo-workspace'));
const EMPTY_CONTRACTS = realpathSync(join(HERE, 'fixture-empty-contracts'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function has(haystack, needle, msg) { ok(String(haystack).includes(needle), `${msg} — missing "${needle}" in:\n${haystack}`); }
function lacks(haystack, needle, msg) { ok(!String(haystack).includes(needle), `${msg} — unexpectedly found "${needle}" in:\n${haystack}`); }

const tmp = (tag) => realpathSync(mkdtempSync(join(tmpdir(), `cg-${tag}-`)));
const mk = (dir, files) => {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
};
// `<relative dir>|<name>` for every inferred boundary, sorted — the shape that shows an
// EXTRA compartment as well as a missing one.
const rootsOf = (root) => findCompartmentRoots(root).map((r) => `${relative(root, r.dir) || '.'}|${r.name}`).sort();

// Everything walkSources yields, keyed by the path relative to the walked root.
function walked(root) {
  const out = {};
  for (const f of walkSources(root)) out[relative(root, f.abs)] = f;
  return out;
}

// Capture what a build would have written to stderr while `fn` runs. warnNameCollision
// writes there directly, and the whole complaint about it is what it SAYS.
function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = (chunk) => { buf += chunk; return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return buf;
}

// === 1. A MANIFEST FILE IS NOT PROOF OF A MODULE ==============================
// The fixture is the whole argument: eight directories hold a manifest, five are modules.
function virtualManifestTest() {
  eq(JSON.stringify(rootsOf(CARGO_WS)), JSON.stringify([
    'harness|harness', 'pkgs/app|app', 'pkgs/legacy|legacy', 'server/net|net', 'server/sim|sim',
  ]), 'manifest: exactly the five directories that DECLARE a module are compartments — the two virtual Cargo manifests and the tool-config pyproject are not');

  const w = walked(CARGO_WS);
  const rootName = basename(CARGO_WS);
  // THE DEFECT ITSELF. `server/` holds a workspace-only Cargo.toml and one stray source
  // file. The crates always won by longest prefix, so this file is the only thing the
  // phantom compartment ever owned — and the compartment existed regardless.
  eq(w['server/shared.rs']?.compartment, rootName,
    'manifest: a file beside a NESTED virtual Cargo manifest attributes to the ROOT compartment, not to a phantom `server`');
  eq(w['server/shared.rs']?.relPath, join('server', 'shared.rs'),
    'manifest: …and its relPath is relative to the root, which is the id half a phantom boundary also moves');

  // The real crates are untouched — this fix must not cost a compartment that a manifest
  // genuinely declares.
  eq(w[join('server', 'net', 'src', 'lib.rs')]?.compartment, 'net', 'manifest: a [package] crate is still a compartment');
  eq(w[join('server', 'net', 'src', 'lib.rs')]?.relPath, join('src', 'lib.rs'), 'manifest: …with relPath relative to the crate root');
  eq(w[join('harness', 'src', 'lib.rs')]?.compartment, 'harness',
    'manifest: a manifest with BOTH [package] and [workspace] is a crate — a workspace root may be a member of itself');

  // pyproject.toml is the direct analogue of the bare package.json rule.
  eq(w[join('tools', 'lint_helper.py')]?.compartment, rootName,
    'manifest: a pyproject.toml holding only [tool.*] linter config is not a distribution');
  eq(w[join('pkgs', 'app', 'app.py')]?.compartment, 'app', 'manifest: a pyproject.toml with [project] is');
  eq(w[join('pkgs', 'legacy', 'old_mod.py')]?.compartment, 'legacy',
    'manifest: …and so is a linter-only pyproject.toml with setup.py beside it — the pre-PEP-621 spelling of a package');

  // The ROOT virtual manifest is the benign half, pinned so the two are not confused: the
  // root is the fallback compartment either way, so no file's compartment or relPath moves.
  ok(!rootsOf(CARGO_WS).some((r) => r.startsWith('.|')),
    'manifest: the ROOT virtual manifest is not a boundary either — and the root is still every stray file\'s compartment, by fallback');
}

// EVERY manifest carries its own rule, and every rule FAILS OPEN. Dropping a boundary moves
// every id under it, so a manifest we could not read or parse must never silently
// re-partition a graph. This is the guard that makes the NEXT manifest answer the question:
// add one whose rule fails closed on an unreadable file and this goes red.
function manifestRuleTableTest() {
  ok(MODULE_MANIFESTS instanceof Map && MODULE_MANIFESTS.size >= 7,
    `manifest/table: MODULE_MANIFESTS is a name -> rule Map (got ${MODULE_MANIFESTS.constructor?.name}, size ${MODULE_MANIFESTS.size})`);
  for (const [name, rule] of MODULE_MANIFESTS) {
    eq(typeof rule, 'function', `manifest/table: ${name} carries a rule (a manifest cannot be added without one)`);
  }
  ok(MODULE_MANIFESTS.has('package.json'),
    'manifest/table: package.json is IN the table — its rule is no longer a bespoke branch in isCompartmentBoundary');

  // The FAIL-OPEN contract, exercised through the real walk: an EMPTY manifest is a
  // boundary for every manifest but package.json, which is documented to fail closed.
  const FAILS_CLOSED = new Set(['package.json']);
  const work = tmp('manifest-open');
  for (const name of MODULE_MANIFESTS.keys()) {
    const dir = mk(join(work, name.replace(/\W/g, '_')), { [name]: '' });
    eq(isCompartmentBoundary(dir, [{ name, isFile: () => true }]), !FAILS_CLOSED.has(name),
      `manifest/table: an EMPTY ${name} ${FAILS_CLOSED.has(name) ? 'is NOT' : 'IS'} a boundary`);
  }
  // Unparseable, not merely empty — the same direction, for the two rules that read content.
  const garbage = mk(join(work, 'garbage'), { 'Cargo.toml': 'this is not toml at all\n[[[' });
  ok(isCompartmentBoundary(garbage, [{ name: 'Cargo.toml', isFile: () => true }]),
    'manifest/table: a MALFORMED Cargo.toml is still a boundary — a parse failure must not silently delete a compartment');
  // A commented-out table cannot make a manifest look virtual: the `[` must be the first
  // non-blank character on the line. Fail-open again, and the safe direction.
  const commented = mk(join(work, 'commented'), { 'Cargo.toml': '# [workspace]\n# members = ["a"]\nname = "x"\n' });
  ok(isCompartmentBoundary(commented, [{ name: 'Cargo.toml', isFile: () => true }]),
    'manifest/table: a [workspace] inside a COMMENT is not a workspace table');
  rmSync(work, { recursive: true, force: true });
}

// A virtual manifest loses to any OTHER boundary marker in the same directory: the rules are
// per manifest, not per directory, and the first one that says "module" wins.
function virtualManifestWithSiblingTest() {
  const work = tmp('virt-sibling');
  const both = mk(join(work, 'both'), {
    'Cargo.toml': '[workspace]\nmembers = ["x"]\n',
    'package.json': '{"name":"both"}',
    'a.js': 'export function bothFn(){ return 1; }\n',
  });
  ok(isCompartmentBoundary(both, [
    { name: 'Cargo.toml', isFile: () => true }, { name: 'package.json', isFile: () => true },
  ]), 'manifest/sibling: a virtual Cargo.toml beside a NAMED package.json is still a boundary — package.json declares the module');
  const git = mk(join(work, 'git'), { 'Cargo.toml': '[workspace]\nmembers = ["x"]\n' });
  mkdirSync(join(git, '.git'), { recursive: true });
  ok(isCompartmentBoundary(git, [{ name: 'Cargo.toml', isFile: () => true }, { name: '.git', isFile: () => false }]),
    'manifest/sibling: …and a .git beside one is a boundary on its own terms');
  rmSync(work, { recursive: true, force: true });
}

// === 2. THE AUTO-DISAMBIGUATED NAMESPACE IS NOT THE DECLARABLE ONE ============
// A real collision, built the way the flagship's is: two crates both called `network`.
function collidingProject(work) {
  const root = mk(join(work, 'proj'), {});
  for (const side of ['server', 'client']) {
    mk(join(root, side, 'network'), {
      'Cargo.toml': `[package]\nname = "${side}-network"\nversion = "0.0.0"\n`,
      'net.rs': `pub fn ${side}_net() -> u32 { 1 }\n`,
    });
  }
  return root;
}

function disambiguatedNamesAreNotDeclarableTest() {
  const work = tmp('disamb');
  const root = collidingProject(work);

  const warning = captureStderr(() => findCompartmentRoots(root));
  const names = findCompartmentRoots(root).map((r) => r.name).sort();
  eq(JSON.stringify(names), JSON.stringify(['client/network', 'server/network']),
    'names: the inferred partition disambiguates the collision to path-derived names');

  // THE CONTRADICTION, ASSERTED AS ONE FACT. Every name the walk MINTS must be a name the
  // declaration path REFUSES — that disjointness is what lets the graph alone say which
  // compartments were auto-renamed (src/store/sqlite-query.js#disambiguatedCompartments).
  // Iterating the produced names rather than hard-coding them is the point: a future change
  // to the rename scheme has to keep the two namespaces disjoint or this goes red.
  for (const name of names) {
    const res = validateDeclaration(root, [{ path: join('server', 'network'), name }]);
    eq(res.ok, false, `names: the minted name "${name}" is NOT a legal declared name`);
    has(res.errors.join('\n'), 'RESERVED',
      `names: …and the rejection says it is RESERVED for auto-disambiguation, which is the true reason`);
  }

  // The warning must not send the author to a name the declaration path refuses. It said
  // "or declare compartments explicitly to choose your own", full stop.
  has(warning, 'COMPARTMENT NAME COLLISION', 'names: the collision is announced');
  has(warning, `a DECLARED name may not contain '${INFERRED_PATH_SEP}'`,
    'names: …and the advice says the printed names cannot be declared verbatim');
  has(warning, 'server_network', 'names: …and offers a legal spelling');

  // What the flagship actually did, and what must keep working.
  const good = validateDeclaration(root, [
    { path: join('server', 'network'), name: 'server_network' },
    { path: join('client', 'network'), name: 'client_network' },
  ]);
  eq(good.ok, true, `names: the underscore spelling the advice recommends IS accepted (${good.errors.join('; ')})`);
  rmSync(work, { recursive: true, force: true });
}

// The reserved set and the id-separator set are DIFFERENT rules with different reasons, and
// the message says which is which. Blaming the id separator for '/' was checkable and false:
// ids join on ':', so `file:server/network:x.rs` has exactly one reading.
function reservedNameCharsTest() {
  const work = tmp('reserved');
  const root = mk(join(work, 'proj'), {});
  mk(join(root, 'sub'), { 'a.js': 'export function aFn(){ return 1; }\n' });
  const err = (name) => validateDeclaration(root, [{ path: 'sub', name }]).errors.join('\n');

  for (const ch of DISAMBIGUATION_CHARS) {
    const e = err(`a${ch}b`);
    ok(e.length > 0, `names/chars: a declared name containing '${ch}' is rejected`);
    has(e, 'RESERVED', `names/chars: …because '${ch}' is reserved for auto-disambiguated names`);
  }
  eq(DISAMBIGUATION_CHARS.join(''), `${INFERRED_PATH_SEP}${INFERRED_UNIQ_SEP}`,
    'names/chars: the reserved set is exactly the separators walk.js mints — one constant, imported by both');

  // The id-separator rule is unchanged, and keeps its own (true) reason.
  const idSep = err('a:b');
  has(idSep, 'spell the same id', 'names/chars: ":" is still rejected as the id separator');
  ok(!validateDeclaration(root, [{ path: 'sub', name: 'a\\b' }]).ok, 'names/chars: "\\" is still rejected');
  ok(!validateDeclaration(root, [{ path: 'sub', name: 'a\u0001b' }]).ok, 'names/chars: a control character is still rejected');
  ok(validateDeclaration(root, [{ path: 'sub', name: 'server_network' }]).ok, 'names/chars: a plain name is accepted');
  ok(validateDeclaration(root, [{ path: 'sub', name: 'client-net.v2' }]).ok,
    'names/chars: …and the rule stays narrow — "-" and "." are not reserved');
  rmSync(work, { recursive: true, force: true });
}

// === 3. AN EMPTY contracts/ IS NOT A WRITTEN CONTRACT =========================
const SPEC = 'asyncapi: 3.0.0\ninfo: { title: Empty Fixture Wire, version: 1.0.0 }\nchannels:\n  tick: { address: events/tick }\n';

function emptyContractsDirNudgeTest() {
  const dirs = ['contracts', join('server', 'contracts'), join('client', 'contracts')].map((d) => join(EMPTY_CONTRACTS, d));

  // THE DEFECT. Three contracts dirs, recorded exactly as a full build records them, and
  // not one contract written. The old gate (`!contractsDir && !contractsDirs?.length`) read
  // this as covered.
  eq(uncoveredSeams({ inferredSeams: 4, contractsDir: dirs[0], contractsDirs: dirs }), 4,
    'nudge: named-but-specless contracts dirs do NOT count as coverage — the seams are still uncovered');
  eq(uncoveredSeams({ inferredSeams: 4, contractsDir: null, contractsDirs: null }), 4,
    'nudge: a project with no contracts dir at all still fires (the legacy case)');
  eq(uncoveredSeams({ inferredSeams: 0, contractsDir: null, contractsDirs: null }), 0, 'nudge: no seams, no nudge');
  eq(uncoveredSeams({ inferredSeams: 0, contractsDir: dirs[0], contractsDirs: dirs }), 0, 'nudge: …and no seams wins over everything');
  eq(uncoveredSeams(null), 0, 'nudge: a missing state is silent, not a crash');

  const work = tmp('nudge');
  const root = join(work, 'proj');
  cpSync(EMPTY_CONTRACTS, root, { recursive: true });
  const copy = ['contracts', join('server', 'contracts'), join('client', 'contracts')].map((d) => join(root, d));

  // ONE spec, in the LAST of the three dirs, silences it: coverage is a property of the
  // whole recorded set, not of the first entry.
  writeFileSync(join(copy[2], 'tick.asyncapi.yaml'), SPEC);
  eq(uncoveredSeams({ inferredSeams: 4, contractsDir: copy[0], contractsDirs: copy }), 0,
    'nudge: one written contract anywhere in the recorded set silences it');

  // The spec test is the loader’s, not a local guess at what a spec looks like.
  writeFileSync(join(copy[0], 'notes.yaml'), 'just: notes\n');
  writeFileSync(join(copy[0], 'README.md'), 'still empty of specs\n');
  eq(uncoveredSeams({ inferredSeams: 4, contractsDir: copy[0], contractsDirs: [copy[0]] }), 4,
    'nudge: a plain .yaml and a README are not specs — only what the loader parses counts');
  writeFileSync(join(copy[0], 'queries.inproc.yaml'), 'inproc: 1\n');
  eq(uncoveredSeams({ inferredSeams: 4, contractsDir: copy[0], contractsDirs: [copy[0]] }), 0,
    'nudge: …and EVERY spec format counts, not just asyncapi (SPEC_FORMATS is shared)');

  // A legacy state carries only the singular. And a recorded dir that has since been
  // deleted is not coverage — deleting the only contracts dir genuinely uncovers the seams.
  eq(uncoveredSeams({ inferredSeams: 4, contractsDir: copy[1] }), 4,
    'nudge: a legacy state with only the SINGULAR key is still judged on its specs');
  eq(uncoveredSeams({ inferredSeams: 4, contractsDir: copy[0] }), 0,
    'nudge: …in both directions');
  eq(uncoveredSeams({ inferredSeams: 4, contractsDir: join(root, 'gone'), contractsDirs: [join(root, 'gone')] }), 4,
    'nudge: a recorded dir that no longer exists is not coverage');

  const src = readFileSync(join(HERE, '..', 'scripts', 'hooks', 'session-start.mjs'), 'utf8');
  has(src, 'const seams = uncoveredSeams(state);', 'nudge: …and the hook really uses that gate');
  // The old gate, as CODE (the comment above it still quotes the expression, on purpose —
  // it is the record of what changed).
  lacks(src, 'const seams = state.inferredSeams || 0;',
    'nudge: …and no longer counts seams without asking whether any contract is written');
  lacks(src, 'const contractsHint = (seams > 0 &&',
    'nudge: …and no longer gates on the mere EXISTENCE of a contracts dir');
  rmSync(work, { recursive: true, force: true });
}

virtualManifestTest();
manifestRuleTableTest();
virtualManifestWithSiblingTest();
disambiguatedNamesAreNotDeclarableTest();
reservedNameCharsTest();
emptyContractsDirNudgeTest();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
