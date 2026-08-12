// Per-project wiregraph footprint: a single hidden, gitignored folder
//   <project>/.wiregraph/
//     graph.db     — the embedded SQLite call/association graph for this project
//     state.json   — this state file
//     refresh.log  — background-refresh log
//
// Keeping everything under one dot-folder makes the footprint obvious, hidden in
// folder views, and trivial to gitignore (one line). /wiregraph-init creates it
// and adds it to the project's .gitignore. The state file drives incremental
// refresh (reposLastSha), the SessionStart catch-up, the auto-update posture, and
// the status doctor.

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, sep, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { findCompartmentRoots, resolveDeclaration } from '../../src/extract/walk.js';
import { IGNORE_DIRS } from '../../src/extract/lang.js';
import { rootContractsSpecs, contractsDirSpecs } from '../../src/contracts-dirs.js';

export const POSTURES = ['off', 'conservative', 'balanced', 'aggressive'];
export const GITIGNORE_LINE = '.wiregraph/';

// Version of the LOCAL usage-metrics layer (metrics.jsonl + this state's
// metricsVersion field) — NOT the SQLite graph SCHEMA_VERSION, a separate concern.
// Bumped when the meaning of the log changes such that pre-existing lines must not
// be mixed with new ones. v2 introduced turn/boundary tracking (measured recurring
// context); a project written by a version that predates it LACKS metricsVersion, so
// migrateMetrics (metrics.mjs) archives its pre-v2 log and restarts the measured log
// clean. defaultState stamps the current version so a fresh install never migrates.
export const METRICS_VERSION = 2;

// The one hidden folder that holds all per-project wiregraph data. Back-compat
// shim for the codegraph→wiregraph rename: prefer `.wiregraph`, but adopt an
// existing legacy `.codegraph` in place so a project indexed before the rename
// keeps working (its graph/state aren't orphaned and no re-index is forced). New
// projects always get `.wiregraph`.
export function wiregraphDir(project) {
  const dir = join(project, '.wiregraph');
  if (existsSync(dir)) return dir;
  const legacy = join(project, '.codegraph');
  if (existsSync(legacy)) return legacy;
  return dir;
}

export function stateFilePath(project) {
  return join(wiregraphDir(project), 'state.json');
}

export function refreshLogPath(project) {
  return join(wiregraphDir(project), 'refresh.log');
}

// Ensure the project's .gitignore excludes the .wiregraph/ folder. Idempotent:
// no-op if already present. Creates .gitignore if missing. Returns 'added' |
// 'present' | 'no-git' (no .git here, so nothing to do).
export function ensureGitignore(project) {
  if (!existsSync(join(project, '.git'))) return 'no-git';
  const gi = join(project, '.gitignore');
  let cur = '';
  if (existsSync(gi)) cur = readFileSync(gi, 'utf8');
  const has = cur.split('\n').some((l) => {
    const t = l.trim();
    // Accept the legacy .codegraph/ lines too, so a pre-rename project isn't given
    // a redundant ignore entry while it's still using its .codegraph dir.
    return t === GITIGNORE_LINE || t === '/.wiregraph/' || t === '.codegraph/' || t === '/.codegraph/';
  });
  if (has) return 'present';
  const block = `\n# wiregraph: indexed graph runtime + machine-local state (never commit)\n${GITIGNORE_LINE}\n`;
  writeFileSync(gi, (cur.replace(/\n*$/, '') || '') + block);
  return 'added';
}

export function defaultState(project, pluginVersion = null) {
  return {
    project,
    indexedRoots: [project],
    // External directories this graph includes as MEMBERS (see §link feature). Each
    // entry is an object { root, peer, initiator, autoCreated, linkedAt }; a legacy
    // bare-string root is tolerated by normalizeLink. Accessed only through the
    // memberRoots()/members() accessors — never read state.links directly.
    links: [],
    reposLastSha: {},
    lastFullBuild: null,
    pluginVersion,
    autoUpdate: 'balanced',
    inferredSeams: 0,
    contractsDir: null,
    // PLURAL. Recursive mode discovers a contracts dir per governed subtree, so there is
    // genuinely no single "the" contracts dir — `contractsDir` above is just the first
    // (outermost) entry, kept because every pre-existing consumer reads it, and because
    // it stays the dir /wiregraph-contracts writes into. Stamped by every full build
    // (src/build.js) and by /wiregraph-contracts apply. GLOBAL MODE FILLS IT TOO, with
    // the depth-1 list, so no consumer has to branch on mode to read it — and the
    // SessionStart nudge can gate on `!contractsDir && !contractsDirs?.length` without
    // going silent on a legacy project or nagging forever on a nested one.
    contractsDirs: null,
    // Set by an incremental update that added/removed/renamed a symbol: cross-file
    // callers resolved by name may be approximate until the next full rebuild.
    // Cleared by every full build. graph_status surfaces it so "fresh" isn't a lie.
    structuralDriftSinceFullBuild: false,
    // Set by an incremental update that changed the symbol name-set IN a compartment
    // that participates in a contract seam (has/had REFERENCES): a route may have been
    // added/removed, but the inferred spec is regenerated only by a full rebuild. Cleared
    // by every full build. graph_status + trace_contract surface it so a newly added or
    // removed endpoint isn't silently missing from the seams.
    seamStaleSinceInference: false,
    // Stamped by the SessionStart hook each run. Absent on an indexed project ⇒
    // plugin hooks aren't firing (catch-up/nudges/re-index off); /wiregraph-status flags it.
    hooksLastFired: null,
    // --- compartment mode (opt-in, set ONLY by /wiregraph-init) ---------------
    // `mode`: absent | 'recursive'. ABSENT is the legacy/global mode — compartments
    // inferred from `.git` / a build manifest (src/extract/walk.js). Deliberately NOT
    // stamped here and NEVER backfilled by normalizeState: exactly the metricsVersion
    // precedent, so an existing project's state is never rewritten and every consumer
    // reads `state.mode || 'global'` at the READ site (isRecursiveMode).
    //
    // `compartments`: null | [{ path, name }]. null = NOT declared (distinct from []
    // = declared empty, which means "no sub-compartments, everything is the root").
    // `path` is RELATIVE to the project root — loadState rebinds state.project to the
    // directory it read from on a rename/move, so an absolute declared path would
    // dangle after a rename and silently revert every file to the root compartment.
    //
    // `compartmentsFingerprint`: null | { <rootKey>: <partition value> }. Stamped
    // (MERGED, like reposLastSha) by every full build, and ONLY AFTER the graph is
    // actually on disk; a per-root mismatch forces a full rebuild. null = no baseline yet,
    // which is never read as "changed". `<rootKey>` is '.' for this project's own root and
    // the absolute path for a linked member OUTSIDE it — relative so that renaming/moving
    // the project cannot orphan the baseline and silently disarm the guard.
    // The value covers the partition IN FORCE, declared OR inferred: global mode is the
    // DEFAULT, and its boundaries come from disk (`.git`, build manifests), which moves.
    //
    // A brand-new project gets the nulls; an EXISTING project simply lacks the keys,
    // and every read site treats absent and null identically.
    compartments: null,
    compartmentsFingerprint: null,
    // `contractsFingerprint`: null | { <rootKey>: <resolved-spec-set value> }. Exactly the
    // same shape, KEYING, stamping rule and absent-means-no-baseline rule as
    // compartmentsFingerprint above, for the OTHER thing a full build resolves and an
    // incremental silently inherits: the SPECS in force — which file, under which scope,
    // with which contents — not merely the directories holding them. See
    // contractsFingerprint() below for why the container is the wrong subject.
    contractsFingerprint: null,
    // A BRAND-NEW project created by THIS version starts at the current metrics
    // version, so migrateMetrics never touches its (empty) log. A state written by an
    // OLDER version LACKS this field — normalizeState deliberately does NOT backfill it,
    // so a missing value is the signal that the pre-v2 log needs archiving.
    metricsVersion: METRICS_VERSION,
  };
}

// Load a project's state, DISTINGUISHING an absent file from a corrupt one — the
// distinction updateState needs so a torn/partial read can never be mistaken for a
// fresh project and overwritten with defaults (the H1 data-loss bug). Returns
// { status, state }:
//   - file missing            → { status: 'absent',  state: null }
//   - present but unparseable → { status: 'corrupt', state: null }  (JSON.parse or
//                                 normalizeState threw — a truncated/partial write)
//   - otherwise               → { status: 'ok',      state: <normalized> }
// The 'ok' path applies the SAME own-root self-heal + normalizeState readState has
// always done, so readState (which returns loadState(...).state) is byte-for-byte
// unchanged for its callers: null on BOTH absent and corrupt.
export function loadState(project) {
  const p = stateFilePath(project);
  if (!existsSync(p)) return { status: 'absent', state: null };
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'));
    // Own-root self-heal (§rename safety). The state file's LOCATION is the source of
    // truth for where this graph lives — `project` is just a cached copy. When a project
    // is renamed or moved, the stored `project` (and the indexedRoots derived from it)
    // point at the DEAD path; memberRoots then silently drops the missing own root, so
    // the next full build walks nothing and wipes the graph to 0. Rebind own-root to the
    // directory we actually read from. In-memory only — it persists on the next
    // updateState (same policy as normalizeState's indexedRoots re-derivation).
    if (s && typeof s === 'object') {
      const here = realpathish(project);
      const was = typeof s.project === 'string' ? s.project : null;
      s.project = here;
      if (isProjectCopy(was, here)) s.compartmentsFingerprint = copyPoison(s.compartmentsFingerprint, was);
    }
    return { status: 'ok', state: normalizeState(s) };
  } catch {
    return { status: 'corrupt', state: null };
  }
}

