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
import { memberRoots, readState, compartmentsFingerprint, compartmentsDrift, contractsFingerprint, contractsDrift } from './state.mjs';

// Raw git output — NOT trimmed. `git status --porcelain` encodes file state in
// the first two columns, so the leading status space is significant; a global
// trim() would strip the first line's leading space and corrupt its path parse.
// stderr is ignored: a failed probe (e.g. a stale sha that's no longer a valid
// revision) is expected and handled by the null return, not a printed "fatal:".
//
// `-c core.quotePath=false` makes git emit raw UTF-8 paths instead of octal-escaped,
// double-quoted ones for names with non-ASCII/special chars (config flags precede the
// subcommand). The parsers below additionally ask for `-z`, which suppresses quoting
// outright and delimits with NUL — belt and braces, and the only way to read a rename
// record without splitting on a ` -> ` that a filename is allowed to contain.
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
//     fullBuildNeeded: bool, fullBuildReasons: [str...],
//     invalidBaselineRepos: [{name,root,head}...] }
//
// fullBuildNeeded signals that an INCREMENTAL apply would silently miss code, so
// an auto-catch-up caller must escalate to a full rebuild instead of trusting
// `files`/`newShas`. It trips on a NEW REPO (no reposLastSha entry): its committed
// history was never diffed, so an incremental apply indexes nothing yet the sha jumps
// to HEAD — after which last === HEAD forever and the code is never picked up.
//
// INVALID BASELINE is surfaced SEPARATELY (invalidBaselineRepos), NOT as
// fullBuildNeeded: the stored sha is no longer a reachable revision (e.g. gc'd after an
// amend/rebase), so `git diff last..HEAD` FAILS (git() returns null, distinct from ""
// for a valid-but-empty diff) and the last..HEAD file list is unknowable. This used to
// force a whole-PROJECT teardown+rebuild — catastrophic on a big repo and recurring
// every rebase+gc cycle, even when a message-only `git commit --amend` never touched a
// single working-tree file. But the lost diff does NOT mean the code is unknowable: the
// working tree already reflects the new HEAD, and the store records each file's
// mtime+size, so the affected repo can be reconciled by CONTENT (reindex only files
// that actually differ, prune vanished ones) and restamped — leaving the rest of the
// graph intact. The caller (refresh.mjs) does that per-repo reconcile; here we merely
// name which repos need it. (If the caller can't establish a reliable content
// comparison it still falls back to a full rebuild — safety over cleverness.)
export function changedSince(project, reposLastSha = {}) {
  const repos = projectRepos(project);
  const files = new Set();
  const newShas = {};
  const fullBuildReasons = [];
  const invalidBaselineRepos = [];

  for (const repo of repos) {
    if (repo.head) newShas[repo.root] = repo.head;
    const last = reposLastSha[repo.root];
    const rels = new Set();

    if (last === undefined && repo.head) {
      // New repo, never indexed by catch-up — escalate rather than index nothing.
      fullBuildReasons.push(`new repo: ${repo.name}`);
    } else if (last && repo.head && last !== repo.head) {
      // Call git ONCE and test === null: null is a failed revision range (the stored
      // baseline is gone), "" is a valid range with no changes. A null diff no longer
      // escalates the WHOLE project — it flags THIS repo for a content-reconcile instead.
      //
      // BOTH SIDES OF A RENAME, and this is the whole reason for --name-status -z over the
      // older --name-only. `git diff` applies RENAME DETECTION by default (diff.renames is
      // on since git 2.9), so `a/one.js -> a/renamed.js` is reported as ONE record naming
      // only the NEW path. The OLD path then never reaches `files`, pruneFile is never
      // called for it, and its rows — file, every symbol, DEFINED_IN, IN_COMPARTMENT and
      // the CALLS between them — survive forever under a path that no longer exists:
      // find_symbol reports two matches and get_source ENOENTs on the ghost. It never
      // self-heals, because the sha advances and every later catch-up says "nothing
      // changed". A plain `git rm` prunes correctly; it is specifically rename detection
      // that loses the path. Feeding the old path in too makes it a normal deletion, which
      // the incremental already prunes.
      //
      // -z is NUL-delimited (no quoting, no ` -> ` to mis-split on a path that contains
      // it) and --name-status emits `R<score>\0<old>\0<new>` for a rename/copy and
      // `<status>\0<path>` for everything else. We add BOTH paths, so the old/new field
      // ORDER never has to be reasoned about — a set either contains the path or not.
      const diff = git(repo.root, ['diff', '--name-status', '-M', '-z', `${last}..${repo.head}`]);
      if (diff === null) invalidBaselineRepos.push(repo);
      else {
        const f = diff.split('\0');
        for (let i = 0; i < f.length; i++) {
          const status = f[i];
          if (!status) continue;
          const paths = (status[0] === 'R' || status[0] === 'C') ? 2 : 1; // rename/copy carry old AND new
          for (let k = 1; k <= paths; k++) if (f[i + k]) rels.add(f[i + k]);
          i += paths;
        }
      }
    }
    // Uncommitted changes. Same rename hazard, same remedy: a STAGED rename (`git mv`,
    // which is what a rename normally looks like before it is committed) is reported as a
    // single `R` record, and the pre-`-z` parse took `.pop()` of a ` -> ` split — again
    // keeping only the NEW path and leaking the old one's rows. (An UNSTAGED `mv` already
    // worked: git sees an unrelated ` D old` plus `?? new`.)
    //
    // Porcelain v1 -z: each record is `XY <path>` NUL-terminated, and a rename/copy adds
    // the ORIGINAL path as the NEXT NUL-separated field. Both go in.
    const porcelain = git(repo.root, ['status', '--porcelain', '-z']);
    if (porcelain) {
      const f = porcelain.split('\0');
      for (let i = 0; i < f.length; i++) {
        const rec = f[i];
        if (!rec || rec.length < 4) continue; // "XY p" is the shortest possible record
        rels.add(rec.slice(3));
        if (rec[0] === 'R' || rec[0] === 'C' || rec[1] === 'R' || rec[1] === 'C') {
          if (f[i + 1]) rels.add(f[i + 1]);
          i++;
        }
      }
    }

    for (const rel of rels) {
      if (!langForFile(rel)) continue; // only source files wiregraph indexes
      files.add(join(repo.root, rel));
    }
  }

  // COMPARTMENT PARTITION CHANGE — a second, non-git reason an incremental apply would
  // silently corrupt the graph. Compartment name is embedded in every id and relPath is
  // relative to the compartment root, so re-partitioning changes BOTH halves of every
  // affected id; pruneFile then deletes by the NEW `(project, compartment, file)` key,
  // misses the old rows, and the reload duplicates every symbol across two compartments.
  // Escalate to a full rebuild, which is safe by construction (it always resets).
  //
  // An ABSENT stamp means "no baseline", NEVER "outdated" — reading it as changed would
  // force a full rebuild of every project built before this key existed on its very next
  // catch-up, the same trap schemaOutdated() documents for its 0 stamp. THERE IS NO
  // GLOBAL-MODE EXEMPTION ANY MORE: the per-root value used to be the constant 'global'
  // for an inferred partition, so this branch could never fire on a project that declared
  // nothing; the fingerprint now hashes the boundary set inference actually resolves to,
  // so a manifest appearing in a subdirectory re-partitions a legacy project and escalates
  // here exactly as an edited declaration does. Hence the wording: the subject is the
  // PARTITION IN FORCE, declared or inferred, not a declaration that may not exist.
  // The comparison is PER ROOT and only over the roots mounted right now, so a
  // member that is transiently unmounted cannot forge a partition change out of a mount
  // blip — the same failure the reposLastSha merge above exists to prevent.
  //
  // It also fires for a declared source directory that was RENAMED or DELETED on disk,
  // not just for an edit to the declaration text: the fingerprint hashes the partition
  // the read path resolves to, and a vanished declared path makes that declaration
  // unusable (the build silently fell back to inference, so every id moved).
  const partitionDrift = compartmentsDrift(readState(project)?.compartmentsFingerprint, compartmentsFingerprint(project));
  if (partitionDrift) {
    fullBuildReasons.push(`the compartment partition changed since the last full build (${partitionDrift})`);
  }

  // CONTRACT SPEC SET CHANGE — a third, non-git reason. Contract SCOPE is applied when
  // REFERENCES are minted and stored nowhere, so an incremental re-derive over rows minted
  // under a different resolved `{spec, scopeRoot, digest}` set fabricates cross-scope WIRE
  // edges a full rebuild does not produce (moving a SPEC inward keeps the title and the
  // contract id while shrinking the scope, with no change to the dir set at all) and leaves
  // stale REFERENCES rows that trace_contract reports as real. Same escalation, same
  // absent-means-no-baseline rule, same per-root-over-mounted-roots comparison as the
  // partition check above.
  //
  // IT FIRES IN GLOBAL MODE TOO, and must. The earlier version hashed an all-unscoped set
  // to the literal 'global', so the default mode was exempt from the whole guard — and
  // global mode is where a deleted spec left a ghost contract with a live WIRE edge, and
  // where `/wiregraph-contracts apply` (contractsHome is deliberately depth-1, so `apply`
  // writes into a GLOBAL-mode contracts/) had a self-heal time of never. This is what
  // finally gives that sequence one: `apply` creates contracts/ and tells the user to run
  // the incremental, which now escalates to the full rebuild that indexes the new spec.
  const contractsSetDrift = contractsDrift(readState(project)?.contractsFingerprint, contractsFingerprint(project));
  if (contractsSetDrift) {
    fullBuildReasons.push(`contract specs changed since the last full build (${contractsSetDrift})`);
  }

  return { files: [...files], newShas, repos, fullBuildNeeded: fullBuildReasons.length > 0, fullBuildReasons, invalidBaselineRepos };
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
