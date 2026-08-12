// Where a root's contract specs live. ONE implementation — this rule used to exist in
// two hand-synced copies (src/build.js#detectContractsDirs and
// scripts/contracts.mjs#contractsHome), each carrying a comment telling the other not to
// drift from it. Now there is nothing to drift: `contractsHome` is this function's first
// element, and scripts/lib/compartments.mjs reads the same list to name the specs a new
// compartment declaration invalidates.
//
// Deliberately dependency-light (node:fs + node:path, plus the IGNORE_DIRS constant) so a
// small CLI can import it without pulling in the extractor and its native grammars.
// src/extract/lang.js is a leaf module — two plain `export const`s, zero imports — so
// taking IGNORE_DIRS from it costs nothing at module-evaluation time and keeps the ONE
// definition of "directories we never descend into" (scripts/lib/workspace.mjs already
// imports it the same way).

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, dirname } from 'node:path';
import { IGNORE_DIRS } from './extract/lang.js';

// A directory name that marks a contracts home: `contracts`/`asyncapi` (any case),
// or any `*-contracts` dir. Matched case-insensitively.
const CONTRACTS_DIR_NAME = /^(contracts|asyncapi)$/i;
export function isContractsDirName(name) {
  return CONTRACTS_DIR_NAME.test(name) || /-contracts$/i.test(name);
}

// Does `dir` DIRECTLY contain at least one AsyncAPI spec? (Lets a standalone
// `payments-contracts/` repo whose specs sit at its top level be discovered as its own
// contracts home, not just via a nested contracts/ child.)
//
// DELIBERATELY AsyncAPI-ONLY, even though *.resource.yaml is a first-class spec format.
// This predicate is the only thing that can promote an ARBITRARY directory — a whole repo
// root — into a contracts home, and `*.resource.yaml` is not a wiregraph-exclusive
// filename: Crossplane, kustomize and assorted k8s tooling emit files named exactly that.
// Accepting it meant any such repo silently became its own contracts dir, which flipped
// `state.contractsDir` from null to the repo ROOT — permanently silencing the
// /wiregraph-contracts nudge (scripts/hooks/session-start.mjs gates on
// `seams > 0 && !contractsDir`) and making `/wiregraph-contracts apply` write the
// inferred spec to the repo root instead of contracts/.
//
// A resource-only contracts home is still found, by NAME: `contracts/`, `asyncapi/` and
// `*-contracts` all match isContractsDirName, which needs no file test at all. What is
// gone is exactly the case with no corroborating signal — an arbitrarily named directory
// holding a file that merely ends in `.resource.yaml`.
//
// IT STAYS ASYNCAPI-ONLY NOW THAT `*.inproc.yaml` EXISTS TOO, and that is a decision, not
// an omission. The rationale above is about what a filename PROVES, and it splits the three
// formats differently from every other list in this file: `.asyncapi.yaml` is a public
// standard nobody else writes into an arbitrary directory, while `.resource.yaml` collides
// with k8s tooling. `.inproc.yaml` is wiregraph-exclusive and so does not have the resource
// format's collision problem — but it also has no corroborating signal of its own, and
// admitting it would re-arm the same failure for a repo that happens to hold one at its
// root: `state.contractsDir` flips from null to the repo ROOT, permanently silencing the
// /wiregraph-contracts nudge and making `apply` write the inferred spec to the root. The
// upside is nil, because an inproc-only contracts home is ALREADY found by NAME like a
// resource-only one, and inference emits no inproc draft to misplace. So the weaker
// predicate is kept, and — this is the part that matters — it is deliberately NOT driven by
// SPEC_FORMATS below: the two lists answer different questions ("may this directory be
// promoted to a contracts home?" vs "is this a spec the loader parses?") and unifying them
// would silently re-import the k8s collision the moment someone tidied them together.
const SPEC_FILE_RE = /\.asyncapi\.ya?ml$/i;
export function hasTopLevelSpec(dir) {
  try {
    for (const f of readdirSync(dir)) if (SPEC_FILE_RE.test(f)) return true;
  } catch { /* unreadable */ }
  return false;
}