// --- a project COPY is not a project MOVE ------------------------------------
// The rebind above is correct for a MOVE and, on its own, silently WRONG for a COPY.
// `cp -a proj proj2` carries `.wiregraph/` with it — graph.db, the reposLastSha baseline,
// `lastFullBuild`, and both partition fingerprints — and every id in that db is
// project-FREE (`sym:<compartment>:<relPath>:<name>:<line>`, src/model.js), so the copy
// inherits a complete, plausible-looking, ALREADY-FRESH graph describing the ORIGINAL
// project's files. Nothing in it is a lie the guards can see: the fingerprints are keyed
// relative to the project ('.') and hash CONTENT, and a copied tree has the same content,
// so compartmentsDrift/contractsDrift are null; the copied reposLastSha matches the copied
// checkout's HEAD, so changedSince reports nothing to do. The first save in the copy then
// runs an INCREMENTAL against rows the copy never indexed — pruning under the new project
// tag, missing the old one — and `graph_status` reports it as fresh throughout.
//
// THE SIGNAL IS ONE existsSync, AND IT IS DECISIVE. After a MOVE the old path is gone (or
// at least no longer holds a wiregraph state file). After a COPY the original is still
// sitting there WITH ITS OWN `.wiregraph/state.json` — that is what "copy" means. Testing
// for the state file rather than the bare directory matters: `mv proj proj2 && mkdir proj`
// (or a fresh clone into the vacated path) leaves a directory behind that is not a
// wiregraph project, and that is still a move.
//
// WHAT DETECTION DOES: poison the copy's compartment fingerprint, in memory, with a value
// no live partition can equal. That is not a hack for want of a mechanism — it IS the
// mechanism this codebase already uses for "the db does not match this project", and it
// reaches every path at once, which a new state key would not:
//   - changedSince escalates the SessionStart catch-up to a full rebuild (scripts/lib/git.mjs),
//     even in a project with no git repo at all, where the reposLastSha route says nothing;
//   - incrementalBuild REFUSES every other incremental entry point (src/build.js);
//   - healPartitionDrift turns that refusal into an actual rebuild on the post-edit hook
//     path (scripts/hooks/refresh.mjs), so the copy self-heals rather than wedging;
//   - modeLine's pendingRebuildNote tells an agent mid-session, before it trusts a trace.
// The value carries the original path, so the escalation line names WHY:
// `(project root): copied-from:/home/u/proj -> g1:1a2b…`.
//
// It clears itself: the full rebuild those paths run restamps both fingerprints from the
// live tree, and by then `state.project` has been persisted as the copy's own path, so the
// next load sees was === here and this never fires again. Every intermediate failure leaves
// the poison in place, which is the safe direction.
//
// A MOVE IS UNTOUCHED — the old path is gone, so this returns false and the rebind is all
// that happens (renameGhostCompartmentTest depends on exactly that). The one false positive
// is `mv proj proj2` followed by initializing a NEW wiregraph project at the old path; the
// cost is one extra full rebuild of proj2, which is also the safe direction.
const COPY_POISON_PREFIX = 'copied-from:';
function isProjectCopy(was, here) {
  return !!was && was !== here && existsSync(stateFilePath(was));
}
function copyPoison(prior, was) {
  const base = (prior && typeof prior === 'object' && !Array.isArray(prior)) ? prior : {};
  return { ...base, '.': COPY_POISON_PREFIX + was };
}

export function readState(project) {
  return loadState(project).state;
}

// The exact advisory wording graph_status surfaces off the honesty flags, kept in
// one place so the MCP handler can't drift and a test can assert the surfacing
// without spinning up the stdio server.
export const STRUCTURAL_DRIFT_NOTE =
  'Note: symbols were added/removed/renamed since the last full build — some cross-file caller edges may be approximate. Run update_graph {full:true} (/wiregraph-rebuild) to reconcile.';
export const SEAM_STALE_NOTE =
  '⚠ a route may have changed since the last contract inference — run update_graph {full:true} (/wiregraph-rebuild) to re-infer the seams.';

// How this project's compartments are decided, rendered for graph_status's `Mode:`
// line (directly below the posture line — that pair is what /wiregraph-status step 1
// consumes and what an agent sees mid-session). Kept HERE rather than in the MCP
// handler for the same reason as STRUCTURAL_DRIFT_NOTE: one place the handler can't
// drift from, assertable without spinning up the stdio server.
//
// 'recursive' means the compartments are DECLARED in .wiregraph/state.json; anything
// else — including an absent key, which is every project predating this mode — means
// they are INFERRED from .git / a build manifest. Mode is set only by /wiregraph-init.
export function modeLine(state) {
  if (!isRecursiveMode(state)) return 'global — compartments inferred from .git / build manifests' + pendingRebuildNote(state);
  // Report the partition the BUILD is actually using, not the text of the declaration.
  // state.json is hand-editable and a declared directory can be renamed or deleted after
  // the fact, so a declaration can be present and still refused by the read path — in
  // which case the build silently ran on INFERRED compartments and every declared name an
  // agent might quote here does not exist in the graph. That is exactly the read-back
  // /wiregraph-init step 9 and mid-session agents rely on, so it has to tell the truth.
  const res = state?.project ? resolveDeclaration(state.project) : null;
  if (res && res.state === 'unusable') {
    return 'recursive — but the DECLARATION IS UNUSABLE and was IGNORED; this build used INFERRED compartments. '
      + `Fix and rebuild: ${res.errors.join(' | ')}` + pendingRebuildNote(state);
  }
  const list = Array.isArray(state?.compartments) ? state.compartments : [];
  const names = list.map((c) => c?.name).filter(Boolean).join(', ');
  // Contracts SCOPING is half of what recursive mode means, and it changes how an agent
  // must read a trace: a token defined in `client/contracts/` cannot match code under
  // `server/`, so "one-sided" on an inner contract is a different finding from
  // "one-sided" on a global one. Rendered from the dirs the last full build actually
  // discovered (state.contractsDirs), relative to the project root so the line stays
  // readable. Absent/empty (a legacy state, or a project with no contracts dir at all)
  // simply omits the clause rather than asserting something untrue.
  const dirs = Array.isArray(state?.contractsDirs) ? state.contractsDirs : [];
  const rel = (d) => (state?.project && d.startsWith(state.project + '/') ? d.slice(state.project.length + 1) : d);
  const scopeNote = dirs.length
    ? `; contracts SCOPED to ${dirs.length} dir(s), each governing its own subtree: ${dirs.map(rel).join(', ')}`
    : '';
  return `recursive — ${list.length} compartment(s) DECLARED in .wiregraph/state.json${names ? `: ${names}` : ''}${scopeNote}${pendingRebuildNote(state)}`;
}

// Whether the partition the GRAPH was built against still matches the one in force NOW —
// and this is the difference between a Mode: line that is true and one that merely recites
// state.json. Everything above reports the DECLARATION (or, for a global project, that
// compartments are inferred); none of it says whether the db actually holds that partition.
// Observed: `Mode: recursive — 2 compartment(s) DECLARED …: alpha, beta`, `advisories: []`,
// while the db held ["proj","alpha"] — an agent reading that line quotes a compartment name
// that no row in the graph carries. compartmentsDrift ALREADY knows at that moment; the
// only thing missing was saying so.
//
// Deliberately on BOTH branches, global included: since the inferred partition is
// fingerprinted too (see compartmentPartition), a global project can be exactly as stale —
// a manifest appearing in a subdirectory re-partitions it with no declaration involved.
//
// Best-effort by construction: this line is a diagnostic and must never be the reason
// graph_status throws, so any failure resolving the live partition yields no note. An
// ABSENT stamp yields no note either — no baseline is not a mismatch (fingerprintDrift).
function pendingRebuildNote(state) {
  if (!state?.project) return '';
  try {
    const drift = compartmentsDrift(state.compartmentsFingerprint, compartmentsFingerprint(memberRoots(state), { project: state.project }));
    if (!drift) return '';
    return ` — ⚠ A FULL REBUILD IS PENDING: the graph was built against a DIFFERENT partition than the one in force now (${drift}), so the compartments named above are NOT what the graph holds. Run update_graph {full:true} (/wiregraph-rebuild).`;
  } catch { return ''; }
}

// The graph_status lines for `state.lastBuildWarnings` — the snapshot refresh.mjs persists
// whenever a build DROPPED GRAPH CONTENT (a spec skipped on a title collision, a dropped
// resource id, a misspelled compartment in a role list, the fan-out cap). Nothing rendered
// it, so the one condition under which the report reads healthy while the graph is
// knowingly incomplete had no surface at all.
//
// HERE, not in the MCP handler, for the same reason as STRUCTURAL_DRIFT_NOTE and modeLine:
// one place the handler cannot drift from, and assertable without spinning up the stdio
// server. graph_status puts these directly under its `Mode:` line — with the lines an agent
// reads BEFORE trusting a trace, not appended after the freshness verdict.
//
// QUIET WHEN ABSENT, and quiet on an EMPTY items list. `items: []` is not "unknown": it is
// a COMPLETED FULL REBUILD asserting it dropped nothing (only a full rebuild is allowed to
// say that — see flushWarnings in scripts/hooks/refresh.mjs), so printing anything for it
// would report a clean build as a finding. Capped at 5, because the full list is already in
// refresh.log and a status report that scrolls is a status report nobody reads.
// --- WHAT COUNTS AS "DROPPED", AND WHAT IS MERELY A NOTICE ---------------------
// The tee that captures these (src/build.js) keyed on `⚠` alone, so the compartment-name
// DISAMBIGUATION notice — whose own text says "wiregraph RENAMED them to keep the graph
// correct" — was persisted and rendered under the heading "LAST BUILD DROPPED GRAPH CONTENT
// … what they name is NOT in the graph". On a 22-compartment tree that self-contradiction
// printed after every single build, which is the fastest way to teach a reader to skip the
// whole block. Nothing was dropped there: the compartments are all present, under names the
// build chose. So the classification is explicit and the two are rendered separately.
//
// NOTICE wins over DROPPED when a block matches both, because the notice markers name
// SPECIFIC messages and the drop markers are deliberately generic (`⚠` catches warnings
// added later, which is the property that makes the tee outlive the list). Adding a message
// here is how you say "this one is informational"; the default stays "assume content loss".
export const WARN_DROP_MARKERS = ['⚠', 'wiregraph: WARNING', 'wiregraph: IGNORING'];
export const WARN_NOTICE_MARKERS = ['COMPARTMENT NAME COLLISION'];

