#!/usr/bin/env node
// CLI behind /wiregraph-review — STAGE 1 (structural drift only).
//
//   node scripts/review.mjs [project] [--structure <path>] [--json] [--no-color]
//
// WHAT THIS IS FOR. The compartments/contracts architecture
// (`compartments-and-contracts.md`) costs almost nothing to design and a great deal to
// MAINTAIN: the tree, the whoami files, the contract index and the structure document all
// describe the same reality, and they drift apart silently. This script finds that drift
// DETERMINISTICALLY, so the agent running /wiregraph-review never spends a model call on a
// set comparison. Everything below is a set difference, a path predicate, or a filesystem
// stat. If a check needs judgement, it is NOT here — it is named in the DEFERRED list and
// pushed to a later stage.
//
// THE SEVEN DRIFT AXES, and which stage owns each:
//
//   A  declared compartments  <-> compartments on disk         STAGE 1  (here)
//   B  contract index         <-> contracts on disk            STAGE 1  (here)
//   C  manifest dep lists     <-> "must not know about"        stage 2 — needs the graph
//   D  actual cross-compartment edges <-> contracts            stage 2 — needs the graph
//   E  contract tokens        <-> code                         stage 3 — delegates to
//                                                              trace_contract; DO NOT
//                                                              reimplement token matching
//   F  contracts              <-> rules R1/R3/R4/R5/R6         STAGE 1  (here, partly)
//   G  structure doc index    <-> reality                      STAGE 1  (here)
//
// Stage 1 is the subset that works on a repo with ZERO indexed code, because that is the
// flagship's state today: eleven whoami files, four contracts dirs, one Cargo workspace,
// and not one line of Rust worth indexing. A review that needs the graph would have
// nothing to say there, and the documentation is exactly what needs reviewing before the
// code exists.
//
// WHO WINS WHEN TWO SOURCES DISAGREE. The spec settles this, so this script does not ask:
// `compartments-and-contracts.md` §11 — "Item 1 [the whoami files, which live with the
// code] lives with the code, and is the authority where the two disagree." So DISK BEATS
// THE STRUCTURE DOCUMENT for every axis here, and every stage-1 fix direction is
// `determined` — except one. The §05 misfiling diagnostic has two candidate causes (the
// contract is misfiled, or a boundary is leaking) and telling them apart requires knowing
// whether code actually reaches across, which is the graph, which is stage 2. That one
// reports `ask` and NAMES BOTH DIAGNOSES rather than guessing between them.
//
// NOTHING HERE READS A whoami.md. It is prose for humans — §03 says so explicitly, and a
// schema for it was considered and rejected. This script uses only the EXISTENCE of
// `whoami.md` as the on-disk marker of a compartment (a `statSync`, never a read), because
// on a repo with no code it is the only such marker there is: `client/rendering/` has no
// manifest, no source file and no graph node, and it is still a compartment. Existence is
// a filesystem fact; the file's contents remain unparsed. See OPEN QUESTIONS at the bottom.
//
// DELIBERATE DRIFT SURVIVES A RE-RUN, WITHOUT A FOURTH ARTIFACT. There is no ignore file
// and there will not be one — a fourth artifact would drift like the other three. The
// exception is recorded where the reader already looks: an unwritten contract is
// "accounted for" when the contracts dir's own README names it (spec §08: "A `contracts/`
// directory that is deliberately empty, with a note saying which level of work will
// populate it, is a correct state"), and a role side is accounted for when the index row
// marks it as a role (R2). Accounted-for items are REPORTED but are not drift and do not
// count toward the verdict.
//
// AGGREGATION IS A DESIGN CONSTRAINT, NOT A FORMATTING CHOICE. Each check emits AT MOST
// ONE finding, carrying a list of items. Forty findings would have moved the maintenance
// cost rather than removed it.

import { readdirSync, readFileSync, statSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname, basename, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readState, findIndexedRoot } from './lib/state.mjs';
import { colorEnabled } from './lib/color.mjs';
import { resolveDeclaration } from '../src/extract/walk.js';
import { isContractsDirName, rootContractsEntries } from '../src/contracts-dirs.js';
import { IGNORE_DIRS } from '../src/extract/lang.js';

// --- the finding record ------------------------------------------------------
// severity: 'drift'  — a real disagreement, and the fix direction is settled
//           'ask'    — a real disagreement whose fix direction genuinely has two
//                      legitimate answers; the agent must ask the user
//           'note'   — informational, or drift that has been deliberately accounted for
// fix:      'determined' | 'ask' | 'none'
function finding(o) {
  return { axis: o.axis, code: o.code, severity: o.severity, fix: o.fix, title: o.title,
    direction: o.direction || null, items: o.items || [], detail: o.detail || null };
}