// Auto-detect the contracts dirs for `root`, returning ALL matches deduped
// (a root with both contracts/ and api-contracts/ loads BOTH, deterministically):
//   - every CHILD dir whose name looks like a contracts dir — matched
//     case-insensitively, in SORTED order, following a symlink-to-dir;
//   - then `root` ITSELF when its basename looks like a contracts dir, or it directly
//     holds *.asyncapi.y(a)ml files (a standalone *-contracts repo linked in).
// The cross-compartment wire feature only activates if at least one exists, so
// projects without any just skip it.
//
// ORDER IS LOAD-BEARING, twice over. It is spec precedence (loadAllContracts keeps the
// first contributor's name/file and resolves collisions in this order), and
// `roots.flatMap(detectContractsDirs)[0]` is what fullBuild records as
// `state.contractsDir` — the dir /wiregraph-contracts writes into. A purpose-named
// `contracts/` child is a far stronger statement of intent than a root that merely holds
// a spec file, so children come FIRST and are sorted for determinism across filesystems.
//
// SYMLINKS ARE FOLLOWED HERE ON PURPOSE, unlike a declared compartment path
// (src/extract/compartment-decl.js rejects those). A contracts dir is READ from — one
// readdir + readFile per spec, which follow links like any other path — whereas a
// compartment root is WALKED with Dirent.isDirectory(), which reports false for a
// symlink-to-dir and would leave the compartment permanently empty. Different mechanism,
// different verdict; do not "unify" them.
//
// RECURSIVE MODE (`{ recursive: true }`, opt-in per project via state.mode) walks the WHOLE
// subtree instead of one level — see the second half of this function. GLOBAL MODE IS THE
// DEFAULT AND IS UNTOUCHED: with no options the body below is byte-for-byte the depth-1
// scan it has always been.
export function detectContractsDirs(root, opts = {}) {
  const dirs = [];
  const seen = new Set();
  const add = (p) => { if (!seen.has(p)) { seen.add(p); dirs.push(p); } };
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  // A plain dir counts; so does a symlink that RESOLVES to a dir (isDirectory() is false
  // for a symlink-to-dir, so stat the target explicitly).
  const resolvesToDir = (e, full) => {
    if (e.isDirectory()) return true;
    if (!e.isSymbolicLink()) return false;
    try { return statSync(full).isDirectory(); } catch { return false; }
  };

  if (opts.recursive) {
    // Depth-unbounded, and it MUST skip IGNORE_DIRS. The depth-1 scan never needed that
    // filter — a `contracts/` sitting directly under the root is the user's own — but
    // recursing without it indexes every `contracts/` under node_modules/, vendor/,
    // target/, dist/ and the checked-in test fixtures of whatever is vendored in. Same
    // shape as findRoots (src/extract/walk.js) and hasNestedIndex (scripts/lib/state.mjs).
    //
    // DESCENT USES e.isDirectory() ONLY — a symlink-to-dir is never followed DOWN, exactly
    // as walk.js does, so a symlink cycle cannot hang the scan. A symlinked contracts dir
    // is still MATCHED (resolvesToDir above), preserving the deliberate
    // follow-the-symlink-here behaviour documented above; only the recursion refuses to
    // traverse links. Different question, different answer, and the walk agrees with us
    // about which directories exist at all.
    //
    // A contracts dir is not descended INTO: specs live in it, not in a `contracts/`
    // nested inside it, and stopping there keeps the result a list of contract HOMES
    // rather than of every directory that happens to sit under one.
    //
    // ORDER: SHALLOWEST FIRST, then lexicographic — then the root itself, LAST. Depth is
    // the precedence rule that matches the feature's meaning: an outer contracts dir
    // governs a strictly larger subtree than an inner one, so it is the more general
    // statement and wins a title collision (loadAllContracts keeps the first contributor),
    // and it is the dir `state.contractsDir` names for /wiregraph-contracts. The root
    // stays LAST for the same reason it does in global mode — a purpose-named `contracts/`
    // outranks a root that merely happens to hold a spec file.
    const found = [];
    (function scan(dir, depth) {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (IGNORE_DIRS.has(e.name)) continue;
        const full = join(dir, e.name);
        if (isContractsDirName(e.name)) {
          if (resolvesToDir(e, full)) found.push({ full, depth });
          continue;
        }
        if (e.isDirectory()) scan(full, depth + 1);
      }
    })(root, 1);
    found.sort((a, b) => a.depth - b.depth || (a.full < b.full ? -1 : a.full > b.full ? 1 : 0));
    for (const f of found) add(f.full);
    if (isContractsDirName(basename(root)) || hasTopLevelSpec(root)) add(root);
    return dirs;
  }

  try {
    for (const e of readdirSync(root, { withFileTypes: true }).sort(byName)) {
      if (!isContractsDirName(e.name)) continue;
      const full = join(root, e.name);
      if (resolvesToDir(e, full)) add(full);
    }
  } catch { /* unreadable root — skip contracts */ }

  if (isContractsDirName(basename(root)) || hasTopLevelSpec(root)) add(root);

  return dirs;
}