export function classifyWarningLine(line) {
  const s = String(line);
  if (WARN_NOTICE_MARKERS.some((m) => s.includes(m))) return 'note';
  if (WARN_DROP_MARKERS.some((m) => s.includes(m))) return 'dropped';
  return null;
}

// A WARNING IS A BLOCK, NOT A LINE. The two loudest messages in the build are multi-line:
// the compartment-collision notice (header, then the colliding dirs and their new names,
// then the consequence to act on) and `wiregraph: IGNORING the compartment declaration`
// (header, then each validation error, then the remedy). Keeping only the marker line threw
// away the directories, the new names, the errors and the remedy — i.e. the entire
// actionable payload — and delivered the bare header to graph_status.
//
// Both are written with ONE `process.stderr.write(lines.join('\n') + '\n')`, and every
// single-line warning is its own `log()` call, so "the lines of one write" is exactly the
// block boundary: a marker line opens a block and the following lines of the SAME write
// belong to it until the next marker line. Lines before any marker are ordinary build
// output and are dropped.
//
// Capped at MAX_BLOCK_LINES so a validation error list cannot turn a status report into a
// scroll; the full text is in .wiregraph/refresh.log either way.
const MAX_BLOCK_LINES = 8;

export function splitWarningBlocks(lines) {
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const line = String(raw).replace(/\s+$/, '');
    const kind = classifyWarningLine(line);
    if (kind) {
      if (cur) out.push(cur);
      cur = { kind, lines: [line.trim()] };
      continue;
    }
    if (!cur) continue;              // ordinary build output before any marker
    if (!line.trim()) { out.push(cur); cur = null; continue; } // a blank line ends the block
    if (cur.lines.length < MAX_BLOCK_LINES) cur.lines.push(line);
    else if (cur.lines[cur.lines.length - 1] !== '  …') cur.lines.push('  …');
  }
  if (cur) out.push(cur);
  return out.map((b) => ({ kind: b.kind, text: b.lines.join('\n') }));
}

// --- WHERE A BUILD'S WARNINGS ARE RECORDED, AND WHO MAY ERASE WHOSE -------------
// TWO KEYS, DELIBERATELY. `lastBuildWarnings` is the FULL build's record and only a full
// build ever writes it; `lastIncrementalWarnings` is the incremental's. That separation is
// the whole fix for three observed failures:
//
//  1. A NOISY INCREMENTAL USED TO OVERWRITE THE FULL BUILD'S ACCURATE SNAPSHOT. An
//     incremental re-loads the contract set, so title/resource-id collisions recur there —
//     but the fan-out cap fires ONLY in the full WIRE derivation, so a one-file save
//     replaced a complete finding with a partial list that no longer named it.
//  2. A FULL REBUILD DID NOT CLEAR IT, so the remedy the report prescribes ("fix the cause,
//     then /wiregraph-rebuild") left the block unchanged and the agent looped: report →
//     rebuild → report the identical finding. A COMPLETED full build is a complete
//     re-derivation and is entitled to assert `items: []`, which renders as nothing.
//  3. ONLY THE HOOK WROTE IT AT ALL, so `update_graph {full:true}` and `node src/build.js
//     --reset` recorded nothing and graph_status displayed an OLDER build's warnings
//     captioned as the current one. Recording now happens in runBuild, which every build
//     path funnels through.
//
// An incremental may clear its OWN key (a fixed spec stops being reported from that slot)
// and may never touch the full build's. A full build clears both, but only when it
// COMPLETED — a build that threw part-way has usually already emitted its content-dropping
// warnings, and it is entitled to record THOSE, never to assert cleanliness.
//
// No state file ⇒ no write: updateState would fall through to defaultState and plant a
// complete, plausible-looking state.json in a directory that is not an indexed project.
export function recordBuildWarnings(project, kind, blocks, { complete = true } = {}) {
  const items = [], notes = [];
  for (const b of blocks || []) {
    const text = typeof b === 'string' ? b : b?.text;
    if (!text) continue;
    const bucket = (typeof b === 'string' ? classifyWarningLine(text) : b.kind) === 'note' ? notes : items;
    if (!bucket.includes(text)) bucket.push(text);
  }
  if (!complete && !items.length && !notes.length) return null;  // asserts nothing
  const key = kind === 'full' ? 'lastBuildWarnings' : 'lastIncrementalWarnings';
  const st = readState(project);
  if (!st) return null;
  // DON'T REWRITE STATE ON A QUIET BUILD. Only the timestamp would move, and a save that
  // rewrites keys it did not change is exactly what makes a state diff unreadable (and what
  // the legacy-stamp test pins). A build with nothing to say about a slot that is already
  // silent writes nothing at all.
  const prior = st[key];
  const priorItems = Array.isArray(prior?.items) ? prior.items : [];
  const priorNotes = Array.isArray(prior?.notes) ? prior.notes : [];
  const same = JSON.stringify(priorItems) === JSON.stringify(items) && JSON.stringify(priorNotes) === JSON.stringify(notes);
  const mustClearIncremental = kind === 'full' && complete && st.lastIncrementalWarnings != null;
  if (same && !mustClearIncremental) return null;
  const rec = { at: new Date().toISOString(), kind, items, notes };
  const patch = { [key]: rec };
  // A COMPLETED full rebuild supersedes the incremental record too: it re-derived
  // everything the incremental only touched a slice of.
  if (kind === 'full' && complete) patch.lastIncrementalWarnings = null;
  updateState(project, patch);
  return rec;
}

function warningBlock(header, items) {
  const lines = [header];
  for (const item of items.slice(0, 5)) lines.push(`  - ${item}`);
  if (items.length > 5) lines.push(`  - …and ${items.length - 5} more (full list in .wiregraph/refresh.log)`);
  return lines;
}

export function buildWarningLines(state) {
  const full = state?.lastBuildWarnings;
  const inc = state?.lastIncrementalWarnings;
  const fullItems = Array.isArray(full?.items) ? full.items : [];
  const incItems = (Array.isArray(inc?.items) ? inc.items : []).filter((i) => !fullItems.includes(i));
  const notes = [];
  for (const rec of [full, inc]) for (const n of (Array.isArray(rec?.notes) ? rec.notes : [])) if (!notes.includes(n)) notes.push(n);

  const lines = [];
  if (fullItems.length) {
    lines.push(...warningBlock(
      `⚠ LAST BUILD DROPPED GRAPH CONTENT: ${fullItems.length} warning(s) from the last `
      + `${full.kind || 'unknown'} build${full.at ? ` (${full.at})` : ''} — what they name is NOT in the graph, so a `
      + 'trace over it reads clean while being incomplete. Fix the cause, then /wiregraph-rebuild.',
      fullItems));
  }
  if (incItems.length) {
    lines.push(...warningBlock(
      `⚠ THE LAST INCREMENTAL UPDATE ALSO DROPPED GRAPH CONTENT: ${incItems.length} further warning(s)`
      + `${inc.at ? ` (${inc.at})` : ''}. An incremental re-derives only part of the graph, so this list is `
      + 'PARTIAL — run /wiregraph-rebuild for the complete picture.',
      incItems));
  }
  if (notes.length) {
    // A DIFFERENT HEADING AND A DIFFERENT SYMBOL, because this is not content loss.
    lines.push(...warningBlock(
      `ⓘ THE LAST BUILD RENAMED OR ADJUSTED SOMETHING: ${notes.length} notice(s). NOTHING WAS DROPPED — the `
      + 'graph holds everything, under the names below. Read them before quoting a compartment name or a spec role list.',
      notes));
  }
  return lines;
}

// Advisory note lines derived PURELY from a project's state flags. graph_status
// appends these after its freshness line so a flat "fresh" is never read as "every
// caller edge and seam is guaranteed correct". Order: structural drift, then seam
// staleness.
export function statusAdvisories(state) {
  const notes = [];
  if (state?.structuralDriftSinceFullBuild) notes.push(STRUCTURAL_DRIFT_NOTE);
  if (state?.seamStaleSinceInference) notes.push(SEAM_STALE_NOTE);
  return notes;
}

// realpath a path, falling back to the input if it can't be resolved (missing dir,
// permission). Keeps comparisons total even for a member root that has moved.
function realpathish(p) {
  if (!p) return p;
  try { return realpathSync(p); } catch { return p; }
}

// Warn at most once per process per missing member root — memberRoots runs on
// every readState (it re-derives indexedRoots), so an unguarded warning would spam.
const _warnedMissing = new Set();

// The canonical link-entry shape (§data model). Tolerates a legacy bare-string
// root and back-fills the object form so every consumer sees one shape.
function normalizeLink(l) {
  if (!l) return null;
  if (typeof l === 'string') {
    return { root: l, peer: l, initiator: null, autoCreated: false, linkedAt: null };
  }
  if (!l.root) return null;
  return {
    root: l.root,
    peer: l.peer ?? l.root,
    initiator: l.initiator ?? null,
    autoCreated: l.autoCreated ?? false,
    linkedAt: l.linkedAt ?? null,
  };
}