// --- filesystem: compartments ------------------------------------------------
// A compartment on disk = a directory holding `whoami.md`. Contracts dirs are excluded by
// name (spec §03: "Which directories get one: every compartment. Not `contracts/`
// directories"), and the walk never descends into one, nor into an ignored dir, nor into
// anything hidden. Compartments NEST (§01), so a compartment IS descended into.
function findCompartmentsOnDisk(root) {
  const out = [];
  (function scan(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (isContractsDirName(e.name)) continue;
      if (existsSync(join(full, 'whoami.md'))) out.push(full);
      scan(full);
    }
  })(root);
  return out;
}

// --- filesystem: contracts ---------------------------------------------------
// A contract DOCUMENT is any file in a contracts dir that is not the dir's own note. The
// spec's contracts are markdown prose (§09); wiregraph's are AsyncAPI / resource YAML.
// Both count — this axis asks "is there a document here", not "can the indexer parse it".
const NOTE_RE = /^readme\.md$/i;
const CONTRACT_FILE_RE = /\.(md|markdown|ya?ml)$/i;

function contractsDirsOf(root) {
  // rootContractsEntries is the build's OWN answer to "which dirs, governing what subtree"
  // — reused rather than reimplemented so a dir this review reports on is a dir the build
  // would actually load. `recursive: true` because the architecture is recursive by
  // definition: every level has its own contracts dir (§05).
  return rootContractsEntries(root, true).map((e) => {
    let names = [];
    try { names = readdirSync(e.dir).sort(); } catch { /* unreadable */ }
    const docs = [], notes = [];
    for (const f of names) {
      if (!CONTRACT_FILE_RE.test(f)) continue;
      (NOTE_RE.test(f) ? notes : docs).push(join(e.dir, f));
    }
    // The build's `scopeRoot` is deliberately NOT carried through. It is null for the
    // root's own contracts dir, which is right for spec loading and wrong for R4/R5: the
    // level a contract GOVERNS is its dir's parent in every case, root included, and axis
    // F computes that from the index row's own path so it can check a contract that has
    // no file on disk yet.
    return { dir: e.dir, docs, notes };
  });
}

