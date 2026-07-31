// Walk a root directory: discover compartments (by .git or a module manifest)
// and yield source files tagged with the compartment they belong to and their
// language.

import { readdirSync, statSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { IGNORE_DIRS, langForFile } from './lang.js';

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

// Compartments (graph attribution): a boundary is a .git OR a module manifest.
function findCompartmentRoots(rootDir) {
  return findRoots(rootDir, isCompartmentBoundary);
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

export { findCompartmentRoots, compartmentNameFor, findGitRepos, isLinkedWorktree };