// Lazy state migration + self-heal, applied by readState before returning:
//  - backfill links:[] on a pre-link state.json,
//  - re-derive indexedRoots = memberRoots(state) so any external reader sees the
//    live union (indexedRoots is a mirror, never a source of truth).
// Does NOT rewrite the file — the upgrade persists on the next updateState.
export function normalizeState(s) {
  if (!s || typeof s !== 'object') return s;
  if (!Array.isArray(s.links)) s.links = [];
  s.indexedRoots = memberRoots(s);
  return s;
}

// The normalized MEMBER LINK entries of a graph (excludes the graph's own root).
export function members(stateOrProject) {
  const state = typeof stateOrProject === 'string' ? readState(stateOrProject) : stateOrProject;
  if (!state || !Array.isArray(state.links)) return [];
  return state.links.map(normalizeLink).filter(Boolean);
}

// The full set of ROOT paths this graph indexes: its own root ∪ every linked
// member root, each realpath'd, deduped, with non-existent roots dropped (once-per
// -process warning). Own root is at index 0. Accepts a state object (no disk read)
// or a project path (reads its state). This is THE union every build walks.
export function memberRoots(stateOrProject) {
  let state;
  if (typeof stateOrProject === 'string') {
    state = readState(stateOrProject);
    if (!state) return [realpathish(stateOrProject)];
  } else {
    state = stateOrProject || {};
  }
  const out = [];
  const seen = new Set();
  const push = (p, isOwn) => {
    if (!p) return;
    const r = realpathish(p);
    if (!existsSync(r)) {
      if (!isOwn && !_warnedMissing.has(r)) {
        _warnedMissing.add(r);
        process.stderr.write(`wiregraph: linked member root no longer exists, skipping: ${r}\n`);
      }
      return;
    }
    if (seen.has(r)) return;
    seen.add(r);
    out.push(r);
  };
  push(state.project, true);
  for (const l of members(state)) push(l.root, false);
  return out;
}

// --- compartment mode + declaration fingerprint ------------------------------
// `mode` follows the metricsVersion precedent EXACTLY: normalizeState backfills
// NOTHING and every consumer reads it at the READ site. Absent (and null, and any
// unrecognized value) means the legacy global mode — compartments inferred from
// `.git` / build manifests. `'global'` is never written onto an existing project.
export function isRecursiveMode(stateOrProject) {
  const state = typeof stateOrProject === 'string' ? readState(stateOrProject) : stateOrProject;
  return (state?.mode || 'global') === 'recursive';
}