// The `{ dir, scopeRoot }` pairs ONE walked root contributes — the SINGLE definition of
// "which subtree does this contracts dir govern", shared by the build's
// resolveContractsDirs (src/build.js) and the contracts-dir FINGERPRINT
// (scripts/lib/state.mjs#contractsFingerprint). They must agree exactly: the fingerprint's
// whole job is to notice when the set the incremental would use differs from the set the
// last full build actually used, and two copies of this rule would produce spurious
// rebuilds (or, worse, miss a real narrowing).
//
// `scopeRoot` is the directory a contract GOVERNS; null means UNSCOPED — matches every
// file, which is today's behaviour and therefore what global mode always gets.
//
//   - global mode          -> null for every dir. UNCHANGED, byte for byte.
//   - recursive, dir under root -> dirname(dir). `server/contracts/` governs the siblings
//     of its parent, i.e. everything under `server/`, and nothing else.
//   - recursive, dir IS the root -> null, NOT dirname(root). A root that is ITSELF a
//     contracts home (a `*-contracts`-named repo, or one holding a top-level
//     `*.asyncapi.yaml`) has no parent inside the project: dirname() lands OUTSIDE the
//     project entirely, so the contract would govern the root's SIBLINGS. In a linked
//     union of sibling members that silently governs the sibling; when the members are not
//     siblings, a linked standalone contracts repo scoped to its own parent matches
//     nothing and takes every cross-member seam dark. Unscoped is the same verdict
//     `--contracts <dir>` and `.wiregraph/inferred/` already get, and for the same reason:
//     there is no natural scope, so it must not invent one.
export function rootContractsEntries(root, recursive) {
  return detectContractsDirs(root, { recursive: !!recursive })
    .map((dir) => ({ dir, scopeRoot: recursive && dir !== root ? dirname(dir) : null }));
}

