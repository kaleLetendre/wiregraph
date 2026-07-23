#!/usr/bin/env node
// CLI behind /wiregraph-link, /wiregraph-unlink, /wiregraph-list — the SURFACE for
// including an external, code-disconnected directory (e.g. a terminal repo and the
// server repo it only talks to over HTTP) as a MEMBER of this graph, so cross-repo
// wire seams light up in trace_contract / path_between.
//
//   node scripts/lib/links.mjs list                      mutual member view
//   node scripts/lib/links.mjs preview <dir>             dry-run: what a link would change
//   node scripts/lib/links.mjs check-overlap <dir>       just run the link-time guard
//   node scripts/lib/links.mjs link <dir>                perform the link (post-confirm)
//   node scripts/lib/links.mjs unlink-preview <dir>      dry-run: what an unlink would change
//   node scripts/lib/links.mjs unlink <dir>              perform the unlink (post-confirm)
//
// LINKING IS MUTUAL: both graphs' state.json get reciprocal records (each doubles
// as the other's reverse index), and BOTH graphs are rebuilt over the union so the
// seam is queryable from either side. SELF (the near graph) is resolved from the
// cwd / CLAUDE_PROJECT_DIR via findIndexedRoot — the commands take only the far dir.
// Contracts are re-inferred to an out-of-source inferred/ dir and matched on the
// next rebuild (fullBuild only MATCHES on-disk specs — it never synthesizes), so
// link/unlink always END with a full rebuild, never an incremental.

import { existsSync, realpathSync, mkdirSync, writeFileSync, rmSync, accessSync, constants } from 'node:fs';
import { join, sep, resolve, isAbsolute } from 'node:path';
import {
  findIndexedRoot, readState, updateState, memberRoots, members, canLink,
  addLink, removeLink, findLink, stateFilePath, wiregraphDir, ensureGitignore,
  recordFormerLinks, formerLinks, forgetFormerLinks,
} from './state.mjs';
import { findCompartmentRoots, walkSources } from '../../src/extract/walk.js';
import { runBuild } from '../../src/build.js';
import { inferSeamsAcross, synthesizeAsyncApi } from '../../src/contracts/infer.js';
import { projectRepos } from './git.mjs';
import { connect } from '../../src/store/sqlite.js';

const INFERRED_SPEC = 'wiregraph-inferred.asyncapi.yaml';
const NOT_INDEXED = "This directory isn't indexed yet — run /wiregraph-init here first, then /wiregraph-link.";
const log = (m) => process.stdout.write(m + '\n');
const err = (m) => process.stderr.write(m + '\n');

function realpathish(p) { try { return realpathSync(p); } catch { return p; } }

// SELF — the indexed workspace root the command runs in (null if the cwd is under
// no indexed root). All three commands resolve it themselves; they take only the
// far dir to act on, matching contracts.mjs / remove.mjs.
export function resolveSelf(startDir) {
  const raw = startDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return findIndexedRoot(raw);
}

// A graph's own out-of-source dir for auto-inferred specs. NEVER the user's source
// tree — the synthesized draft lives beside the db, redundantly under each graph.
function inferredDir(project) { return join(wiregraphDir(project), 'inferred'); }
function inferredSpecPath(project) { return join(inferredDir(project), INFERRED_SPEC); }

function isWritable(dir) { try { accessSync(dir, constants.W_OK); return true; } catch { return false; } }

// Compartment rows (name + root dir) for a graph, read from its db. Empty if the
// graph has no db yet (never built).
function compartmentsOf(project) {
  const dbPath = join(wiregraphDir(project), 'graph.db');
  if (!existsSync(dbPath)) return [];
  let db;
  try { db = connect(dbPath, { readonly: true }); } catch { return []; }
  try { return db.prepare('SELECT name, root FROM compartments WHERE project=? ORDER BY name').all(project); }
  catch { return []; }
  finally { db.close(); }
}