// THERE IS NO 'global' CONSTANT ANY MORE. The per-root value for a root whose
// compartments are INFERRED used to be the literal `'global'`, justified as "a legacy
// project's partition is not declared, so it cannot be declared differently" — the exact
// simplification §14 proved unsafe for the contracts fingerprint and removed there, never
// re-examined for the fingerprint it was learned FROM. It is true about the DECLARATION
// and false about the PARTITION: inference reads DISK, and disk changes.
//
// Observed on a plain global project (the DEFAULT mode), with the constant in place: full
// build, then `echo '{"name":"subpkg"}' > sub/package.json` — which src/extract/walk.js
// makes a compartment boundary — then ONE ordinary save of `sub/b.js`. The value could not
// move, so nothing escalated and nothing refused, and the save left `betaFn` under BOTH
// `sym:proj:sub/b.js:...` (the pre-existing rows, pruned under the OLD attribution and
// therefore MISSED) and `sym:sub:b.js:...` (freshly inserted under the NEW one), with two
// `files` rows and orphaned CALLS edges: precisely the corruption
// renameGhostCompartmentTest pins for a project rename. Reachable from `npm init` in a
// subdirectory, `cargo new`, `go mod init`, adding a workspace package, or a `git clone`
// that brings in a submodule. SELF-HEAL TIME: NEVER — a manifest is not a source file, so
// langForFile filters it out of changedSince's file list and no later save ever
// reconsiders. (The `.git` sub-case does heal, via changedSince's "new repo" escalation,
// which is exactly what hid the manifest case.)
//
// So an inferred root now hashes the partition inference ACTUALLY RESOLVES TO, on the same
// terms a declared root does: the normalized (path, name) pairs of the boundaries
// findCompartmentRoots returns, paths RELATIVE to the root, sorted, JSON-encoded. Same
// rules as §14 hardened for the contracts fingerprint, all of them load-bearing:
//  - ABSENT means "no baseline" and NEVER "changed" (fingerprintDrift), so a project built
//    before this key existed is not force-rebuilt on its next catch-up;
//  - comparison is PER ROOT over MOUNTED roots only, and the stamp MERGES, so a transient
//    unmount or unlink's deliberately reduced union cannot forge a partition change;
//  - components are JSON-encoded, so no path or name can forge a field boundary.
// The two kinds of partition carry DIFFERENT prefixes (`r1:` declared, `g1:` inferred) so
// a declaration can never hash equal to an inference that happens to have the same shape —
// the fallback from a broken declaration to inference must always read as a change.
//
// WHAT IT DELIBERATELY DOES NOT COVER: ordinary source edits. Only the BOUNDARY set moves
// this value, so adding, editing or deleting a .js file under an existing compartment
// leaves it alone — otherwise every save would escalate to a full rebuild.
function partitionValue(kind, pairs) {
  const sorted = [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return kind + ':' + createHash('sha1').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

// The compartment partition IN FORCE for ONE root: its fingerprint value AND the
// `[{dir, name}]` list the walk will attribute against. ONE function, because the two must
// never disagree about what the partition is — and because resolving it is the expensive
// half (a declaration re-validates against disk; an inference walks the tree), so a caller
// that needs both should pay once. src/build.js#discoveryContext memoizes exactly this for
// the duration of one save.
// THE ROOT FALLBACK NAME IS PART OF THE PARTITION, in BOTH branches. `compartmentNameFor`
// (src/extract/walk.js) attributes every file that sits under NO compartment boundary to
// `basename(rootDir)`, and that name is embedded in the id of every such symbol — so it
// determines the partition exactly as a boundary's own name does. Neither branch carried
// it: the declared branch hashes only the declared pairs, and the inferred branch only
// happens to carry it when the root is ITSELF a boundary (a manifest at the top level),
// which is precisely the shape that hid this.
//
// Observed through the real post-edit hook on a project with a root-attributed file:
// `mv R2 R2b` then ONE save re-attributed that file from `R2/...` to `R2b/...` while
// pruneFile deleted under `R2b` — a miss — leaving `toolFn` under BOTH compartments, with
// refresh.log reporting a clean "reindexed 1 explicit file(s) into 1 graph(s)". Self-heal:
// for a git repo at the root the next SessionStart escalates on "new repo", so it lives
// for the session; for a project with NO git at the root, NEVER.
//
// `'\0root'` as the pair's path is deliberately not a path any real boundary can produce
// (declared paths are validated relative spellings, inferred paths come from fpPath), so
// the root name cannot collide with, or be forged by, a boundary of the same name — and
// the pairs are JSON-encoded, so the NUL survives as an escape rather than a separator.
// A project MOVE therefore now moves this value, which is CORRECT: the move renames the
// compartment every root-attributed file lives in, so an incremental after one would
// prune under the new name and miss every old row.
function rootFallbackPair(root) {
  return ['\0root', basename(root)];
}

export function compartmentPartition(root) {
  const res = resolveDeclaration(root);
  if (res.state === 'declared') {
    return {
      declared: true,
      value: partitionValue('r1', [rootFallbackPair(root), ...res.compartments.map((c) => [c.path, c.name])]),
      roots: res.compartments.map((c) => ({ dir: resolve(root, c.path), name: c.name })),
    };
  }
  // 'none' (legacy/global) and 'unusable' (a declaration the read path refused) both land
  // on inference, and findCompartmentRoots is the SAME funnel the walk uses — so this
  // hashes what the build will actually do, never what the state file claims.
  const inferred = findCompartmentRoots(root);
  return {
    declared: false,
    value: partitionValue('g1', [rootFallbackPair(root), ...inferred.map((c) => [fpPath(root, c.dir), c.name])]),
    roots: inferred,
  };
}

// A stable hash of the compartment partition across a union of roots.
// Stamped at every full build (build.js) and compared on the incremental paths
// (git.mjs changedSince → fullBuildReasons, and build.js's outright refusal),
// because a declaration change rewrites BOTH components of every id — the
// compartment name is embedded in each id, and relPath is relative to the
// compartment ROOT — so an incremental would prune under the OLD attribution, MISS,
// and leave duplicate symbols under two compartments plus orphaned CALLS edges.
// That is the same silent corruption renameGhostCompartmentTest pins for a rename,
// and nothing detected it before this.
//
// IT HASHES THE PARTITION IN FORCE, NOT THE DECLARATION TEXT. This is the whole
// correctness property, and it was the original bug: hashing only the stored
// `(path, name)` strings meant NOTHING covered the disk half. `mv server/sim
// server/simulation` after a full build left the declaration text byte-identical, so the
// fingerprint did not move, the incremental was ACCEPTED, and afterwards `simStep`
// existed under BOTH the new path's compartment and a ghost `sim` row pointing at a
// directory that no longer existed. Deleting a declared directory did the same thing.
// Renaming or deleting a source directory is ordinary work and MUST escalate to a full
// rebuild — which it now does, because resolveDeclaration re-validates against disk on
// every read: a vanished declared path makes the declaration unusable, the root falls
// back to the INFERRED partition, whose value is different by construction (a different
// prefix, and a different subject).
//
// WHAT IT COVERS, and deliberately what it does NOT:
//  - A MAP, root KEY -> that root's partition value, merged on stamp exactly like
//    reposLastSha. A root that is transiently UNMOUNTED simply is not compared (its
//    stale entry is inert), instead of dropping out of a single whole-union hash and
//    forging a partition change out of a mount blip. Same reason unlink's deliberately
//    REDUCED union (allowReducedUnion) no longer forces a spurious full rebuild.
//  - THE KEY IS RELATIVE TO THE PROJECT ('.' for the project's own root), not the
//    absolute root path. Keying on the absolute path made BOTH fingerprints go dark on
//    `mv proj proj2`: the values were rename-stable, but every map KEY moved, so
//    fingerprintDrift's `was === undefined` skip fired for every root and the two guards
//    silently stopped guarding. Paired A/B: delete a contracts spec and save — WITHOUT a
//    project move the incremental correctly refuses; WITH one it proceeded silently. A
//    root OUTSIDE the project (a linked member) keeps its absolute key, which is the
//    stable spelling for it — it did not move when the project did.
//  - A root whose partition is INFERRED hashes the boundary set findCompartmentRoots
//    actually resolves to (see compartmentPartition above), NOT a constant.
//  - THE VALUE IS NOT RENAME-STABLE, AND MUST NOT BE (the key still is). Every file under
//    no boundary is attributed to basename(root), so `mv proj proj2` renames the
//    compartment those files live in and re-partitions every one of their ids. The value
//    therefore carries the root's basename in both branches, a move reads as a real
//    partition change, and the escalation it triggers is the correct outcome rather than
//    the spurious one the KEY fix above was about. (The key fix is still load-bearing and
//    unchanged: without it a moved project's stamp is not even LOOKED UP.)
//  - A root running on a usable declaration hashes its NORMALIZED, VALIDATED
//    (path, name) pairs. Normalized, so `pkg`, `pkg/` and `pkg/../pkg` are ONE
//    fingerprint for one partition rather than three (a hand edit could otherwise force
//    a rebuild that changed nothing). Validated, so the pairs are exactly the ones the
//    walk will use, and so a declared path that has vanished from disk cannot be hashed
//    as though it were still there.
//  - JSON-encoded before hashing, not concatenated with separator bytes. The old
//    encoding asserted NUL/SOH/STX could not occur in a name, but the name rule only
//    rejected `[:/\\]`, so [{x,n1},{y,n2}] and [{x,"n1<SOH>y<STX>n2"}] hashed
//    IDENTICALLY and a real partition change escaped the guard. JSON escapes every
//    control character, so no name can forge a field boundary — and validateDeclaration
//    now rejects control characters in a name as well, closing the same hole in the
//    walk's own id space.
//  - Absolute declared paths are impossible (validateDeclaration rejects them):
//    `loadState` rebinds state.project on a rename/move, and a project rename must not
//    masquerade as a partition change.
//
// `opts.project` is the graph root every key is spelled relative to; it defaults to the
// first root, which is what memberRoots() always puts the own root at. `opts.partitionOf`
// lets a caller that has already resolved the partition — the build and the post-edit
// hook, which share ONE discoveryContext per save — hand it over instead of re-resolving
// the declaration and re-walking the tree.
export function compartmentsFingerprint(rootsOrProject, opts = {}) {
  const roots = Array.isArray(rootsOrProject) ? rootsOrProject : memberRoots(rootsOrProject);
  const project = opts.project || (typeof rootsOrProject === 'string' ? rootsOrProject : roots[0]);
  const partitionOf = opts.partitionOf || compartmentPartition;
  const out = {};
  for (const r of roots) out[fpRootKey(project, r)] = partitionOf(r).value;
  return out;
}

// Has the partition MOVED since the stamp? Returns a human-readable summary of what
// changed, or null for "no detectable change" — which is also the answer for every root
// with no baseline.
//
// AN ABSENT ENTRY MEANS "NO BASELINE", NEVER "CHANGED". A project last built before this
// key existed, and a member linked in since the last full build, both have no entry;
// reading that as changed would force a full rebuild on their very next catch-up. Same
// trap schemaOutdated() documents for its 0 stamp. A stamp that is not an object at all
// is treated the same way — no baseline, restamped by the next full build.
export function compartmentsDrift(stamped, current) {
  return fingerprintDrift(stamped, current);
}

// The shared comparison both per-root fingerprints use. Kept as ONE implementation
// because the rules are identical and hard-won (see the two paragraphs above), and two
// copies would drift on exactly the case neither is tested for.
function fingerprintDrift(stamped, current) {
  // ABSENT IS NOT MALFORMED, AND THE DIFFERENCE DECIDES WHICH WAY THIS FAILS.
  //
  // `null`/`undefined` means NO BASELINE and must fail OPEN (return null): that rule is what
  // makes an upgrade non-disruptive — a project last built before this key existed, and a
  // member linked in since the last full build, would otherwise be force-rebuilt on their
  // very next save. Same trap schemaOutdated() documents for its 0 stamp. Keep it.
  //
  // A PRESENT BUT MALFORMED VALUE IS THE OPPOSITE CASE and used to fail open too, silently
  // disarming the guard. Observed: `'garbage'`, `[1,2]`, `5`, `{}` and `{"zzz":…}` in
  // `compartmentsFingerprint` each let a REAL declaration change through an incremental —
  // duplicate symbols under two compartments, with the log saying only `auto: reindexed 1
  // changed file(s)`. A hand edit, a truncated write, or a version that stored a different
  // shape all land here, and none of them is evidence that the graph matches the live
  // partition. So a malformed value is treated as DRIFT: the remedy is one full rebuild,
  // which restamps a well-formed baseline and ends it.
  //
  // WHAT COUNTS AS MALFORMED, AND THE ONE CASE THAT DELIBERATELY DOES NOT. Every stamp is
  // written by compartmentsFingerprint / contractsFingerprint: a plain object, root key ->
  // STRING value, never empty (memberRoots always contains the project's own root). So a
  // scalar, an array, `{}`, and an object holding a non-string value are all shapes this
  // code cannot have produced, and none of them is evidence about the graph.
  //
  // A NON-EMPTY OBJECT OF STRINGS WHOSE KEYS SIMPLY DO NOT MATCH is NOT treated as
  // malformed, even though a hand-written `{"zzz":"…"}` looks like junk. It is
  // INDISTINGUISHABLE from the two legitimate cases the per-root rule exists for — a member
  // linked in since the last full build, and a root unmounted at that build — so failing
  // safe there would force a full rebuild on every project that links a member. The
  // per-root "no baseline" skip below stays exactly as it was.
  if (stamped === null || stamped === undefined) return null;
  const malformed = (why) => `the stored fingerprint is MALFORMED (${why}) — it was not written by a full build, `
    + 'so it is no evidence the graph matches the partition in force; treating it as changed';
  if (typeof stamped !== 'object' || Array.isArray(stamped)) return malformed(JSON.stringify(stamped));
  const entries = Object.entries(stamped);
  if (!entries.length) return malformed('an empty map — a real stamp always carries at least the project root');
  const badValue = entries.find(([, v]) => typeof v !== 'string');
  if (badValue) return malformed(`the entry for ${JSON.stringify(badValue[0])} is ${JSON.stringify(badValue[1])}, not a fingerprint string`);
  const moved = [];
  for (const [key, fp] of Object.entries(current || {})) {
    const was = stamped[key];
    if (was === undefined) continue; // no baseline for this root
    if (was !== fp) moved.push(`${key === '.' ? '(project root)' : basename(key)}: ${was} -> ${fp}`);
  }
  return moved.length ? moved.join('; ') : null;
}

// The KEY a root gets in either fingerprint map: '.' for the project's own root, a
// project-relative path for anything inside it, and the absolute path for a root outside
// it (a linked member — which did not move when the project did, so absolute IS its stable
// spelling). Shared by both maps so a project move cannot silently disarm one of them
// while leaving the other armed.
function fpRootKey(project, root) {
  if (!project || root === project) return '.';
  return root.startsWith(project + sep) ? relative(project, root) : root;
}

// The value a full build should stamp: this build's roots MERGED onto whatever was
// stamped before, so a member that happens to be unmounted (or deliberately excluded, as
// unlink's reduced union does) keeps its baseline instead of silently losing it. A
// leftover entry for a root that is genuinely gone is inert — compartmentsDrift only
// looks up the roots it is given. Exactly the reposLastSha merge rule, for the same reason.
export function stampCompartmentsFingerprint(project, roots, opts = {}) {
  const prior = readState(project)?.compartmentsFingerprint;
  const base = (prior && typeof prior === 'object' && !Array.isArray(prior)) ? prior : {};
  return { ...base, ...compartmentsFingerprint(roots, { ...opts, project }) };
}

// --- the RESOLVED CONTRACT SPEC SET fingerprint --------------------------------
// The second thing a full build RESOLVES and an incremental silently INHERITS. Same
// mechanism as compartmentsFingerprint above, same rules, different subject — and it
// exists because the design's "schema bet" (scope is applied at MATCH time and persisted
// nowhere) is sound only while the stored REFERENCES rows were all minted under the scope
// currently in force.
//
// THE DEFECT IT CLOSES, precisely. `pruneFile` (src/store/sqlite.js) deletes rows only for
// the EDITED file; `rederiveWireEdges` then reads EVERY REFERENCES row in the db and groups
// by `contractId|token` with NO scope of its own — correct exactly when every stored row is
// already scope-correct. Move a contracts dir INWARD (`<root>/contracts` ->
// `<root>/harness/contracts`: same title, same contract id, strictly SMALLER scope) and the
// rows minted under the WIDER scope are indistinguishable from fresh ones, so one file save
// re-derives a WIRE edge a full rebuild does NOT produce, and the stale REFERENCES rows
// keep reporting as real in trace_contract. The same hole opens whenever the DIR SET
// changes at all: a `--contracts <dir>` full build (UNSCOPED by definition) followed by any
// ordinary incremental (scoped), and a contracts dir ADDED after the last full build (the
// `/wiregraph-contracts apply` sequence, whose self-heal time was otherwise never).
//
// So: stamp the RESOLVED set at every full build, compare it on the incremental paths, and
// force a full rebuild — which is safe by construction — rather than let an incremental
// re-derive over rows minted under a different scope. SCHEMA_VERSION STAYS 5: this is
// state.json metadata, not a store column, and the schema bet still holds for every build
// that is allowed to proceed.
//
// WHAT IT HASHES — AND WHY IT IS THE SPECS, NOT THE DIRS.
// The first version of this guard hashed the resolved `{dir, scopeRoot}` pairs. That was
// the WRONG SUBJECT and it was provably inert: `scopeRoot` is a pure function of `dir`
// (`recursive && dir !== root ? dirname(dir) : null`, src/contracts-dirs.js), so the pair
// carried not one bit the bare dir list did not already carry — mutating the hash down to
// `[dir]` alone did not fail a single test. Scope is decided by WHICH SPEC sits in WHICH
// directory UNDER WHAT TITLE. So the subject is now, per root, the resolved
// `{specPath, scopeRoot, contentDigest}` set (`rootContractsSpecs`, layered on top of the
// same `rootContractsEntries` the build loads from, so the two still cannot drift).
//
// That covers the three ordinary edits a dir-set hash is blind to:
//  - a spec MOVED between two contracts dirs that BOTH already exist. `mv
//    contracts/outer.asyncapi.yaml harness/contracts/` narrows that contract from the whole
//    tree to `harness/` with a byte-identical dir set — and reproduces §13's fabricated
//    cross-scope WIRE edge exactly.
//  - a spec's `info.title` EDITED. Same file, different contractId, so the old id's rows
//    are orphaned and the new id never gets its WIRE edge. This is not exotic: retitling is
//    the documented remedy `enforceDistinctTitlePerScope` (src/extract/contracts.js) steers
//    users toward on a title collision, so the tool actively creates this path.
//  - a spec ADDED to, or REMOVED from, a dir that already exists.
// CONTENT DIGEST, NOT mtime+size: specs are small and few, while mtime churns on every
// `git checkout` and would force rebuilds for a byte-identical tree.
//
//  - A `--contracts <dir>` override stamps what it ACTUALLY used, not what discovery would
//    have found, so the next ordinary build sees a different set and escalates. It records
//    the override's IDENTITY as well as its specs: `--contracts /A` and `--contracts /B`
//    used to hash identically (both were merely "unscoped"), so a CI job that switched
//    override dirs left the next incremental re-deriving over the other one's rows.
//
// THERE IS NO 'global' CONSTANT ANY MORE, and its removal is the other half of this fix.
// It hashed every all-unscoped set to a literal, justified as "with no scope anywhere there
// is no narrowing to detect". True about SCOPE, false about STALENESS — and global mode is
// the DEFAULT, and the mode `contractsHome()` (deliberately depth-1) makes
// `/wiregraph-contracts apply` write into. Observed in global mode with the constant in
// place: deleting a contracts dir left a GHOST contract node with live REFERENCES and a
// WIRE edge for a spec no longer on disk, which `trace_contract` reported as real; a
// `--contracts` build followed by an ordinary incremental left the override's contract in
// a db a full rebuild would not produce; and the `apply` ADD gap stayed wide open, with the
// nudge silenced and a self-heal time of never. The seven assertions the constant had all
// merely asserted that the constant was the constant.
//
// Dropping it does NOT force-rebuild legacy projects: absent-means-no-baseline already
// handles the upgrade (a project built before this key existed has no entry and is never
// compared), and a global project's first stamp lands on its next full build. "Byte-
// identical legacy" is a property of the GRAPH OUTPUT, not a promise that a global project
// never escalates.
//
// PATHS ARE RELATIVE TO THE ROOT wherever they are inside it, AND SO IS THE MAP KEY.
// Making the VALUES relative was only half the fix and the comment here used to claim the
// whole of it: both maps still keyed on the ABSOLUTE root, so `mv proj proj2` changed every
// key, fingerprintDrift's `was === undefined` skip fired for every root, and BOTH guards
// went dark — stamped {".../proj": "k2:35f5…"} vs live {".../proj2": "k2:35f5…"}, drift
// null. Paired A/B, same edit either way: delete a contracts spec then save — without the
// move the incremental refuses, with it the incremental proceeds silently. fpRootKey now
// spells the key the same way for BOTH fingerprints. A path OUTSIDE the root — a `--contracts`
// override pointing elsewhere, a linked member's dir — stays ABSOLUTE, because that is the
// stable spelling for it: the override did not move when the project did, and a `../..`
// relative spelling would change with the project's depth.
//
// WHAT IT DELIBERATELY DOES NOT COVER:
//  - `.wiregraph/inferred/`. It is ALWAYS unscoped, so it can never contribute the
//    cross-scope group this guard exists to prevent — and it is written/removed by
//    link/unlink, which already do a full rebuild of both graphs. Including it would move
//    every root's fingerprint on a link add/remove, i.e. exactly the "cannot move on a
//    transient event" rule this shape exists to honour.
//  - An EMPTY contracts dir. It mints no contract, no REFERENCES row and no seam, so it
//    cannot fabricate a cross-scope group; hashing it would force rebuilds that change no
//    graph row. `mkdir contracts` is inert; writing the first spec into it is what moves
//    the value, which is the ADD gap and exactly the event that matters.
//  - Comparison is PER ROOT over MOUNTED roots only, stamped by MERGING, and an ABSENT
//    entry means "no baseline", NEVER "changed" — otherwise every project built before
//    this key existed would force-rebuild on its next catch-up.
//  - Components are JSON-encoded before hashing, so no path or digest can forge a field
//    boundary, and `''` (a scopeRoot equal to the root) stays distinct from `null`
//    (unscoped).

// A path's stable spelling for the fingerprint: relative when it is inside `root` (so a
// project rename/move cannot masquerade as a contract change), absolute when it is not.
function fpPath(root, p) {
  if (p == null) return null;
  if (p === root) return '';
  return p.startsWith(root + sep) ? relative(root, p) : p;
}

// `opts.contracts` is the `--contracts <dir>` override (it replaces discovery for the whole
// build). `opts.specsOf` lets a caller that has already resolved the specs — the build and
// the post-edit hook, which share ONE discoveryContext per save — hand them over instead of
// re-walking the tree and re-reading the specs.
export function contractsFingerprint(rootsOrProject, opts = {}) {
  const roots = Array.isArray(rootsOrProject) ? rootsOrProject : memberRoots(rootsOrProject);
  const project = opts.project || (typeof rootsOrProject === 'string' ? rootsOrProject : roots[0]);
  const specsOf = opts.specsOf || ((r) => rootContractsSpecs(r, isRecursiveMode(readState(r))));
  const out = {};
  for (const r of roots) {
    const specs = opts.contracts
      ? contractsDirSpecs({ dir: opts.contracts, scopeRoot: null })
      : (specsOf(r) || []);
    const rows = specs
      .map((s) => [fpPath(r, s.spec), fpPath(r, s.scopeRoot ?? null), s.digest ?? null])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    // The override's own identity, ahead of its specs: two different override dirs holding
    // no specs (or the same specs) are still two different builds, and the next ordinary
    // build must not mistake either for discovery's result.
    if (opts.contracts) rows.unshift(['--contracts', fpPath(r, opts.contracts), null]);
    out[fpRootKey(project, r)] = 'k2:' + createHash('sha1').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
  }
  return out;
}

// Has the resolved spec set MOVED since the stamp? Identical semantics to
// compartmentsDrift, including "an absent entry is no baseline, never a change".
export function contractsDrift(stamped, current) {
  return fingerprintDrift(stamped, current);
}

// The value a full build should stamp — MERGED onto whatever was there, exactly as
// stampCompartmentsFingerprint does, so an unmounted or deliberately excluded member keeps
// its baseline instead of silently losing it.
export function stampContractsFingerprint(project, roots, opts = {}) {
  const prior = readState(project)?.contractsFingerprint;
  const base = (prior && typeof prior === 'object' && !Array.isArray(prior)) ? prior : {};
  return { ...base, ...contractsFingerprint(roots, { ...opts, project }) };
}

// The graphs that must be updated when a file under member root M changes: M's own
// graph plus every graph linked to M. Because linking is symmetric, M's own
// state.links names every graph that linked M, so this is a complete, fully-local
// reverse index (§edit-sync). Returns project roots, M first.
// A PEER THAT NO LONGER EXISTS IS DROPPED, on the same terms (and with the same
// once-per-process warning) as memberRoots. It is the SAME event — a linked directory
// deleted with `rm -rf` instead of /wiregraph-unlink, or one on an unmounted external
// drive — and memberRoots and the fingerprint maps both already handled it while this
// reverse index did not. `realpathish` RETURNS THE PATH UNCHANGED when realpath fails, so
// a vanished peer sailed through here as an ordinary target: reindexFiles fanned out to
// it, runBuild did `realpathSync(o.project)` on it, and EVERY incremental threw
// `ENOENT ... lstat '<peer>'` — after having already applied to the other graphs, with
// the shas never restamped, so the project stopped indexing entirely until the peer came
// back. `fanOutGraphs` (the schema and drift gates) is built on this function and had the
// same hole. The graph's OWN subject root is never dropped: it is where the edited file
// lives, so dropping it would silently index the edit nowhere.
export function graphsListing(memberRoot) {
  const out = [];
  const seen = new Set();
  const push = (p, isOwn) => {
    const r = realpathish(p);
    if (!r || seen.has(r)) return;
    if (!isOwn && !existsSync(r)) {
      if (!_warnedMissing.has(r)) {
        _warnedMissing.add(r);
        process.stderr.write(`wiregraph: linked member root no longer exists, skipping: ${r}\n`);
      }
      return;
    }
    seen.add(r);
    out.push(r);
  };
  push(memberRoot, true);
  for (const l of members(memberRoot)) push(l.root, false);
  return out;
}

// Every graph an INCREMENTAL from `project` can write into. reindexFiles({fanOut:true})
// re-indexes each edited file into the OWNING MEMBER's graph plus every graph linked to
// that member, each against its own db — so any gate that must run before an incremental
// (the schema gate, the partition-drift gate) has to cover this whole set, not just
// `project`'s own db. Gating only our own db heals us and then runs the exact incremental
// the gate exists to prevent against a peer. owningMember always returns one of
// memberRoots, so this is the complete target set. `project` comes first.
export function fanOutGraphs(project) {
  const seen = new Set();
  const out = [];
  for (const m of memberRoots(project)) {
    for (const g of graphsListing(m)) if (!seen.has(g)) { seen.add(g); out.push(g); }
  }
  return out;
}

// The member root that OWNS an absolute path (longest-prefix match over this
// graph's memberRoots), or null if the path is under no member. Used by the
// edit-sync membership gate and incremental attribution.
export function owningMember(abs, project) {
  const a = realpathish(abs);
  let best = null;
  for (const m of memberRoots(project)) {
    if (a === m || a.startsWith(m + sep)) {
      if (!best || m.length > best.length) best = m;
    }
  }
  return best;
}

// The normalized link entry for a given member root, or null. Accepts a state
// object or a project path.
export function findLink(stateOrProject, root) {
  const state = typeof stateOrProject === 'string' ? readState(stateOrProject) : stateOrProject;
  if (!state) return null;
  const target = realpathish(root);
  for (const l of members(state)) {
    if (l.root === target || l.root === root) return l;
  }
  return null;
}

// Two dirs overlap iff one is the other or an ancestor/descendant of it. Members
// must be filesystem-disjoint, so an overlap is a hard reject.
function overlap(a, b) {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

// Is there a nested workspace index (.wiregraph/state.json) strictly BELOW `root`?
// Bounded walk that skips IGNORE_DIRS. `root`'s OWN index does not count.
function hasNestedIndex(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (dir !== root && existsSync(join(dir, '.wiregraph', 'state.json'))) return true;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && !IGNORE_DIRS.has(e.name)) stack.push(join(dir, e.name));
    }
  }
  return false;
}

