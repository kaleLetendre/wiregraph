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
import { findGitRepos } from '../../src/extract/walk.js';
import { langForFile } from '../../src/extract/lang.js';
import { memberRoots } from './state.mjs';

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

// The git repos under a SINGLE root (this graph's own tree, or one member).
function reposUnder(root) {
  return findGitRepos(root).map((r) => ({ name: r.name, root: r.dir, head: headSha(r.dir) }));
}

// Only THIS graph's own-tree repos (not linked members). Used to scope the
// once-per-process upstream-divergence banner to the home root, so a member repo
// parked on an old branch doesn't spam a caveat about a tree you didn't ask about.
export function ownRepos(project) {
  return reposUnder(project);
}

// Returns the project's repos across the WHOLE union — its own tree plus every
// linked member — as [{ name, root, head }] (root is the key). memberRoots dedups
// realpaths and drops vanished members, and repos are deduped by root so an
// overlapping/symlinked member can't double-count a checkout. Member-aware so the
// SessionStart catch-up and staleness probes see changes in linked members too.
export function projectRepos(project) {
  const seen = new Set();
  const out = [];
  for (const root of memberRoots(project)) {
    for (const repo of reposUnder(root)) {
      if (seen.has(repo.root)) continue;
      seen.add(repo.root);
      out.push(repo);
    }
  }
  return out;
}

// Compute the source files that changed since reposLastSha across every repo,
// plus the current HEAD per repo. Combines committed diff (lastSha..HEAD) with
// uncommitted working-tree changes (git status --porcelain). Returns absolute
// paths so build.js --files resolves them unambiguously.
//   { files: [abs...], newShas: { root: head }, repos: [{name,root,head}],
//     fullBuildNeeded: bool, fullBuildReasons: [str...] }
//
// fullBuildNeeded signals that an INCREMENTAL apply would silently miss code, so
// an auto-catch-up caller must escalate to a full rebuild instead of trusting
// `files`/`newShas`. Two conditions trip it:
//   - NEW REPO (no reposLastSha entry): its committed history was never diffed, so
//     an incremental apply indexes nothing yet the sha jumps to HEAD — after which
//     last === HEAD forever and the code is never picked up.
//   - INVALID BASELINE: the stored sha is no longer a reachable revision (e.g. gc'd
//     after an amend/rebase), so `git diff last..HEAD` FAILS (git() returns null,
//     distinct from "" for a valid-but-empty diff). Advancing past a failed range
//     would permanently drop the last..HEAD commits.
export function changedSince(project, reposLastSha = {}) {
  const repos = projectRepos(project);
  const files = new Set();
  const newShas = {};
  const fullBuildReasons = [];

  for (const repo of repos) {
    if (repo.head) newShas[repo.root] = repo.head;
    const last = reposLastSha[repo.root];
    const rels = new Set();

    if (last === undefined && repo.head) {
      // New repo, never indexed by catch-up — escalate rather than index nothing.
      fullBuildReasons.push(`new repo: ${repo.name}`);
    } else if (last && repo.head && last !== repo.head) {
      // Call git ONCE and test === null: null is a failed revision range (the stored
      // baseline is gone), "" is a valid range with no changes. Only the former escalates.
      const diff = git(repo.root, ['diff', '--name-only', `${last}..${repo.head}`]);
      if (diff === null) fullBuildReasons.push(`invalid baseline: ${repo.name}`);
      else diff.split('\n').filter(Boolean).forEach((f) => rels.add(f));
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
      if (!langForFile(rel)) continue; // only source files wiregraph indexes
      files.add(join(repo.root, rel));
    }
  }

  return { files: [...files], newShas, repos, fullBuildNeeded: fullBuildReasons.length > 0, fullBuildReasons };
}

// Per-repo divergence from the configured upstream tracking branch.
//
// wiregraph indexes the WORKING TREE, so "fresh" only ever means "the index
// matches your checkout" — it has no view of the remote. A checkout parked on a
// branch far behind its upstream therefore looks perfectly fresh while serving
// stale code (the failure that burned a session reasoning over a branch 38
// commits behind origin/main). This is the missing signal: ahead/behind counts
// vs @{upstream}, surfaced as a caveat — never a gate.
//
// Compared against each repo's own @{upstream} (not a hard-coded origin/main) so
// forks and repos that legitimately track a non-default branch read correctly.
// Repos with no upstream configured or a detached HEAD are skipped (no baseline).
// One `git rev-list` per repo; read-only like the rest of this module.
// Returns [{ name, branch, upstream, ahead, behind }] for repos NOT in sync.
// With { homeOnly: true } it inspects only this graph's own tree, skipping linked
// members — the once-per-process read-tool banner uses that to avoid flagging a
// member checkout the user didn't ask about; graph_status reports the full union.
export function upstreamDivergence(project, { homeOnly = false } = {}) {
  const out = [];
  for (const repo of (homeOnly ? ownRepos(project) : projectRepos(project))) {
    const branch = git(repo.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const b = branch ? branch.trim() : null;
    if (!b || b === 'HEAD') continue; // detached HEAD / unknown → no branch baseline
    const up = git(repo.root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    const upstream = up ? up.trim() : null;
    if (!upstream) continue; // no tracking branch configured → nothing to compare against
    // `A...B --left-right --count` → "<left> <right>": left = commits in upstream
    // not in HEAD (behind), right = commits in HEAD not in upstream (ahead).
    const counts = git(repo.root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    if (!counts) continue;
    const [behind, ahead] = counts.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
    if (!behind && !ahead) continue; // in sync → no caveat needed
    out.push({ name: repo.name, branch: b, upstream, ahead, behind });
  }
  return out;
}
