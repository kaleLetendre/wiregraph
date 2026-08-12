// Walk a root directory: discover compartments (by .git or a module manifest)
// and yield source files tagged with the compartment they belong to and their
// language.

import { readdirSync, statSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, basename, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { IGNORE_DIRS, langForFile } from './lang.js';
import { validateDeclaration } from './compartment-decl.js';

// A COMPARTMENT is the unit code communicates ACROSS without a call edge (over
// HTTP, a queue, shared state, an import) — what a contract connects. A git repo
// is one boundary, but a single repo often holds several compartments (a monorepo
// of packages/services). So we detect a boundary from `.git` OR a module manifest,
// and attribute each file to its NEAREST such ancestor. This is why contracts fire
// inside a monorepo, not only across separately-cloned repos.
const MODULE_MANIFESTS = new Set(['go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts']);

// A LINKED WORKTREE (`git worktree add`) is an alternate checkout of a repo we may
// ALREADY be indexing. We skip one nested under the scan root for two reasons: (a) it
// holds a different branch's copy of the same code, so indexing it pollutes the graph
// with phantom, name-colliding duplicate symbols; (b) each nested worktree has no
// reposLastSha entry, so it's classified "new repo" and forces a spurious full rebuild
// on every `git worktree add`. Submodules stay (legitimately separate repos); the scan
// root itself stays (index-a-worktree-as-project must still work).
//
// Detection is AUTHORITATIVE, not a path-string heuristic: a linked worktree's OWN git
// dir (`--git-dir` → .../.git/worktrees/<name>) differs from its COMMON git dir
// (`--git-common-dir` → the main repo's .git), whereas a normal repo, a main worktree,
// and a SUBMODULE all have git-dir == common-dir. Asking git itself is immune to the
// traps a regex on the gitdir path falls into — a normal repo whose git dir legitimately
// lives under a directory named "worktrees" (e.g. `git init --separate-git-dir
// ~/worktrees/...`), a `--separate-git-dir` main repo, and Windows backslash paths. We
// only shell out for a dir whose `.git` is a FILE (a worktree or submodule); a normal
// repo has a `.git` DIRECTORY and returns false without a subprocess. If git can't
// classify the dir (not installed, not a repo) we return false — indexing a repo we
// weren't sure about is strictly safer than silently dropping it.
function isLinkedWorktree(dir) {
  const dotgit = join(dir, '.git');
  let st;
  try { st = statSync(dotgit); } catch { return false; }
  if (!st.isFile()) return false; // `.git` is a directory → normal repo / main worktree
  // --git-dir / --git-common-dir are ancient flags; both may print relative to `dir`
  // (we pass `-C dir`), so resolve against `dir` and realpath before comparing.
  const rp = (flag) => {
    let out;
    try { out = execFileSync('git', ['-C', dir, 'rev-parse', flag], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return null; }
    const v = out.trim();
    if (!v) return null;
    try { return realpathSync(resolve(dir, v)); } catch { return resolve(dir, v); }
  };
  const gitDir = rp('--git-dir');
  const commonDir = rp('--git-common-dir');
  if (!gitDir || !commonDir) return false; // git couldn't classify it → don't skip
  return gitDir !== commonDir;
}

function isCompartmentBoundary(dir, entries) {
  // A git repo is always a boundary.
  if (entries.some((e) => e.name === '.git')) return true;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (MODULE_MANIFESTS.has(e.name)) return true;
    // package.json counts only when it actually names a module or declares a
    // workspace — a bare config/tooling package.json must not fragment the tree.
    if (e.name === 'package.json') {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        if (pkg && (pkg.name || pkg.workspaces)) return true;
      } catch { /* unreadable/!JSON — not a boundary */ }
    }
  }
  return false;
}