// The compartment NAME-set a candidate would contribute: its own basename (files
// under no sub-boundary fall back to basename(root), see walk.js) plus every
// detected compartment boundary's basename.
function compartmentNames(root) {
  const names = new Set([basename(root)]);
  for (const c of findCompartmentRoots(root)) names.add(c.name);
  return names;
}

// Link-time correctness guard (§overlap guard). Returns { ok, reason }. Rejects a
// candidate that:
//   1. overlaps this graph's own root or any existing member (must be disjoint);
//   2. is nested inside ANOTHER workspace's index, or contains a nested foreign
//      index (so an auto-init can't plant a state.json that hijacks another tree);
//   3. would collide on a compartment basename with any existing member — a hard
//      reject, because compartment ids are `compartment:<basename>` (not path
//      unique) and a collision silently merges two repos' compartments.
export function canLink(state, cand) {
  if (!state || !state.project) return { ok: false, reason: 'this directory is not an indexed graph' };
  const candReal = realpathish(cand);
  if (!existsSync(candReal)) return { ok: false, reason: `candidate directory does not exist: ${candReal}` };

  const existing = memberRoots(state); // own root ∪ members
  for (const m of existing) {
    if (overlap(candReal, m)) {
      return { ok: false, reason: `${candReal} overlaps an existing indexed root (${m}); members must be filesystem-disjoint` };
    }
  }

  // Enclosing foreign index: candidate nested inside another workspace. findIndexedRoot
  // returns the candidate itself when the candidate is its own top-level graph (the
  // normal mutual-link case) — that is allowed; only a STRICT ancestor is a reject.
  const enc = findIndexedRoot(candReal);
  if (enc && enc !== candReal) {
    return { ok: false, reason: `${candReal} is nested inside another indexed workspace (${enc})` };
  }
  if (hasNestedIndex(candReal)) {
    return { ok: false, reason: `${candReal} contains a nested indexed workspace; link that workspace's root instead` };
  }

  // Basename collision across the union of existing members' compartment name-sets.
  const existingNames = new Set();
  for (const r of existing) for (const n of compartmentNames(r)) existingNames.add(n);
  const candNames = compartmentNames(candReal);
  const clash = [...candNames].filter((n) => existingNames.has(n));
  if (clash.length) {
    return { ok: false, reason: `compartment basename collision on ${clash.join(', ')} — compartment ids are not path-unique, so linking would silently merge these compartments` };
  }
  return { ok: true };
}

