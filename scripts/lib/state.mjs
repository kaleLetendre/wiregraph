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

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { join, dirname, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { findCompartmentRoots } from '../../src/extract/walk.js';
import { IGNORE_DIRS } from '../../src/extract/lang.js';

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
    // A BRAND-NEW project created by THIS version starts at the current metrics
    // version, so migrateMetrics never touches its (empty) log. A state written by an
    // OLDER version LACKS this field — normalizeState deliberately does NOT backfill it,
    // so a missing value is the signal that the pre-v2 log needs archiving.
    metricsVersion: METRICS_VERSION,
  };
}

export function readState(project) {
  const p = stateFilePath(project);
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'));
    // Own-root self-heal (§rename safety). The state file's LOCATION is the source of
    // truth for where this graph lives — `project` is just a cached copy. When a project
    // is renamed or moved, the stored `project` (and the indexedRoots derived from it)
    // point at the DEAD path; memberRoots then silently drops the missing own root, so
    // the next full build walks nothing and wipes the graph to 0. Rebind own-root to the
    // directory we actually read from. In-memory only — it persists on the next
    // updateState (same policy as normalizeState's indexedRoots re-derivation).
    if (s && typeof s === 'object') s.project = realpathish(project);
    return normalizeState(s);
  } catch {
    return null;
  }
}

// The exact advisory wording graph_status surfaces off the honesty flags, kept in
// one place so the MCP handler can't drift and a test can assert the surfacing
// without spinning up the stdio server.
export const STRUCTURAL_DRIFT_NOTE =
  'Note: symbols were added/removed/renamed since the last full build — some cross-file caller edges may be approximate. Run update_graph {full:true} (/wiregraph-rebuild) to reconcile.';
export const SEAM_STALE_NOTE =
  '⚠ a route may have changed since the last contract inference — run update_graph {full:true} (/wiregraph-rebuild) to re-infer the seams.';

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

// The graphs that must be updated when a file under member root M changes: M's own
// graph plus every graph linked to M. Because linking is symmetric, M's own
// state.links names every graph that linked M, so this is a complete, fully-local
// reverse index (§edit-sync). Returns project roots, M first.
export function graphsListing(memberRoot) {
  const out = [];
  const seen = new Set();
  const push = (p) => { const r = realpathish(p); if (r && !seen.has(r)) { seen.add(r); out.push(r); } };
  push(memberRoot);
  for (const l of members(memberRoot)) push(l.root);
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

export function writeState(project, state) {
  const p = stateFilePath(project);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
  return p;
}

// Merge updates into existing (or default) state and persist.
export function updateState(project, patch, pluginVersion = null) {
  const cur = readState(project) || defaultState(project, pluginVersion);
  const next = { ...cur, ...patch };
  writeState(project, next);
  return next;
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