// A file belongs to the *nearest* ancestor compartment boundary. Files under the
// root that sit in no sub-compartment are attributed to the root's name.
function compartmentNameFor(absPath, compartmentRoots, rootName, rootDir) {
  let best = null;
  for (const r of compartmentRoots) {
    if (absPath === r.dir || absPath.startsWith(r.dir + '/')) {
      if (!best || r.dir.length > best.dir.length) best = r;
    }
  }
  if (best) return { name: best.name, root: best.dir };
  return { name: rootName, root: rootDir };
}

// Generic recursive root finder: collect { dir, name } for every directory the
// predicate accepts, skipping ignored dirs.
function findRoots(rootDir, accept) {
  const roots = [];
  (function scan(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (accept(dir, entries)) roots.push({ dir, name: basename(dir) });
    for (const e of entries) {
      if (e.isDirectory() && !IGNORE_DIRS.has(e.name)) scan(join(dir, e.name));
    }
  })(rootDir);
  return roots;
}

// --- declared compartments (`recursive` mode) --------------------------------
// Opt-in per project: instead of INFERRING compartments from `.git` / a build
// manifest, a project DECLARES them in its own state.json:
//
//   { "mode": "recursive", "compartments": [ { "path": "server/ecs", "name": "ecs" } ] }
//
// `mode` absent (or anything other than 'recursive') and `compartments` null are
// BOTH the legacy signal — fall through to today's inference, unchanged. `[]` is
// meaningfully different from null: it declares "no sub-compartments", so every
// file attributes to the root.
//
// KEYED BY THE WALKED ROOT, NOT THE EDITING PROJECT. findCompartmentRoots receives
// only a root, and build.js's incremental attribution must match THAT member's own
// full build (a file under a linked member is indexed with the member's own
// boundaries). So the declaration is always read from the walked root's own state
// file — the editing project's state is irrelevant here.
function stateFileOf(rootDir) {
  const p = join(rootDir, '.wiregraph', 'state.json');
  if (existsSync(p)) return p;
  // Pre-rename footprint, adopted in place by scripts/lib/state.mjs#wiregraphDir.
  const legacy = join(rootDir, '.codegraph', 'state.json');
  if (existsSync(legacy)) return legacy;
  return null;
}