// --- the structure document --------------------------------------------------
// The one hand-written input, so its parse rules are narrow, stated, and REPORTED (the
// human report prints what was parsed, so a doc that silently parses to nothing is
// visible rather than reassuring).
//
//   contract index    — a markdown table whose header's first two cells begin
//                       "contract" and "between". col1's first `backticked` span is the
//                       contract's path from the root; col2's backticked spans are its
//                       sides; the word "role" outside the backticks marks R2 role sides.
//   compartment table — a markdown table whose header's first cell begins "compartment".
//                       col1's first backticked span names the compartment.
//   the tree          — the first fenced block with >= 3 lines whose first token ends in
//                       `/`. Indentation gives the parent; tokens after the first, up to
//                       the first `->`/`→`/`[`/`#`, are files that line ASSERTS exist.
function parseStructureDoc(text) {
  const lines = text.split(/\r?\n/);
  const out = { contracts: [], compartmentRows: [], tree: null, treeLine: null, tables: 0 };

  // --- fenced tree block
  let fence = null, buf = [], startLine = 0;
  for (let i = 0; i < lines.length && !out.tree; i++) {
    const l = lines[i];
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(l);
    if (m && fence === null) { fence = m[1][0].repeat(3); buf = []; startLine = i + 2; continue; }
    if (m && fence !== null) {
      const dirish = buf.filter((b) => /^\s*[A-Za-z0-9_.\-]+\/(\s|$)/.test(b)).length;
      if (dirish >= 3) { out.tree = parseTreeBlock(buf); out.treeLine = startLine; }
      fence = null;
      continue;
    }
    if (fence !== null) buf.push(l);
  }

  // --- markdown tables, each tagged with the nearest preceding heading
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    const h = /^#{1,6}\s+(.*)$/.exec(lines[i]);
    if (h) { heading = h[1]; continue; }
    if (!/^\s*\|/.test(lines[i])) continue;
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) continue;
    const header = cells(lines[i]).map((c) => c.trim().toLowerCase());
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) rows.push(cells(lines[j]));
    i = j - 1;
    out.tables++;
    if (header[0]?.startsWith('contract') && (header[1] || '').startsWith('between')) {
      for (const r of rows) {
        const path = ticks(r[0] || '')[0];
        if (!path) continue;
        const sides = parseSides(r[1] || '');
        const isRole = /\brole\b/i.test((r[1] || '').replace(/`[^`]*`/g, ''));
        out.contracts.push({ path: path.replace(/^\.?\//, ''), sides, isRole, heading });
      }
    } else if (header[0]?.startsWith('compartment')) {
      for (const r of rows) {
        const name = ticks(r[0] || '')[0];
        if (name) out.compartmentRows.push({ name: name.replace(/\/+$/, ''), heading });
      }
    }
  }
  return out;
}

function cells(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map((c) => c.trim());
}
function ticks(s) {
  return [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
}

// The two sides out of an index row's "Between" cell. Backticked spans when there are any
// — that is how the flagship writes four of its six rows. When there are none, fall back to
// splitting on the ↔ that every such row uses anyway: the flagship's `server-client` row
// reads `server ↔ client *(role)*`, unticked, and reading that as ZERO sides made the R1
// check fire on a perfectly correct two-sided contract. Emphasis and parentheticals are
// dropped, and a fragment that does not look like a path is dropped too, so a prose cell
// yields nothing rather than nonsense sides.
const SIDE_RE = /^[A-Za-z0-9_.\-/]+$/;
function parseSides(cell) {
  const t = ticks(cell);
  if (t.length) return t.map((s) => s.replace(/\/+$/, ''));
  return cell.replace(/\*+/g, '').replace(/\([^)]*\)/g, '')
    .split(/↔|<-+>|<—+>|←→/)
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s && SIDE_RE.test(s));
}

// The tree block, as { path, isDir, asserts[] } records. Indentation decides the parent —
// a stack, not a fixed step width, so a doc indenting by 2 or by 4 parses the same.
const TOKEN_RE = /^[A-Za-z0-9_.\-]+\/?$/;
function parseTreeBlock(lines) {
  const nodes = [];
  const stack = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    // Everything from the first annotation marker on is prose about the line, not paths.
    const body = raw.trim().split(/\s+/);
    const toks = [];
    for (const t of body) {
      if (t.startsWith('→') || t.startsWith('->') || t.startsWith('[') || t.startsWith('#') || t.startsWith('*')) break;
      toks.push(t);
    }
    if (!toks.length || !TOKEN_RE.test(toks[0])) continue;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].path : '';
    const name = toks[0].replace(/\/$/, '');
    const path = parent ? `${parent}/${name}` : name;
    const isDir = toks[0].endsWith('/');
    const asserts = isDir
      ? toks.slice(1).filter((t) => TOKEN_RE.test(t) && (t.includes('.') || t.endsWith('/')))
      : [];
    nodes.push({ path, isDir, asserts });
    if (isDir) stack.push({ indent, path });
  }
  return nodes;
}

// --- side resolution ---------------------------------------------------------
// A contract side is written the way a human writes it: `ecs/`, `sim`, `server`. Resolve
// it against the compartments that actually exist:
//   1. exact path from the root
//   2. a unique basename match
//   3. an AMBIGUOUS basename, disambiguated by the level the contract governs — this is
//      the flagship's `client/network` vs `server/network` collision, and the contract's
//      own directory settles it without a guess.
// Anything left over is `null`: either an R2 role, or a name that no longer exists.
function resolveSide(side, scopeRoot, root, compartments) {
  const rel = side.replace(/^\.?\//, '').replace(/\/+$/, '');
  const exact = compartments.find((c) => relative(root, c) === rel);
  if (exact) return exact;
  const byName = compartments.filter((c) => basename(c) === basename(rel));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const inScope = byName.filter((c) => dirname(c) === scopeRoot);
    if (inScope.length === 1) return inScope[0];
  }
  return null;
}

const isUnder = (child, parent) => child === parent || child.startsWith(parent + sep);

// --- the checks --------------------------------------------------------------
export function review(rootArg, opts = {}) {
  const root = rootArg;
  const findings = [];
  const compartments = findCompartmentsOnDisk(root);
  const relOf = (p) => relative(root, p) || '.';
  const cdirs = contractsDirsOf(root);

  // ---- axis A: declared compartments <-> compartments on disk ----------------
  // "Declared" is `.wiregraph/state.json`'s recursive-mode compartment list, read through
  // resolveDeclaration — the SAME funnel the build partitions on, so this reports the
  // partition actually in force rather than the text in the file.
  const decl = resolveDeclaration(root);
  const declaredDirs = decl.compartments.map((c) => resolve(root, c.path));
  if (decl.state === 'unusable') {
    findings.push(finding({
      axis: 'A', code: 'A3', severity: 'drift', fix: 'determined',
      title: 'The compartment declaration is present but UNUSABLE — the build is running on INFERRED compartments',
      direction: 'Fix the entries below, then run a full rebuild. Until then every compartment name in any graph answer is fiction.',
      items: decl.errors,
    }));
  }
  if (decl.state === 'declared') {
    const missing = declaredDirs.filter((d) => !compartments.includes(d)).map(relOf);
    const undeclared = compartments.filter((d) => !declaredDirs.includes(d)).map(relOf);
    if (missing.length) {
      findings.push(finding({
        axis: 'A', code: 'A1', severity: 'drift', fix: 'determined',
        title: 'Declared compartments that are not compartments on disk',
        direction: 'Disk wins (spec §11: the whoami files live with the code and are the authority). Drop these from the declaration, or restore the directory and its whoami.md.',
        items: missing,
      }));
    }
    if (undeclared.length) {
      findings.push(finding({
        axis: 'A', code: 'A2', severity: 'drift', fix: 'determined',
        title: 'Compartments on disk that the declaration does not name',
        direction: 'Disk wins. Add these to the declaration and run a full rebuild — until then their code attributes to the nearest declared ancestor and the boundary is invisible to every graph query.',
        items: undeclared,
      }));
    }
  } else {
    // Not declared at all. Axis A cannot run — say so rather than reporting "clean".
    const byName = new Map();
    for (const c of compartments) {
      const b = basename(c);
      byName.set(b, [...(byName.get(b) || []), relOf(c)]);
    }
    const collisions = [...byName.entries()].filter(([, v]) => v.length > 1)
      .map(([k, v]) => `${k}  →  ${v.join(', ')}`);
    findings.push(finding({
      axis: 'A', code: 'A0', severity: collisions.length ? 'drift' : 'note',
      fix: collisions.length ? 'determined' : 'none',
      title: compartments.length
        ? `Axis A cannot run: ${compartments.length} compartment(s) on disk, none declared to wiregraph`
        : 'Axis A cannot run: no compartments declared and none found on disk',
      direction: collisions.length
        ? 'Declare the compartments (/wiregraph-init, recursive mode). The names below collide by basename, and a compartment id is its NAME ALONE — undeclared, two of these collapse into one graph row and every hand-written spec naming the bare name matches the wrong side.'
        : 'Nothing to fix. Declaring compartments (/wiregraph-init, recursive mode) is what turns axis A on.',
      items: collisions.length ? collisions : compartments.map(relOf),
      detail: collisions.length ? 'basename collisions among compartments on disk' : null,
    }));
  }

  // ---- the structure document ------------------------------------------------
  const docPath = opts.structure || findStructureDoc(root);
  let doc = null;
  if (docPath && existsSync(docPath)) {
    doc = parseStructureDoc(readFileSync(docPath, 'utf8'));
  } else {
    findings.push(finding({
      axis: 'B', code: 'B0', severity: 'note', fix: 'none',
      title: 'Axes B, F and G cannot run: no structure document found',
      direction: 'The structure document is the contract INDEX (spec §11 items 2-5). Without it there is nothing to compare the tree against. Point at it with --structure <path>, or add project-structure.md at the root.',
    }));
  }

  const declaredContracts = doc ? doc.contracts : [];
  const onDisk = cdirs.flatMap((d) => d.docs);

  // ---- axis B: contract index <-> contracts on disk --------------------------
  if (doc) {
    const indexPaths = new Set(declaredContracts.map((c) => c.path));
    const missing = [], accounted = [];
    for (const c of declaredContracts) {
      const abs = join(root, c.path);
      if (existsSync(abs)) continue;
      // Accounted for? The contracts dir's own README naming this contract IS the note
      // §08 requires. Matched on the file's stem, which is how the flagship's READMEs
      // already name them ("`ecs-sim` — the six frozen ECS signatures").
      const dir = dirname(abs);
      const stem = basename(c.path).replace(/\.[^.]+$/, '');
      const entry = cdirs.find((d) => d.dir === dir);
      const noted = (entry?.notes || []).some((n) => {
        try { return readFileSync(n, 'utf8').includes(stem); } catch { return false; }
      });
      (noted ? accounted : missing).push(noted ? `${c.path}  (named in ${relOf(dirname(abs))}/README.md)` : c.path);
    }
    if (missing.length) {
      findings.push(finding({
        axis: 'B', code: 'B1', severity: 'drift', fix: 'determined',
        title: 'Contracts named in the index with no file on disk, and nothing recording the absence',
        direction: 'Either write the contract, or record the deliberate absence in that contracts dir\'s README (spec §08 — an empty contracts dir WITH a note is a correct state; without one it is indistinguishable from an oversight). Do NOT invent a contract to satisfy the index: §08 forbids writing a contract whose sides do not exist yet.',
        items: missing,
      }));
    }
    if (accounted.length) {
      findings.push(finding({
        axis: 'B', code: 'B2', severity: 'note', fix: 'none',
        title: 'Contracts named in the index, deliberately unwritten, and accounted for',
        direction: 'No action. The README naming the contract is the §08 note; this is how deliberate drift survives the next run without a fourth artifact.',
        items: accounted,
      }));
    }
    const unindexed = onDisk.filter((f) => !indexPaths.has(relOf(f))).map(relOf);
    if (unindexed.length) {
      findings.push(finding({
        axis: 'B', code: 'B3', severity: 'drift', fix: 'determined',
        title: 'Contracts on disk that the index does not list',
        direction: 'Disk wins. Add a row to the index — R3 makes the index the COMPLETE list of communication paths, and an unlisted contract makes every "this path does not exist" claim unverifiable.',
        items: unindexed,
      }));
    }
  }
  const silent = cdirs.filter((d) => !d.docs.length && !d.notes.length).map((d) => relOf(d.dir));
  if (silent.length) {
    findings.push(finding({
      axis: 'B', code: 'B4', severity: 'drift', fix: 'determined',
      title: 'Empty contracts dirs with no note',
      direction: 'Add a README saying which contracts belong there and which level of work will populate each (spec §08: "An empty directory with no note is indistinguishable from an oversight").',
      items: silent,
    }));
  }

  // ---- axis F: contracts <-> R1 / R4 / R5 (and the §05 diagnostic) ------------
  // Runs on the INDEX rows, not on the files, and that is deliberate: a contract's two
  // sides and its filed location are both stated in the index, so this check works on the
  // flagship today, where not one contract file exists yet. R1/R4/R5 are structural
  // properties of "which two names, filed where" — they do not need the document body.
  if (doc) {
    const r1 = [], r4 = [], r5 = [], unresolved = [], roles = [], unparsed = [];
    for (const c of declaredContracts) {
      const abs = join(root, c.path);
      const cdir = dirname(abs);
      const level = dirname(cdir); // the level a contract governs: its dir's parent (R4)
      // FEWER THAN TWO IS NOT REPORTED AS AN R1 VIOLATION. A row that yields zero or one
      // side is far likelier to be a row this parser could not read than a contract that
      // genuinely names one side, and calling a correct contract an R1 violation is the
      // kind of false finding that makes a review get ignored. Reported honestly, as a row
      // to fix, with both possibilities named. THREE OR MORE is unambiguous: no parse
      // failure invents an extra side.
      if (c.sides.length < 2) {
        unparsed.push(`${c.path}  →  the "Between" cell yielded ${c.sides.length} side(s)`
          + `${c.sides.length ? ` (${c.sides.join(', ')})` : ''} — either the row is malformed or the contract names one side`);
        continue;
      }
      if (c.sides.length > 2) {
        r1.push(`${c.path}  names ${c.sides.length} sides: ${c.sides.join(', ')}`);
        continue;
      }
      const resolved = c.sides.map((s) => resolveSide(s, level, root, compartments));
      if (resolved.some((r) => r === null)) {
        const bad = c.sides.filter((s, i) => resolved[i] === null);
        (c.isRole ? roles : unresolved).push(`${c.path}  →  ${bad.join(', ')}`);
        continue;
      }
      // R4 — a contract lives in the shared parent's contracts/, never inside either side.
      const insideASide = resolved.filter((r) => isUnder(cdir, r));
      if (insideASide.length) {
        r4.push(`${c.path}  is filed INSIDE ${relOf(insideASide[0])}, one of its own two sides`
          + `  →  move to ${relOf(commonParent(resolved))}/contracts/`);
        continue;
      }
      // R5 — a contract names only siblings. The §05 diagnostic lives here.
      const parents = resolved.map((r) => dirname(r));
      if (parents[0] === parents[1] && parents[0] !== level) {
        // Both sides ARE siblings, but the contract is filed at the wrong level. One
        // cause, one fix — no question to ask.
        r4.push(`${c.path}  names two siblings under ${relOf(parents[0])} but is filed at ${relOf(level)}`
          + `  →  move to ${relOf(parents[0])}/contracts/`);
      } else if (parents[0] !== parents[1]) {
        // The sides sit at different levels. THIS is spec §05, and it has exactly two
        // causes which this stage cannot tell apart: whether something inside one side
        // genuinely reaches into a child of the other is a fact about CODE, i.e. the
        // graph, i.e. stage 2. Both are named; neither is guessed.
        const depth = (p) => relative(root, p).split(sep).length;
        const [a, b] = resolved;
        const deeper = depth(a) > depth(b) ? a : b;
        const shallower = deeper === a ? b : a;
        r5.push({
          contract: c.path,
          sides: c.sides,
          detail: `${relOf(shallower)} (level ${depth(shallower)}) ↔ ${relOf(deeper)} (level ${depth(deeper)})`,
          misfiled: `the communication is really between ${relOf(shallower)} and ${relOf(dirname(deeper))}`
            + ` — rewrite the row to name ${basename(dirname(deeper))} as a whole, and file it in ${relOf(commonParent(resolved))}/contracts/`,
          leak: `${relOf(shallower)} genuinely reaches into ${relOf(deeper)} rather than talking to ${relOf(dirname(deeper))}`
            + ' — the contract is the symptom and the reach is the defect',
        });
      }
    }
    if (unparsed.length) {
      findings.push(finding({
        axis: 'F', code: 'F0', severity: 'drift', fix: 'determined',
        title: 'Contract index rows whose two sides could not be read',
        direction: 'Write the two sides as `backticked` names separated by ↔. Nothing downstream of this row could be checked — not R1, not R4, not R5.',
        items: unparsed,
      }));
    }
    if (r1.length) {
      findings.push(finding({
        axis: 'F', code: 'F1', severity: 'drift', fix: 'determined',
        title: 'R1 violated — a contract names other than exactly two sides',
        direction: 'A document describing three sides is architecture, not a contract (§04 R1); it belongs in the design document. Usually it means a compartment is missing (§10).',
        items: r1,
      }));
    }
    if (r4.length) {
      findings.push(finding({
        axis: 'F', code: 'F2', severity: 'drift', fix: 'determined',
        title: 'R4 violated — a contract is not in its two sides\' shared parent',
        direction: 'Move the file. A contract owned by one of its own sides is that side\'s documentation of its neighbour, which is how one side ends up defining the terms (§04 R4, §10).',
        items: r4,
      }));
    }
    if (r5.length) {
      findings.push(finding({
        axis: 'F', code: 'F3', severity: 'ask', fix: 'ask',
        title: 'R5 / §05 — a contract names compartments at different levels',
        direction: 'ASK. Per §05 exactly one of two things is wrong, and telling them apart needs to know whether code actually reaches across — which is the graph, which is stage 2. Both diagnoses are stated per contract below; put the choice to the user.',
        items: r5.map((r) => `${r.contract}  [${r.detail}]\n      MISFILED: ${r.misfiled}\n      LEAKING:  ${r.leak}`),
        detail: 'A misfiled contract reads as perfectly reasonable — it describes a real interaction — and the only signal that it is wrong is that its two sides live at different depths (§05).',
      }));
    }
    if (unresolved.length) {
      findings.push(finding({
        axis: 'F', code: 'F4', severity: 'drift', fix: 'determined',
        title: 'Contract sides that name no compartment on disk, and are not marked as roles',
        direction: 'Disk wins. Either the name is stale (fix the index row) or the side is a ROLE implemented by several compartments, in which case mark it as one — R2 says a role-named contract is correct and there must be exactly one of it.',
        items: unresolved,
      }));
    }
    if (roles.length) {
      findings.push(finding({
        axis: 'F', code: 'F5', severity: 'note', fix: 'none',
        title: 'Contract sides that are roles, not directories (R2)',
        direction: 'No action. R2: where several compartments implement the same side, the contract names roles.',
        items: roles,
      }));
    }
  }

  // ---- axis G: structure doc <-> reality --------------------------------------
  if (doc) {
    if (!doc.tree) {
      findings.push(finding({
        axis: 'G', code: 'G0', severity: 'note', fix: 'none',
        title: 'No tree block found in the structure document — the tree half of axis G is skipped',
        direction: 'Spec §11 item 2 asks for the tree. A fenced block whose lines are `name/` with indentation is what this reads.',
      }));
    } else {
      const absent = [], badAsserts = [];
      for (const n of doc.tree) {
        const abs = join(root, n.path);
        let st = null;
        try { st = statSync(abs); } catch { /* absent */ }
        if (!st || (n.isDir && !st.isDirectory())) { absent.push(n.path + (n.isDir ? '/' : '')); continue; }
        for (const a of n.asserts) {
          const child = join(abs, a.replace(/\/$/, ''));
          if (!existsSync(child)) badAsserts.push(`${n.path}/${a}`);
        }
      }
      if (absent.length) {
        findings.push(finding({
          axis: 'G', code: 'G1', severity: 'drift', fix: 'determined',
          title: 'The structure document\'s tree names paths that do not exist',
          direction: 'Disk wins (§11). Update the tree block, or create what it promises.',
          items: absent,
        }));
      }
      if (badAsserts.length) {
        findings.push(finding({
          axis: 'G', code: 'G2', severity: 'drift', fix: 'determined',
          title: 'The tree annotates directories with files that are not there',
          direction: 'Disk wins. Either the file was never written (a compartment with no whoami is the §10 failure mode) or the annotation is stale.',
          items: badAsserts,
        }));
      }
      const named = new Set(doc.tree.map((n) => n.path));
      const unnamedComp = compartments.map(relOf).filter((p) => !named.has(p));
      const unnamedDirs = cdirs.map((d) => relOf(d.dir)).filter((p) => !named.has(p) && p !== '.');
      if (unnamedComp.length || unnamedDirs.length) {
        findings.push(finding({
          axis: 'G', code: 'G3', severity: 'drift', fix: 'determined',
          title: 'Compartments / contracts dirs on disk that the tree does not name',
          direction: 'Disk wins. Add them to the tree block. A compartment absent from the structure document is one no reader of that document knows exists.',
          items: [...unnamedComp.map((p) => `${p}/  (compartment)`), ...unnamedDirs.map((p) => `${p}/  (contracts dir)`)],
        }));
      }
    }

    // Compartment TABLES (§03/§04 in the flagship). A row names a compartment by bare
    // name; the table's scope comes from its own heading when the heading names exactly
    // one compartment ("Server compartments" → server/). That is the only prose this
    // script reads, it reads it as a word-set intersection, and when it fails to resolve
    // the row is reported rather than guessed at.
    const unresolvedRows = [];
    for (const r of doc.compartmentRows) {
      const scope = headingScope(r.heading, root, compartments);
      const hit = resolveSide(r.name, scope, root, compartments);
      if (!hit) unresolvedRows.push(`${r.name}  (under "${r.heading}")`);
    }
    if (unresolvedRows.length) {
      findings.push(finding({
        axis: 'G', code: 'G4', severity: 'note', fix: 'determined',
        title: 'Compartment-table rows that do not resolve to one compartment on disk',
        direction: 'Qualify the row with its path, or fix the name. Reported as a NOTE because a human reading the section heading resolves these without difficulty — but a bare basename that exists twice in the tree is the exact shape that breaks a hand-written spec\'s producer/consumer list.',
        items: unresolvedRows,
      }));
    }
  }

  return {
    root,
    structureDoc: docPath && existsSync(docPath) ? docPath : null,
    stage: 1,
    compartments: compartments.map(relOf),
    contractsDirs: cdirs.map((d) => ({ dir: relOf(d.dir), docs: d.docs.map(relOf), notes: d.notes.map(relOf) })),
    declaration: { state: decl.state, count: decl.compartments.length },
    parsed: doc ? { indexRows: doc.contracts.length, compartmentRows: doc.compartmentRows.length, treeNodes: doc.tree ? doc.tree.length : 0 } : null,
    findings,
    counts: {
      drift: findings.filter((f) => f.severity === 'drift').length,
      ask: findings.filter((f) => f.severity === 'ask').length,
      note: findings.filter((f) => f.severity === 'note').length,
    },
  };
}

function commonParent(dirs) {
  let a = dirname(dirs[0]);
  while (!dirs.every((d) => isUnder(d, a))) {
    const up = dirname(a);
    if (up === a) return a;
    a = up;
  }
  return a;
}

// The scope a compartment TABLE governs, from its heading: the heading's words, intersected
// with the compartment basenames on disk. Exactly one match wins; zero or several means no
// scope, and resolveSide falls back to a plain basename match.
function headingScope(heading, root, compartments) {
  const words = new Set(String(heading).toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));
  const hits = compartments.filter((c) => words.has(basename(c).toLowerCase()));
  return hits.length === 1 ? hits[0] : null;
}

function findStructureDoc(root) {
  const preferred = join(root, 'project-structure.md');
  if (existsSync(preferred)) return preferred;
  let names = [];
  try { names = readdirSync(root).sort(); } catch { return null; }
  const hit = names.find((f) => /structure.*\.md$/i.test(f));
  return hit ? join(root, hit) : null;
}

// --- what stage 1 does NOT check ---------------------------------------------
// Printed on every run. A review whose silence is indistinguishable from a clean bill of
// health is worse than no review: the reader must be able to tell "checked and clean" from
// "not checked".
const DEFERRED = [
  ['C', 'stage 2', 'Manifest dependency lists vs. each compartment\'s "must not know about" — the machine side is Cargo.toml / package.json, and the intent side is prose a human reads in the whoami. Needs the manifests parsed and the graph built.'],
  ['D', 'stage 2', 'Actual cross-compartment edges vs. the contract index. This is the check that makes R3 ("if two compartments do not communicate, there is no file") verifiable in both directions, including two compartments with edges and NO contract. Needs Rust indexing shipped.'],
  ['E', 'stage 3', 'Contract tokens vs. code — delegates to the existing trace_contract MCP tool. Not reimplemented here, ever.'],
  ['F/R6', 'stage 2', 'R6 (direction is one-way where it can be) is NOT checked. The index states two sides, not a direction; the direction lives in the contract body\'s prose and in the actual dependency edges.'],
  ['F/R3', 'stage 2', 'R3 in reverse — two compartments with graph edges but no contract between them. Needs the graph.'],
  ['whoami prose', 'stage 4', 'Whether a whoami says one job without "and", names a denied list, and does not restate its contracts (§10). Judgement, not a set difference — a model call, deliberately kept out of stage 1.'],
  ['direction + apply', 'stage 5', 'Interactive fix direction and applying the fix. Stage 1 reports.'],
];

// --- output ------------------------------------------------------------------
function render(res, color) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const L = [];
  L.push(c('1', `wiregraph review — STAGE 1 (structural drift only)`));
  L.push(`project: ${res.root}`);
  L.push(`structure document: ${res.structureDoc || '(none found)'}`);
  L.push(`compartments on disk: ${res.compartments.length}${res.compartments.length ? ` — ${res.compartments.join(', ')}` : ''}`);
  L.push(`contracts dirs: ${res.contractsDirs.length}${res.contractsDirs.length ? ` — ${res.contractsDirs.map((d) => `${d.dir} (${d.docs.length} contract(s), ${d.notes.length} note(s))`).join('; ')}` : ''}`);
  L.push(`declaration: ${res.declaration.state}${res.declaration.state === 'declared' ? ` (${res.declaration.count})` : ''}`);
  if (res.parsed) {
    L.push(`parsed from the structure document: ${res.parsed.indexRows} index row(s), `
      + `${res.parsed.compartmentRows} compartment row(s), ${res.parsed.treeNodes} tree node(s)`);
  }
  L.push('');

  const order = { drift: 0, ask: 1, note: 2 };
  const sorted = [...res.findings].sort((a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code));
  if (!sorted.length) L.push('No findings.');
  for (const f of sorted) {
    const tag = f.severity === 'drift' ? c('31', 'DRIFT') : f.severity === 'ask' ? c('33', 'ASK  ') : c('36', 'note ');
    L.push(`${tag} [${f.code} · axis ${f.axis}] ${f.title}`);
    for (const it of f.items) L.push(`    - ${it}`);
    if (f.detail) L.push(`    ${f.detail}`);
    if (f.direction) L.push(`    → ${f.direction}`);
    L.push('');
  }

  L.push(c('1', `VERDICT: ${res.counts.drift} drift, ${res.counts.ask} to ask, ${res.counts.note} note(s).`));
  L.push('');
  L.push('NOT CHECKED AT STAGE 1:');
  for (const [axis, stage, why] of DEFERRED) L.push(`  ${axis} (${stage}) — ${why}`);
  return L.join('\n') + '\n';
}

function usage() {
  process.stderr.write('usage: review.mjs [project] [--structure <path>] [--json] [--no-color]\n');
  process.exit(2);
}

function main(argv) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = [];
  let structure = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--structure') { structure = argv[++i]; continue; }
    if (argv[i].startsWith('--')) continue;
    positional.push(argv[i]);
  }
  if (positional.length > 1) usage();
  const raw = positional[0] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let root;
  try { root = realpathSync(raw); } catch { root = raw; }
  // Work from a subdirectory of an indexed workspace, like scripts/contracts.mjs does —
  // but ONLY when this project has no state of its own, so an UNINDEXED project (the
  // flagship, today) is reviewed where it stands rather than silently hoisted to an
  // indexed ancestor.
  if (!readState(root)) {
    const indexed = findIndexedRoot(root);
    if (indexed) root = indexed;
  }
  const res = review(root, { structure: structure ? resolve(structure) : null });
  if (flags.includes('--json')) { process.stdout.write(JSON.stringify(res, null, 2) + '\n'); return; }
  process.stdout.write(render(res, colorEnabled(flags.includes('--no-color'))));
}

// EXIT CODE IS ALWAYS 0 ON A SUCCESSFUL RUN, drift or not. The caller is an agent
// following commands/wiregraph-review.md; a non-zero exit there reads as "the script
// broke" and derails the command into debugging itself. The verdict is in the text and in
// `counts` for anyone scripting it.
//
// The entry test compares the RESOLVED URL, not `argv[1].endsWith('review.mjs')` — the
// idiom the older scripts here use. `test/review.mjs` imports `review()` from this file
// and is itself named review.mjs, so the endsWith form made every test run print a full
// report for the wiregraph repo before the first assertion.
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) main(process.argv.slice(2));

// --- OPEN QUESTIONS (stage 1) -------------------------------------------------
// 1. COMPARTMENT DETECTION USES whoami.md EXISTENCE. The brief says nothing parses the
//    whoami and every deterministic check reads manifests and the graph. On a repo with no
//    code neither exists, and `client/rendering/` is still a compartment — the only
//    on-disk evidence is the file's presence. This script stats it and never opens it. If
//    that is still too close to the line, the alternative is that axis A/G are unavailable
//    until the code lands, which removes the review from the exact window where the
//    documentation is all there is.
// 2. THE CONTRACT INDEX IS PARSED FROM MARKDOWN. That makes the structure document a
//    machine-read artifact, which cuts against "the structure document is prose". The
//    parse is narrow and reported, so a doc that does not match degrades to "0 index rows"
//    visibly rather than silently.