// Add (or replace) a link record on `project`'s state, re-derive indexedRoots, and
// persist. Idempotent — re-linking the same root replaces the record in place.
export function addLink(project, rec) {
  const state = readState(project) || defaultState(project);
  const root = realpathish(rec.root);
  const entry = {
    root,
    peer: realpathish(rec.peer ?? rec.root),
    initiator: rec.initiator ? realpathish(rec.initiator) : null,
    autoCreated: rec.autoCreated ?? false,
    linkedAt: rec.linkedAt ?? new Date().toISOString(),
  };
  const links = members(state).filter((l) => l.root !== root);
  links.push(entry);
  return updateState(project, { links, indexedRoots: memberRoots({ ...state, links }) });
}

// Remove the link to `root` from `project`'s state, prune the member's repo keys
// from reposLastSha, re-derive indexedRoots, and persist. Idempotent.
export function removeLink(project, root) {
  const state = readState(project);
  if (!state) return null;
  const target = realpathish(root);
  const links = members(state).filter((l) => l.root !== target && l.root !== root);
  const reposLastSha = {};
  for (const [k, v] of Object.entries(state.reposLastSha || {})) {
    if (k === target || k === root || k.startsWith(target + sep) || k.startsWith(root + sep)) continue;
    reposLastSha[k] = v;
  }
  return updateState(project, { links, reposLastSha, indexedRoots: memberRoots({ ...state, links }) });
}

// Resolve the indexed WORKSPACE root for a starting directory: walk up from
// startDir to the nearest ancestor that holds .wiregraph/state.json. This lets
// wiregraph work when invoked from a sub-repo (or any nested dir) of a workspace
// that was indexed at a higher level — the graph, db, and metrics all live at that
// root. Returns the realpath of the indexed root, or null if none is found (callers
// fall back to the cwd so a genuinely uninitialized tree still gets the init nudge).
export function findIndexedRoot(startDir, homeDir = homedir()) {
  let start;
  try { start = realpathSync(startDir); } catch { start = startDir; }
  let home;
  try { home = realpathSync(homeDir); } catch { home = homeDir; }
  let dir = start;
  for (;;) {
    if (existsSync(stateFilePath(dir))) {
      // A `.wiregraph` AT $HOME is honored ONLY when the caller is at $HOME itself
      // (someone who deliberately ran init on their home dir). Reached by walking UP
      // from a nested project, a $HOME index is treated as a stray that must not
      // hijack that project — it would point the graph at the wrong, enormous index;
      // the project gets the "run init" nudge instead. Any index BELOW home is always
      // honored (the normal workspace case).
      if (dir === home && start !== home) return null;
      return dir;
    }
    if (dir === home) return null;      // never resolve above $HOME
    const parent = dirname(dir);
    if (parent === dir) return null;    // reached the filesystem root
    dir = parent;
  }
}

// Per-write sequence counter, combined with the pid, to give each write a UNIQUE
// temp filename. Two concurrent writers (the long-lived MCP server vs. a detached
// refresh hook — the exact pair the H1 comment names) must not share one `.tmp`
// path, or the loser's rename hits a torn/absent file (spurious ENOENT). pid+counter
// is collision-free across processes and within a process, and deterministic (no
// Math.random/Date.now).
let writeSeq = 0;