// The raw declaration a root carries, or null when it has none. Never throws — a
// hand-mangled state.json must degrade, not break a build.
//
// THREE STATES, and the difference between the second and the third is the whole point:
//   null                     — NOT DECLARED. No state file, unparseable, mode not
//                              'recursive', or `compartments` absent/null. Legacy: infer.
//   { compartments: [...] }  — declared. May still be UNUSABLE; resolveDeclaration
//                              decides, using the same rules `declare` enforces.
// A `compartments` value that is present but not an array (a hand edit, a merge
// resolution) is returned here as-is, NOT as null: the write path rejects it outright, so
// the read path must treat it as a broken declaration rather than as "never declared".
function readDeclaration(rootDir) {
  const p = stateFileOf(rootDir);
  if (!p) return null;
  let s;
  try { s = JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  if (!s || typeof s !== 'object') return null;
  if (s.mode !== 'recursive') return null;
  if (s.compartments === null || s.compartments === undefined) return null; // null = not declared
  return { mode: 'recursive', compartments: s.compartments };
}

// Warn ONCE per root per distinct problem set. findCompartmentRoots runs per root per
// build, per incremental update, per link guard and per status read, so an unguarded
// warning would bury the build log in duplicates.
const _warnedUnusable = new Map();
function warnUnusable(rootDir, errors) {
  const sig = errors.join('\n');
  if (_warnedUnusable.get(rootDir) === sig) return;
  _warnedUnusable.set(rootDir, sig);
  const lines = [
    `wiregraph: IGNORING the compartment declaration in ${rootDir} — it is PRESENT but UNUSABLE, so this root falls back to INFERRED compartments (.git / build manifests):`,
    ...errors.map((e) => `  - ${e}`),
    '  Until it is fixed, every id under this root is derived from the INFERRED partition, NOT the declared one. Re-declare (/wiregraph-init, or scripts/lib/compartments.mjs declare) and run a full rebuild.',
  ];
  try { process.stderr.write(lines.join('\n') + '\n'); } catch { /* a warning must never fail a build */ }
}

// What partition is ACTUALLY in force for `rootDir`. The single source of truth for the
// read path, the declaration fingerprint (scripts/lib/state.mjs) and the `Mode:` line, so
// none of the three can disagree about what the build is doing.
//
//   { state: 'none',     compartments: [], errors: [] }  → inference (legacy)
//   { state: 'declared', compartments: [{path,name}] }   → the declaration, honoured
//   { state: 'unusable', compartments: [], errors: [...] } → declaration present but
//        rejected by the SAME rules `declare` enforces (scripts/lib/compartments.mjs
//        shares this module). Falls back to inference, loudly.
//
// WHY UNUSABLE FALLS BACK RATHER THAN THROWING. Inference is a valid, self-consistent
// partition, and the fingerprint records the partition IN FORCE — so a broken declaration
// moves the fingerprint, which escalates the next catch-up to a full rebuild and makes
// every incremental refuse. The graph therefore ends up correct for the partition it
// actually used, never half-pruned under one partition and half-inserted under another.
// Throwing instead would take down `canLink`, the link preview, the init scope report and
// graph_status — every read-only diagnostic runs through this same funnel — turning a
// diagnosable misconfiguration into a total outage of the tools that would explain it.
//
// WHY IT IS ALL-OR-NOTHING. A declaration is a PARTITION. Honouring the entries that
// happen to parse and dropping the rest yields a DIFFERENT partition that no one chose:
// `["server/ecs","client/net"]` (an array of strings — the obvious-looking hand edit)
// used to produce a clean build with zero compartments and no warning.
function resolveDeclaration(rootDir) {
  const decl = readDeclaration(rootDir);
  if (!decl) return { state: 'none', compartments: [], errors: [] };
  const res = validateDeclaration(rootDir, decl.compartments);
  if (!res.ok) return { state: 'unusable', compartments: [], errors: res.errors };
  return { state: 'declared', compartments: res.compartments, errors: [] };
}

// The declared roots as the same `[{dir, name}]` shape inference returns, or null when
// this root is not running on a usable declaration (legacy, or broken → infer).
//
// SYMLINK HAZARD — the declared RELATIVE path is resolved LEXICALLY against rootDir
// (path.resolve), and MUST NOT be realpath'd. compartmentNameFor prefix-matches RAW
// ABSOLUTE STRINGS against the paths walkOneRoot builds by join()ing down from this
// same rootDir. If rootDir (or any ancestor) is reached through a symlink, a
// realpath here would yield a different string, EVERY prefix match would fail, and
// every file would silently fall through to the root compartment — a total partition
// collapse with no error and no count change. Resolving lexically keeps the declared
// dirs in exactly the same spelling the walk produces, whatever form rootDir is in.
// (validateDeclaration normalizes lexically for the same reason, and rejects a declared
// path that is reached through a symlink BELOW the root, which the walk could not
// descend into anyway.)
function declaredCompartmentRoots(rootDir) {
  const res = resolveDeclaration(rootDir);
  if (res.state === 'none') return null;
  if (res.state === 'unusable') { warnUnusable(rootDir, res.errors); return null; }
  return res.compartments.map((c) => ({ dir: resolve(rootDir, c.path), name: c.name }));
}

// --- inferred-partition basename collisions ----------------------------------
// A compartmentId is its NAME ALONE (src/model.js), so two compartments sharing a
// basename COLLAPSE into one row via INSERT OR REPLACE: whichever root landed last wins,
// every relPath computed against the OTHER root then resolves under it, and get_source
// reads the wrong file or ENOENTs. `validateDeclaration` guards this WITHIN a declaration
// and `canLink` guards it ACROSS linked members — NOTHING guarded the INFERRED partition,
// which is the one every global-mode project runs on and the one nobody writes by hand.
// `client/network` + `server/network` is a real, ordinary layout, and init's own scope
// report printed the duplicate without flagging it and then recommended Global mode.
//
// WHY DISAMBIGUATE RATHER THAN REFUSE. Refusing is hostile and unactionable: the user has
// not misconfigured anything — two directories in a repo are allowed to share a name, and
// the only "fix" a refusal could ask for is renaming source directories to suit the
// indexer. Dropping one compartment loses code silently, which is the bug. Keeping the
// merge is the bug. So the partition is made CORRECT (distinct names => distinct rows =>
// every file resolves against its own root) and the rename is made LOUD, because it is a
// graph-shape change: the names are what appear in trace output and what contract specs
// string-match on.
//
// The new name is the colliding dir's path RELATIVE TO THE WALKED ROOT — the exact
// spelling init's scope report already shows next to each duplicate (`network
// [client/network]`), so the loud message and the report agree. Only the COLLIDING entries
// are renamed: a partition with no duplicates comes back byte-identical, so no existing
// project's ids move. Names are assigned over a dir-SORTED copy so the outcome is
// deterministic regardless of readdir order, while the RETURNED order is left untouched.
// A relative path cannot equal a basename (it contains a separator whenever it differs),
// but the final uniquifying pass covers the degenerate leftovers anyway — a root that is
// itself a boundary keeps its basename, and a child literally named after it would
// otherwise collide a second time.
const _warnedCollision = new Map();
function warnNameCollision(rootDir, groups) {
  const sig = groups.map(([n, list]) => `${n}:${list.map((r) => r.name).join(',')}`).join('|');
  if (_warnedCollision.get(rootDir) === sig) return;
  _warnedCollision.set(rootDir, sig);
  const lines = [`wiregraph: ⚠ COMPARTMENT NAME COLLISION under ${rootDir} — the INFERRED partition put two or more compartments under the same name, so wiregraph RENAMED them to keep the graph correct:`];
  for (const [name, list] of groups) {
    lines.push(`  "${name}" was claimed by ${list.length} directories, now indexed as:`);
    for (const r of list) lines.push(`    - ${r.name}   [${r.dir}]`);
  }
  lines.push('  A compartment id is its NAME ALONE, so same-named compartments collapse into ONE row: one root wins, every file of the other resolves under it, and get_source reads the wrong path (or ENOENT). The names above are the compartment names now IN THE GRAPH.');
  lines.push('  Consequence to act on: any hand-written contract spec naming the bare basename in x-wiregraph-producers / x-wiregraph-consumers (or a resource writers:/readers: list) no longer matches and its seam goes dark. Update those specs to the names above, or declare compartments explicitly (/wiregraph-init, recursive mode) to choose your own.');
  try { process.stderr.write(lines.join('\n') + '\n'); } catch { /* a warning must never fail a build */ }
}

function disambiguateInferredNames(rootDir, roots) {
  const byName = new Map();
  for (const r of roots) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }
  if (![...byName.values()].some((l) => l.length > 1)) return roots;

  const sorted = [...roots].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  const used = new Set(roots.filter((r) => byName.get(r.name).length === 1).map((r) => r.name));
  const renamed = new Map(); // dir -> final name
  for (const r of sorted) {
    if (byName.get(r.name).length === 1) { renamed.set(r.dir, r.name); continue; }
    const rel = relative(rootDir, r.dir);
    const base = rel ? rel.split(sep).join('/') : r.name; // the root itself keeps its basename
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}#${i}`;
    used.add(name);
    renamed.set(r.dir, name);
  }
  const out = roots.map((r) => ({ dir: r.dir, name: renamed.get(r.dir) }));
  const groups = [...byName.entries()]
    .filter(([, l]) => l.length > 1)
    .map(([n, l]) => [n, l.map((r) => ({ dir: r.dir, name: renamed.get(r.dir) }))]);
  warnNameCollision(rootDir, groups);
  return out;
}