// The compartment name-set a candidate root would contribute (own basename ∪ each
// detected boundary's basename), for the preview only.
function compartmentNamesOf(root) {
  const names = new Set([root.split(sep).filter(Boolean).pop()]);
  for (const c of findCompartmentRoots(root)) names.add(c.name);
  return [...names];
}

// --- two-phase infer-then-rebuild (§contract re-inference) ------------------
// Phase A: infer seams across the graph's union and write the draft AsyncAPI spec
// to the out-of-source inferred/ dir (fullBuild only MATCHES on-disk specs, so the
// spec must land BEFORE the rebuild). When the reduced union yields no seams — e.g.
// after an unlink drops the only peer of a seam — any stale inferred spec is
// removed so no contract/WIRE residue survives the rebuild. A hand-written spec in
// the user's own contracts/ dir is untouched (it lives elsewhere and matches too).
// Phase B: full --reset rebuild over the union, then reseed reposLastSha to the
// union's HEADs (the post-full-build baseline, matching refresh.mjs --full).
// `roots` (optional): the explicit union to infer + rebuild over. When omitted, the
// union is read from state (memberRoots). unlink passes a REDUCED set explicitly —
// the peer already dropped — so the rebuild sheds the seam even while the link records
// still exist (they are retracted only AFTER both rebuilds succeed). Passing opts.roots
// makes runBuild honor that exact set instead of re-reading state.
async function reinferAndRebuild(project, roots = null) {
  const union = roots || memberRoots(project);
  const seams = inferSeamsAcross(union);
  const spec = inferredSpecPath(project);
  if (seams.length) {
    mkdirSync(inferredDir(project), { recursive: true });
    writeFileSync(spec, synthesizeAsyncApi(seams));
  } else if (existsSync(spec)) {
    rmSync(spec, { force: true });
  }
  // With an explicit reduced union, tell the build this member loss is INTENTIONAL
  // (allowReducedUnion) so the member-losing-reset backstop — which reads state, where
  // the peer record still lives until both rebuilds succeed — doesn't refuse it.
  await runBuild({ target: project, project, reset: true, ...(roots ? { roots, allowReducedUnion: true } : {}) });
  const newShas = {};
  for (const r of projectRepos(project)) if (r.head) newShas[r.root] = r.head;
  updateState(project, { lastFullBuild: new Date().toISOString(), reposLastSha: newShas });
}

// --- link -------------------------------------------------------------------
// Dry-run: what a `link <dir>` would change on each side. Returns { ok, reason,
// lines, fatal } — fatal marks a stop that isn't a guard rejection (null SELF,
// missing target). Never mutates anything.
export function previewLink(self, targetArg) {
  if (!self) return { ok: false, fatal: true, reason: NOT_INDEXED, lines: [] };
  const target = realpathish(targetArg);
  if (!existsSync(target)) {
    // Show the ABSOLUTE resolved path — a bare/relative arg resolves against the cwd,
    // which is exactly the "IM30 → cwd/IM30" footgun; the absolute form makes it obvious.
    const shown = isAbsolute(targetArg) ? target : resolve(process.cwd(), targetArg);
    return { ok: false, fatal: true, reason: `target directory does not exist: ${shown} (a relative path resolves against the current directory)`, lines: [] };
  }
  if (target === self) return { ok: false, fatal: true, reason: 'cannot link a graph to itself', lines: [] };

  const already = findLink(self, target);
  const guard = already ? { ok: true } : canLink(readState(self), target);
  const preexisting = existsSync(stateFilePath(target));
  const writable = isWritable(target);

  const lines = [`Link preview:  ${self}  ⟷  ${target}`, ''];
  if (!guard.ok) {
    lines.push(`REJECTED: ${guard.reason}`);
    return { ok: false, reason: guard.reason, lines, target, self };
  }
  const selfComps = compartmentsOf(self).length;
  lines.push(`${self}  (this graph):`);
  lines.push(`  + 1 linked member: ${target}`);
  lines.push(`  full rebuild over the union (${selfComps || '?'} existing compartment(s) + the member's)`);
  lines.push('');
  lines.push(`${target}  (a SECOND, unrelated repo — WILL BE WRITTEN TO):`);
  if (preexisting) {
    lines.push(`  + 1 linked member: ${self}`);
    lines.push('  full rebuild over the union');
  } else {
    let fileCount = 0;
    try { for (const _ of walkSources(target)) fileCount++; } catch { /* unreadable — leave 0 */ }
    lines.push(`  CREATE ${join(target, '.wiregraph')}/ (auto-initialize a new graph) + edit its .gitignore`);
    lines.push(`  index ${fileCount} source file(s) across compartment(s): ${compartmentNamesOf(target).join(', ')}`);
  }
  lines.push('');
  lines.push('Then contracts are re-inferred across the union and BOTH graphs rebuilt.');
  if (!writable) lines.push(`\n⚠ ${target} is not writable — the link cannot write the mirror record there.`);
  if (already) lines.push('\nNote: already linked — re-running will reconcile (idempotent), not double-link.');
  return { ok: writable, reason: writable ? null : `${target} is not writable`, lines, target, self, autoInit: !preexisting, already: !!already };
}