export function writeState(project, state) {
  const p = stateFilePath(project);
  mkdirSync(dirname(p), { recursive: true });
  // Atomic write: serialize into a sibling UNIQUE temp file, then rename it over the
  // real path. rename(2) is atomic within one filesystem and .wiregraph/ is always
  // same-fs as its state.json, so a concurrent reader sees either the whole old file
  // or the whole new one — never a 0-byte or half-written state.json (the H1
  // data-loss bug). The temp name is unique per writer+write (pid + counter) so two
  // concurrent writers never collide on one temp file. A leftover unique .tmp from a
  // crashed prior write is harmless (it is never reused); we still best-effort rm it
  // if the rename throws so a failed write leaves no residue.
  const tmp = p + '.' + process.pid + '.' + (writeSeq++) + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  try {
    renameSync(tmp, p);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  return p;
}

// Merge updates into existing (or default) state and persist. Branches on load
// status so a CORRUPT read is never mistaken for an absent one and papered over with
// defaults (the H1 data-loss bug): a torn/partial state.json would otherwise merge the
// patch onto defaultState and overwrite the real file, permanently dropping links,
// posture, and the reposLastSha baseline.
//   - ok      → merge patch onto the loaded state.
//   - absent  → merge patch onto defaultState (a genuinely fresh project).
//   - corrupt → preserve the bytes by renaming the file aside to a non-clobbering
//               state.json.corrupt* backup, then throw. We do NOT write defaults over
//               it. Callers (hooks) are best-effort and swallow errors, so this fails
//               loudly in logs without crashing a session — while keeping the data.
export function updateState(project, patch, pluginVersion = null) {
  const { status, state } = loadState(project);
  if (status === 'corrupt') {
    const p = stateFilePath(project);
    const moved = quarantineCorrupt(p);
    throw new Error(
      moved
        ? `wiregraph: state.json at ${p} is corrupt (unparseable); moved aside to ${moved} to preserve it. ` +
          `Refusing to overwrite it with defaults. Investigate the backup, or delete it to let a fresh state be created.`
        : `wiregraph: state.json at ${p} is corrupt (unparseable) and could not be moved aside. ` +
          `Refusing to overwrite it with defaults. Investigate the file manually.`,
    );
  }
  const cur = status === 'ok' ? state : defaultState(project, pluginVersion);
  const next = { ...cur, ...patch };
  writeState(project, next);
  return next;
}

// Rename a corrupt state file aside to a `.corrupt` backup, never clobbering a prior
// one: if `<p>.corrupt` already exists, try `.corrupt.2`, `.corrupt.3`, … so earlier
// corrupt backups are preserved. Best-effort — returns the path it moved the file to,
// or null if even the rename failed (the throw still fires; the data may be lost only
// if the rename itself could not happen).
function quarantineCorrupt(p) {
  let target = p + '.corrupt';
  for (let n = 2; existsSync(target); n++) target = `${p}.corrupt.${n}`;
  try { renameSync(p, target); return target; } catch { return null; }
}

// --- global project registry ------------------------------------------------
// A machine-local list of every graph root a full build has stamped (so init/
// rebuild register; linking rebuilds both peers ⇒ both register). This is how
// /wiregraph-stats aggregates GLOBAL impact WITHOUT scanning the filesystem —
// deterministic, keyed off the actual init/link lifecycle. One JSON array of
// absolute roots at ~/.wiregraph-projects.json (a plain dotfile, NOT a `.wiregraph`
// dir, so it can't be mistaken for a $HOME index). Pruned by /wiregraph-remove and
// lazily when a listed root no longer exists.
export function registryPath(home = homedir()) {
  return process.env.WIREGRAPH_REGISTRY || join(home, '.wiregraph-projects.json');
}

export function readRegistry() {
  try {
    const raw = JSON.parse(readFileSync(registryPath(), 'utf8'));
    const roots = Array.isArray(raw) ? raw : (Array.isArray(raw?.projects) ? raw.projects : []);
    return [...new Set(roots.filter((r) => typeof r === 'string'))];
  } catch { return []; } // absent/corrupt registry ⇒ empty global view, never throws
}

function writeRegistry(roots) {
  try { writeFileSync(registryPath(), JSON.stringify([...new Set(roots)].sort(), null, 2) + '\n'); }
  catch { /* best-effort — the registry is a convenience index, not source of truth */ }
}

// Idempotent: add `root` (realpath'd) to the registry if absent. Best-effort — a
// failure here must never break a build.
export function registerProject(root) {
  let real = root; try { real = realpathSync(root); } catch { /* keep as given */ }
  const roots = readRegistry();
  if (!roots.includes(real)) writeRegistry([...roots, real]);
}

// Remove `root` from the registry (matches the realpath'd and the raw form).
export function deregisterProject(root) {
  let real = root; try { real = realpathSync(root); } catch { /* keep as given */ }
  const roots = readRegistry();
  const next = roots.filter((r) => r !== real && r !== root);
  if (next.length !== roots.length) writeRegistry(next);
}

// --- former-links history (tombstone) ----------------------------------------
// When links are torn down (unlink / hard-remove), remember the peer roots keyed by
// the graph's OWN root, so a later /wiregraph-init of that root can offer to re-
// establish them. Lives in $HOME (survives the .wiregraph deletion a remove does).
// Test-isolable via WIREGRAPH_LINKS_HISTORY, mirroring WIREGRAPH_REGISTRY.
export function linksHistoryPath(home = homedir()) {
  return process.env.WIREGRAPH_LINKS_HISTORY || join(home, '.wiregraph-links-history.json');
}

function readLinksHistoryRaw() {
  try {
    const o = JSON.parse(readFileSync(linksHistoryPath(), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; } // absent/corrupt ⇒ no memory, never throws
}

function writeLinksHistory(map) {
  try { writeFileSync(linksHistoryPath(), JSON.stringify(map, null, 2) + '\n'); }
  catch { /* best-effort — a lost tombstone just means no re-link offer */ }
}

// Merge peer roots into `root`'s tombstone (realpath'd, deduped, self excluded).
export function recordFormerLinks(root, peers) {
  const real = realpathish(root);
  const list = (Array.isArray(peers) ? peers : [peers]).map(realpathish).filter((p) => p && p !== real);
  if (!list.length) return;
  const map = readLinksHistoryRaw();
  const cur = new Set(Array.isArray(map[real]) ? map[real] : []);
  for (const p of list) cur.add(p);
  map[real] = [...cur];
  writeLinksHistory(map);
}

// The peer roots remembered for `root` (does not clear).
export function formerLinks(root) {
  const map = readLinksHistoryRaw();
  const real = realpathish(root);
  const list = map[real] || map[root] || [];
  return Array.isArray(list) ? [...list] : [];
}

// Clear `root`'s tombstone — init consumes it once it has offered re-establishment,
// so a future init doesn't keep re-prompting.
export function forgetFormerLinks(root) {
  const map = readLinksHistoryRaw();
  const real = realpathish(root);
  let changed = false;
  for (const k of [real, root]) if (k in map) { delete map[k]; changed = true; }
  if (changed) writeLinksHistory(map);
}

// --- CLI (used by /wiregraph-init to seed/refresh the state after a full build,
//     and by /wiregraph-status as a quick reader) -----------------------------
async function main(argv) {
  const [cmd, projectArg, extra] = argv;
  if (!cmd || !projectArg) {
    process.stderr.write('usage: state.mjs <seed|show|check|posture|gitignore> <project> [posture-value]\n');
    process.exit(2);
  }
  let project = projectArg;
  try { project = realpathSync(projectArg); } catch { /* keep as-is */ }

  if (cmd === 'seed') {
    // Seed/refresh after a full build: set lastFullBuild + current per-repo shas,
    // keep any existing posture (default balanced). Also create .wiregraph/ and
    // make sure it's gitignored — the standard init footprint.
    const { projectRepos } = await import('./git.mjs');
    const newShas = {};
    for (const r of projectRepos(project)) if (r.head) newShas[r.root] = r.head;
    const next = updateState(project, { lastFullBuild: new Date().toISOString(), reposLastSha: newShas });
    const gi = ensureGitignore(project);
    process.stdout.write(`Seeded ${stateFilePath(project)} (posture: ${next.autoUpdate}, ${Object.keys(newShas).length} repos).\n`);
    process.stdout.write(`.gitignore: ${gi === 'added' ? 'added .wiregraph/' : gi === 'present' ? '.wiregraph/ already ignored' : 'no .git here — skipped'}.\n`);
    return;
  }
  if (cmd === 'gitignore') {
    const gi = ensureGitignore(project);
    process.stdout.write(`.gitignore: ${gi === 'added' ? 'added .wiregraph/' : gi === 'present' ? 'already ignored' : 'no .git here — skipped'}.\n`);
    return;
  }
  if (cmd === 'show') {
    const s = readState(project);
    process.stdout.write(s ? JSON.stringify(s, null, 2) + '\n' : `No state at ${stateFilePath(project)}.\n`);
    return;
  }
  if (cmd === 'check') {
    // Reroute helper for /wiregraph-init: is <project> (or an ancestor) already
    // indexed? Prints parse-friendly lines so the command can choose fresh-init
    // vs reroute-to-rebuild instead of blindly re-running the whole setup.
    const root = findIndexedRoot(project);
    if (!root) { process.stdout.write('indexed: no\n'); return; }
    const s = readState(root) || {};
    const repoCount = s.reposLastSha ? Object.keys(s.reposLastSha).length : 0;
    // state.json can exist without a graph.db (a build that failed after seed, or a
    // manually deleted db). Report the db explicitly so init reroutes to a rebuild
    // instead of assuming a queryable graph — otherwise SessionStart says "fresh"
    // while every MCP tool returns NOT_BUILT.
    const dbPresent = existsSync(join(wiregraphDir(root), 'graph.db'));
    process.stdout.write('indexed: yes\n');
    process.stdout.write(`root: ${root}\n`);
    process.stdout.write(`sameDir: ${root === project ? 'yes' : 'no'}\n`);
    process.stdout.write(`db: ${dbPresent ? 'present' : 'missing'}\n`);
    process.stdout.write(`lastFullBuild: ${s.lastFullBuild || 'unknown'}\n`);
    process.stdout.write(`repos: ${repoCount}\n`);
    return;
  }
  if (cmd === 'posture') {
    if (!POSTURES.includes(extra)) { process.stderr.write(`posture must be one of: ${POSTURES.join(', ')}\n`); process.exit(2); }
    updateState(project, { autoUpdate: extra });
    process.stdout.write(`Set autoUpdate posture to "${extra}" for ${project}.\n`);
    return;
  }
  process.stderr.write(`unknown command: ${cmd}\n`);
  process.exit(2);
}

const isCli = process.argv[1] && process.argv[1].endsWith('state.mjs');
if (isCli) main(process.argv.slice(2));