// Compartments (graph attribution): a boundary is a .git OR a module manifest —
// UNLESS this root declares its compartments explicitly (`recursive` mode) AND that
// declaration is usable, in which case the declaration wins outright. This function is
// the SINGLE funnel every consumer goes through (the build walk, incremental
// attribution, the link collision guard, the link preview, the init scope report), so
// returning the declared list here carries attribution, relPath, every id and every
// guard with it — and running the WRITE path's validation here is what stops the two
// from ever disagreeing about which partition that is.
function findCompartmentRoots(rootDir) {
  const declared = declaredCompartmentRoots(rootDir);
  if (declared) return declared; // a DECLARED partition already rejects duplicates at declare time
  return disambiguateInferredNames(rootDir, findRoots(rootDir, isCompartmentBoundary));
}

// GIT repos only (freshness / change-detection): git SHAs, upstream divergence,
// and reposLastSha are genuinely per-git-repo, NOT per-compartment — a package
// inside a repo has no HEAD of its own. So this is a distinct, .git-only scan.
function findGitRepos(rootDir) {
  return findRoots(rootDir, (dir, entries) => {
    if (!entries.some((e) => e.name === '.git')) return false;
    // A linked worktree nested under the root is an alternate checkout of a repo we
    // already cover — never a separate repo (avoids duplicate-branch pollution and the
    // "new repo" full-rebuild escalation). The root itself is kept even if it IS one.
    // Corollary: pointing init at a bare-repo CONTAINER whose only children are worktrees
    // (repo/{main,feature}/) yields an EMPTY graph — none of them is the scan root, so all
    // are skipped. That's intended: the old behavior indexed each as a separate repo and
    // collided their same-named symbols. Index one worktree (or the bare repo's main
    // checkout) directly, not the container.
    if (dir !== rootDir && isLinkedWorktree(dir)) return false;
    return true;
  });
}