// Perform the link. Ordered so a re-run always reconciles (§link atomicity):
// guard → write SELF's record (durable auto-created intent) → auto-init the far
// graph if absent → write the mirror record → re-infer + rebuild each graph. An
// already-linked target skips the guard and just reconciles. `hooks.afterAutoInit`
// is a test-only injection point that fires in the auto-init→mirror crash window.
export async function doLink(self, targetArg, hooks = {}) {
  if (!self) throw new Error(NOT_INDEXED);
  const target = realpathish(targetArg);
  if (!existsSync(target)) throw new Error(`target directory does not exist: ${target}`);
  if (target === self) throw new Error('cannot link a graph to itself');

  const already = findLink(self, target);
  if (!already) {
    const c = canLink(readState(self), target);
    if (!c.ok) throw new Error(c.reason);
  }
  // preexisting is measured BEFORE any auto-init side effect — the ONLY moment we can
  // tell whether THIS link pair is about to conjure the peer graph. autoCreated is
  // stamped IDENTICALLY on both records; the created graph is the non-initiator side
  // (SELF, the initiator, always pre-exists). Unlink combines it with an initiator
  // comparison to know which side may be cleaned up. Preserve the prior value on a
  // reconcile so a crash-then-rerun doesn't lose it.
  const preexisting = existsSync(stateFilePath(target));
  const autoCreated = already ? already.autoCreated : !preexisting;
  const linkedAt = new Date().toISOString();

  // Write SELF's record FIRST — BEFORE auto-init — so the auto-created intent is
  // durable across a crash in the auto-init→mirror window. If this were deferred
  // until after auto-init (as the far graph's state.json already exists by then), a
  // crash before the mirror write would leave the peer on disk with NO record of who
  // created it; a re-run would see preexisting===true and wrongly compute
  // autoCreated=false, orphaning the conjured graph from a later unlink's cleanup.
  addLink(self, { root: target, peer: target, initiator: self, autoCreated, linkedAt });

  let gi = null;
  if (!preexisting) {
    // Auto-init the reverse graph (far side only — we never auto-init SELF). Build
    // it standalone first so a valid graph + state exists; the union rebuild below
    // then re-includes SELF.
    await runBuild({ target, project: target, reset: true });
    const newShas = {};
    for (const r of projectRepos(target)) if (r.head) newShas[r.root] = r.head;
    updateState(target, { lastFullBuild: new Date().toISOString(), reposLastSha: newShas });
    gi = ensureGitignore(target);
  }

  // Test-only: simulate a crash after auto-init, before the mirror record is written.
  if (hooks.afterAutoInit) await hooks.afterAutoInit();

  // Write the mirror record — the reverse index of record. initiator + autoCreated
  // are IDENTICAL to SELF's. A crash before this re-runs to convergence: SELF's
  // record is already present (carrying autoCreated), so the re-run reads it back.
  addLink(target, { root: self, peer: self, initiator: self, autoCreated, linkedAt });

  // Re-infer contracts to disk, then full-reset rebuild — for EACH graph.
  await reinferAndRebuild(self);
  await reinferAndRebuild(target);

  return { self, target, autoCreated, gitignore: gi };
}