// --- the RESOLVED SPECS, which is what actually determines the partition ------
// `rootContractsEntries` above answers "which directories", and that is what the build
// needs to LOAD. It is NOT what determines contract scope, and hashing it was the Phase 3
// fix's mistake: `scopeRoot` is a pure function of `dir`, so a `{dir, scopeRoot}` hash
// carries not one bit the bare dir list does not already carry. Scope is decided by WHICH
// SPEC sits in WHICH directory UNDER WHAT TITLE — content, not container. Three ordinary
// edits move the boundary without moving the dir set at all:
//
//   - a spec MOVED between two contracts dirs that both already exist (`mv
//     contracts/outer.asyncapi.yaml harness/contracts/` narrows that contract from the
//     whole tree to `harness/` — identical dir set, identical dir hash);
//   - a spec's `info.title` EDITED (same file, different contractId — and retitling is the
//     remedy `enforceDistinctTitlePerScope` actively steers users toward on a collision,
//     so the tool creates this path itself);
//   - a spec ADDED to, or REMOVED from, a dir that already exists.
//
// So this is what the fingerprint hashes. It is layered ON TOP of rootContractsEntries
// rather than beside it, so "which dir governs what" stays the ONE definition the build and
// the fingerprint share (see the note above).
//
// DIGEST IS CONTENT, NOT mtime+size. Specs are small and few — a handful of files of a few
// hundred bytes per root — so reading them is cheap, whereas mtime churns on every `git
// checkout`/`rsync` and would force a full rebuild for a byte-identical tree.
//
// A dir with NO specs contributes NOTHING, deliberately: an empty `contracts/` mints no
// contract node, no REFERENCES row and no seam, so it cannot produce the cross-scope group
// the fingerprint exists to prevent, and hashing it would force rebuilds that change no
// graph row. An UNREADABLE spec is listed with a null digest rather than dropped — it is
// still a file the loader will try (and fail) to parse, and "present but unreadable" is a
// different state from "absent".
//
// The filename test must match what readContractsDir actually PARSES (src/extract/contracts.js
// SPEC_PARSERS): EVERY format, both YAML extensions, case-insensitive. A file the loader
// ignores must not move the fingerprint — and, the direction that actually bites, a file the
// loader DOES parse must not be invisible to it.
//
// THIS LIST IS A THIRD REGISTRATION POINT FOR A NEW SPEC FORMAT, and the quietest of the
// three. `*.inproc.yaml` shipped parsed, matched, derived, pruned and re-derived correctly
// while this regex still named two formats, and the consequence was not a missing feature
// but a WRONG GRAPH: an inproc spec could be added, edited, retitled, MOVED between two
// contracts dirs (which narrows its scope in recursive mode) or deleted outright without
// moving the fingerprint one bit, so incrementalBuild's contractsDrift refusal never fired
// and the save loop re-derived seams over REFERENCES rows minted under the OLD scope —
// fabricating a cross-scope INPROC edge that a full rebuild does not produce. The same move
// of a *.resource.yaml was refused, correctly, the whole time.
//
// SPEC_FORMATS is exported so the suite can pin it against src/extract/contracts.js's parser
// table by COUNT as well as by content: a fourth format that adds a parser and forgets this
// line fails a test rather than shipping the defect above again. contracts-dirs.js stays
// dependency-light on purpose (node:fs + node:path + the IGNORE_DIRS leaf), so it declares
// the list rather than importing it from the extractor.
export const SPEC_FORMATS = ['asyncapi', 'resource', 'inproc'];
const SPEC_ANY_RE = new RegExp(`\\.(${SPEC_FORMATS.join('|')})\\.ya?ml$`, 'i');

// The specs ONE `{dir, scopeRoot}` entry contributes, sorted by filename (readdir order is
// filesystem-dependent; the caller sorts the whole set again, but keeping this stable makes
// the value readable in a log). A bare string is accepted for the unscoped single-dir
// callers, exactly as readContractsDir does.
export function contractsDirSpecs(entry) {
  const dir = typeof entry === 'string' ? entry : entry.dir;
  const scopeRoot = typeof entry === 'string' ? null : (entry.scopeRoot ?? null);
  let names;
  try { names = readdirSync(dir).sort(); } catch { return []; } // absent/unreadable dir — no specs
  const out = [];
  for (const f of names) {
    if (!SPEC_ANY_RE.test(f)) continue;
    const spec = join(dir, f);
    let digest = null;
    try { digest = createHash('sha1').update(readFileSync(spec)).digest('hex').slice(0, 16); }
    catch { digest = null; } // present but unreadable — recorded as such, not dropped
    out.push({ spec, scopeRoot, digest });
  }
  return out;
}

// Every spec ONE walked root contributes, each tagged with the scope its dir gives it.
// The subject of the contracts fingerprint (scripts/lib/state.mjs#contractsFingerprint).
export function rootContractsSpecs(root, recursive) {
  return rootContractsEntries(root, recursive).flatMap(contractsDirSpecs);
}

// The single dir a freshly written spec should land in: the highest-precedence match, or
// null when the root has no contracts home yet. Exactly detectContractsDirs()[0] — the
// two can no longer disagree.
//
// DELIBERATELY DEPTH-1 EVEN IN RECURSIVE MODE. This is where /wiregraph-contracts writes
// its INFERRED draft, and inference is union-wide: clusterSeams sees every compartment in
// the graph at once, so the draft it produces spans the whole tree and belongs in the
// OUTERMOST contracts dir — which is exactly what a depth-1 scan finds (`<root>/contracts`),
// and, when there is none, the `<root>/contracts` that `apply` then creates. Making this
// recursive would let it pick an INNER dir whose scope covers only one subtree, and the
// half of every seam that lands outside that subtree would silently stop matching.
export function contractsHome(root) {
  return detectContractsDirs(root)[0] || null;
}
