// Git helpers for incremental refresh: discover the project's repos, their
// current HEAD, and which source files changed since the last indexed sha
// (committed diff) plus any uncommitted edits. Used by update_graph and the
// SessionStart hook. Pure read-only git; never mutates a repo.
//
// reposLastSha is keyed by repo ROOT PATH, not repo name: a project may vendor the
// same submodule (e.g. a shared contracts repo) in several sister repos, so the
// basename is NOT unique — keying by name collapses them and makes a stored sha
// from one checkout get diffed against another's HEAD (a bogus revision range).
// Root paths are unique, so keying by root keeps each checkout's history straight.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { findRepoRoots } from '../../src/extract/walk.js';
import { langForFile } from '../../src/extract/lang.js';

// Raw git output — NOT trimmed. `git status --porcelain` encodes file state in
// the first two columns, so the leading status space is significant; a global
// trim() would strip the first line's leading space and corrupt its path parse.
// stderr is ignored: a failed probe (e.g. a stale sha that's no longer a valid
// revision) is expected and handled by the null return, not a printed "fatal:".
//
// `-c core.quotePath=false` makes git emit raw UTF-8 paths instead of octal-escaped,
// double-quoted ones for names with non-ASCII/special chars, so the `slice(3)` /
// ` -> ` porcelain parse below sees the real path (config flags precede the subcommand).
function git(repoRoot, args) {
  try {
    return execFileSync('git', ['-C', repoRoot, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

export function headSha(repoRoot) {
  const out = git(repoRoot, ['rev-parse', 'HEAD']);
  return out ? out.trim() : null;
}

// Returns the project's repos as [{ name, root, head }] (root is the key).
export function projectRepos(project) {
  return findRepoRoots(project).map((r) => ({ name: r.name, root: r.dir, head: headSha(r.dir) }));
}

// Compute the source files that changed since reposLastSha across every repo,
// plus the current HEAD per repo. Combines committed diff (lastSha..HEAD) with
// uncommitted working-tree changes (git status --porcelain). Returns absolute
// paths so build.js --files resolves them unambiguously.
//   { files: [abs...], newShas: { root: head }, repos: [{name,root,head}] }
export function changedSince(project, reposLastSha = {}) {
  const repos = projectRepos(project);
  const files = new Set();
  const newShas = {};

  for (const repo of repos) {
    if (repo.head) newShas[repo.root] = repo.head;
    const last = reposLastSha[repo.root];
    const rels = new Set();

    if (last && repo.head && last !== repo.head) {
      const diff = git(repo.root, ['diff', '--name-only', `${last}..${repo.head}`]);
      if (diff) diff.split('\n').filter(Boolean).forEach((f) => rels.add(f));
    }
    // Uncommitted changes (porcelain: "XY path" or rename "XY old -> new").
    const porcelain = git(repo.root, ['status', '--porcelain']);
    if (porcelain) {
      for (const line of porcelain.split('\n').filter(Boolean)) {
        const path = line.slice(3).split(' -> ').pop();
        if (path) rels.add(path);
      }
    }

    for (const rel of rels) {
      if (!langForFile(rel)) continue; // only source files codegraph indexes
      files.add(join(repo.root, rel));
    }
  }

  return { files: [...files], newShas, repos };
}