// --- unlink -----------------------------------------------------------------
export function previewUnlink(self, targetArg) {
  if (!self) return { ok: false, fatal: true, reason: NOT_INDEXED, lines: [] };
  const target = realpathish(targetArg);
  const link = findLink(self, target);
  if (!link) return { ok: false, fatal: true, reason: `${target} is not a linked member of ${self}.`, lines: [] };
  const peerState = readState(target);
  const peerLinksLeft = peerState ? members(peerState).filter((l) => l.root !== self).length : 0;
  // Eligible only if the pair auto-created a graph AND the target is the side that
  // was created (the non-initiator) AND the peer would be left with no members.
  const targetWasCreated = !!link.autoCreated && link.initiator !== target;
  const cleanupEligible = targetWasCreated && peerLinksLeft === 0 && !!peerState;
  const lines = [`Unlink preview:  ${self}  ⟶  removes member ${target}`, ''];
  lines.push('Both graphs are rebuilt over the reduced union; the wire seam between them goes away.');
  lines.push(`  ${self}: drop the member, re-infer + full rebuild`);
  lines.push(`  ${target}: drop the mirror record, re-infer + full rebuild`);
  if (cleanupEligible) {
    lines.push('');
    lines.push(`${target} was AUTO-CREATED by the original link and would be left with no members —`);
    lines.push('you will be offered to fully remove that auto-created graph (folder, .gitignore, directive).');
  } else if (targetWasCreated && peerLinksLeft > 0) {
    lines.push(`\nNote: ${target} was auto-created but still has ${peerLinksLeft} other member(s) — it will be kept.`);
  }
  return { ok: true, lines, target, self, cleanupEligible };
}