// Walk one root, attributing files to compartments LOCAL to that root, and skip any
// file already yielded (shared `seen`, keyed by realpath) so overlapping or
// symlinked roots never double-yield.
function* walkOneRoot(rootDir, seen) {
  const rootName = basename(rootDir);
  const compartmentRoots = findCompartmentRoots(rootDir);

  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Skip a nested linked worktree wholesale — neither its files nor its subtree.
    // It's an alternate checkout of a repo we already index, so descending would
    // duplicate that repo's symbols under a phantom branch. Only read the `.git` file
    // when one is actually present (no stat-storm on ordinary dirs).
    if (dir !== rootDir && entries.some((e) => e.name === '.git' && e.isFile()) && isLinkedWorktree(dir)) continue;
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) stack.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const lang = langForFile(e.name);
      if (!lang) continue;
      // Dedup on the resolved real path so the same file reached via two roots (one
      // a symlink to / an ancestor of the other) is yielded exactly once.
      let real;
      try { real = realpathSync(abs); } catch { real = abs; }
      if (seen.has(real)) continue;
      seen.add(real);
      const { name: compartment, root: compartmentRoot } = compartmentNameFor(abs, compartmentRoots, rootName, rootDir);
      yield {
        abs,
        compartment,
        compartmentRoot,
        relPath: relative(compartmentRoot, abs),
        lang: lang.lang,
        variant: lang.variant,
      };
    }
  }
}

// Yields { abs, compartment, compartmentRoot, relPath, lang, variant } across ONE
// root or a UNION of roots. A string is treated as a single root (back-compat); an
// array walks each root in order with a shared dedup set so overlapping/symlinked
// members contribute each file once, while attribution stays local to each root.
export function* walkSources(roots) {
  const list = Array.isArray(roots) ? roots : [roots];
  const seen = new Set();
  for (const rootDir of list) yield* walkOneRoot(rootDir, seen);
}

export { findCompartmentRoots, compartmentNameFor, findGitRepos, isLinkedWorktree, readDeclaration, declaredCompartmentRoots, resolveDeclaration };
