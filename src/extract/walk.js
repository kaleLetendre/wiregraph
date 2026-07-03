// Walk a root directory: discover sub-repos (by .git) and yield source files
// tagged with the repo they belong to and their language.

import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { IGNORE_DIRS, langForFile } from './lang.js';

// A COMPARTMENT is the unit code communicates ACROSS without a call edge (over
// HTTP, a queue, shared state, an import) — what a contract connects. A git repo
// is one boundary, but a single repo often holds several compartments (a monorepo
// of packages/services). So we detect a boundary from `.git` OR a module manifest,
// and attribute each file to its NEAREST such ancestor. This is why contracts fire
// inside a monorepo, not only across separately-cloned repos.
const MODULE_MANIFESTS = new Set(['go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts']);

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

// A file belongs to the *nearest* ancestor directory that contains a .git.
// Files under the root that sit in no sub-repo are attributed to the root's name.
function repoNameFor(absPath, repoRoots, rootName, rootDir) {
  let best = null;
  for (const r of repoRoots) {
    if (absPath === r.dir || absPath.startsWith(r.dir + '/')) {
      if (!best || r.dir.length > best.dir.length) best = r;
    }
  }
  if (best) return { name: best.name, root: best.dir };
  return { name: rootName, root: rootDir };
}

function findRepoRoots(rootDir) {
  const roots = [];
  (function scan(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (isCompartmentBoundary(dir, entries)) {
      roots.push({ dir, name: basename(dir) });
    }
    for (const e of entries) {
      if (e.isDirectory() && !IGNORE_DIRS.has(e.name)) scan(join(dir, e.name));
    }
  })(rootDir);
  return roots;
}

// Yields { abs, repo, repoRoot, relPath, lang, variant }
export function* walkSources(rootDir) {
  const rootName = basename(rootDir);
  const repoRoots = findRepoRoots(rootDir);

  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) stack.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const lang = langForFile(e.name);
      if (!lang) continue;
      const { name: repo, root: repoRoot } = repoNameFor(abs, repoRoots, rootName, rootDir);
      yield {
        abs,
        repo,
        repoRoot,
        relPath: relative(repoRoot, abs),
        lang: lang.lang,
        variant: lang.variant,
      };
    }
  }
}

export { findRepoRoots, repoNameFor };