// Perform the unlink: full-reset rebuild over the reduced union in BOTH graphs (NOT
// a surgical delete — name-scoped deletion is unsound under basename collision and
// leaves contract residue). Returns cleanupEligible so the command can offer to
// remove an auto-created, now-linkless peer via remove.mjs.
//
// Convergence (§link atomicity, mirroring doLink): the two rebuilds run over the
// REDUCED union (peer dropped) while the link records STILL EXIST — passing the
// reduced roots explicitly so state doesn't drag the peer back in — and the records
// are retracted ONLY after both rebuilds succeed. So a throw mid-rebuild leaves the
// records intact and a plain re-run reconciles: no notLinked no-op (the old
// remove-first order deleted the records before rebuilding, so a rebuild crash left a
// stale seam that a re-run could only mistake for "not linked"). `hooks.afterSelfRebuild`
// is a test-only injection point that fires in the crash window between the two rebuilds.
export async function doUnlink(self, targetArg, hooks = {}) {
  if (!self) throw new Error(NOT_INDEXED);
  const target = realpathish(targetArg);
  const selfLink = findLink(self, target);
  // The peer may still name us even when our own record is already gone (a prior
  // half-unlink). Detect that so this command RECONCILES a one-sided pair from either
  // side — a re-run from SELF must be able to repair a dangling peer record, not
  // early-return a no-op that only a peer-side unlink could fix.
  const peerHadLink = !!readState(target) && !!findLink(target, self);
  if (!selfLink && !peerHadLink) return { self, target, notLinked: true };

  // Cleanup eligibility comes from whichever record exists (both carry the identical
  // initiator/autoCreated). The peer is removable only if the pair auto-created a
  // graph AND target is the created (non-initiator) side — never the initiator graph.
  const rec = selfLink || findLink(target, self);
  const targetWasCreated = !!rec && !!rec.autoCreated && rec.initiator !== target;
  const peerState = readState(target);

  // Compute each graph's REDUCED union (the counterpart dropped) BEFORE touching any
  // record. inferSeamsAcross + the rebuild key off these, so the seam is shed even
  // though the still-present records name the peer.
  const selfReduced = memberRoots(self).filter((r) => r !== target);
  const targetReduced = peerState ? memberRoots(target).filter((r) => r !== self) : [];

  // Rebuild BOTH graphs over the reduced union while the records still exist — only
  // after both succeed do we retract the records, so a crash leaves a re-runnable
  // fully-linked pair (§convergence above).
  await reinferAndRebuild(self, selfReduced);
  if (hooks.afterSelfRebuild) await hooks.afterSelfRebuild();
  if (peerState) await reinferAndRebuild(target, targetReduced);

  // Both rebuilds converged. Retract the PEER's mirror FIRST, then SELF's. If the peer
  // write fails we ABORT with both records intact (both graphs already consistent over
  // the reduced union) — a coherent state a re-run from THIS side retries — rather than
  // leaving SELF dangling at a peer that no longer points back. removeLink is
  // idempotent, so a crash between the two removals also reconciles.
  let reverseFailed = false;
  if (readState(target) && findLink(target, self)) {
    try { removeLink(target, self); } catch { reverseFailed = true; }
  }
  if (reverseFailed) return { self, target, reverseFailed: true, aborted: true };
  if (findLink(self, target)) removeLink(self, target);

  // Tombstone the torn-down peer under SELF's root, so a later /wiregraph-init of self
  // (after a remove that deletes its .wiregraph) can offer to re-establish it. Keyed in
  // $HOME, so it survives the graph's deletion. Best-effort.
  recordFormerLinks(self, [target]);

  // After removal, is the (auto-created) peer left with no members?
  const peerStateAfter = readState(target);
  const cleanupEligible = targetWasCreated && !!peerStateAfter && members(peerStateAfter).length === 0;

  return { self, target, targetWasCreated, cleanupEligible, reverseFailed: false };
}

// --- list -------------------------------------------------------------------
// Mutual member view (§list) — reads BOTH states so it can show what graph_stats
// (single-graph) cannot: own root + compartments, each linked root grouped with
// its compartments, a per-link health flag (mutual vs one-sided), and a warning
// for any member dir that no longer exists.
export function listView(self) {
  if (!self) return NOT_INDEXED;
  const state = readState(self);
  if (!state) return NOT_INDEXED;

  const roots = memberRoots(self); // [own, ...members]
  const comps = compartmentsOf(self);
  const ownerRootFor = (compRoot) => {
    let best = null; // longest member root that is a prefix of compRoot
    for (const m of roots) if (compRoot === m || (compRoot && compRoot.startsWith(m + sep))) { if (!best || m.length > best.length) best = m; }
    return best || self;
  };
  const byRoot = new Map();
  for (const c of comps) {
    const g = ownerRootFor(c.root);
    if (!byRoot.has(g)) byRoot.set(g, []);
    byRoot.get(g).push(c.name);
  }
  const compLines = (root) => (byRoot.get(root) || []).map((n) => `    ${n}`);

  const lines = [`Graph: ${self}`, '', `Own root: ${self}`, ...compLines(self)];
  const mem = members(state);
  if (!mem.length) {
    lines.push('', 'No linked members. Add one with /wiregraph-link <dir>.');
    return lines.join('\n');
  }
  for (const l of mem) {
    const root = l.root;
    const exists = existsSync(root);
    const mutual = exists ? !!findLink(root, self) : false;
    const health = !exists ? '⚠ directory no longer exists' : (mutual ? 'mutual' : 'one-sided (repair by re-running /wiregraph-link)');
    lines.push('', `Linked: ${root}  [${health}]`);
    lines.push(...compLines(root));
  }
  return lines.join('\n');
}

// --- CLI --------------------------------------------------------------------
async function main(argv) {
  const [cmd, dirArg] = argv;
  const self = resolveSelf();

  if (cmd === 'list') { log(listView(self)); return; }

  // Tombstone read/clear — used by /wiregraph-init to offer re-establishing links a
  // prior remove/unlink tore down. `root` is the graph being (re)initialized; default
  // to the resolved self. former-links prints one peer root per line (empty = none).
  if (cmd === 'former-links' || cmd === 'forget-links') {
    const root = dirArg ? realpathish(resolve(dirArg)) : self;
    if (!root) { err(`${cmd}: no indexed graph here and no dir given`); process.exit(2); }
    if (cmd === 'forget-links') { forgetFormerLinks(root); return; }
    const peers = formerLinks(root).filter((p) => existsSync(p)); // skip peers now gone
    log(peers.join('\n'));
    return;
  }

  if (cmd === 'preview' || cmd === 'check-overlap') {
    if (!dirArg) { err(`usage: links.mjs ${cmd} <dir>`); process.exit(2); }
    const p = previewLink(self, dirArg);
    if (cmd === 'check-overlap') {
      log(p.ok ? 'OK: link is allowed.' : `REJECTED: ${p.reason}`);
      process.exit(p.ok ? 0 : 2);
    }
    // A "fatal" stop (missing target, self not indexed, self-link) carries its reason
    // in p.reason with EMPTY p.lines — surface it, or the caller gets a silent exit 2.
    log(p.fatal ? `REJECTED: ${p.reason}` : p.lines.join('\n'));
    process.exit(p.ok ? 0 : 2);
  }

  if (cmd === 'unlink-preview') {
    if (!dirArg) { err('usage: links.mjs unlink-preview <dir>'); process.exit(2); }
    const p = previewUnlink(self, dirArg);
    log(p.fatal ? p.reason : p.lines.join('\n'));
    process.exit(p.ok ? 0 : 2);
  }

  if (cmd === 'link') {
    if (!dirArg) { err('usage: links.mjs link <dir>'); process.exit(2); }
    const r = await doLink(self, dirArg);
    log(`Linked ${r.self}  ⟷  ${r.target}${r.autoCreated ? ' (auto-created the peer graph)' : ''}.`);
    if (r.autoCreated && r.gitignore === 'no-git') {
      log(`⚠ ${r.target} is not a git repo — its .wiregraph/graph.db is NOT gitignored (no .gitignore was written).`);
    }
    log('Both graphs rebuilt over the union. Confirm with graph_stats and trace_contract on the new seam.');
    return;
  }

  if (cmd === 'unlink') {
    if (!dirArg) { err('usage: links.mjs unlink <dir>'); process.exit(2); }
    const r = await doUnlink(self, dirArg);
    if (r.notLinked) { log(`${r.target} is not a linked member of ${r.self}.`); return; }
    if (r.aborted) {
      // The peer's mirror could not be removed (not writable?), so NOTHING was
      // unlinked — both graphs remain linked and consistent. Recovery is a re-run
      // from HERE once the peer is writable (reverse-first ordering means SELF never
      // ends up dangling), so point the user back to this same command.
      err(`⚠ could not update the peer graph at ${r.target} (is it writable?) — nothing was unlinked; both graphs are still linked. Re-run /wiregraph-unlink here once the peer is writable.`);
      process.exit(1);
    }
    log(`Unlinked ${r.target} from ${r.self}. Both graphs rebuilt over the reduced union.`);
    // The command parses this line to offer the auto-created-peer cleanup.
    if (r.cleanupEligible) log(`PEER_CLEANUP_ELIGIBLE: ${r.target}`);
    return;
  }

  err('usage: links.mjs <list|preview|check-overlap|unlink-preview|link|unlink> [dir]');
  process.exit(2);
}

const isCli = process.argv[1] && process.argv[1].endsWith('links.mjs');
if (isCli) main(process.argv.slice(2)).catch((e) => { err('link failed: ' + (e.message || e)); process.exit(1); });
