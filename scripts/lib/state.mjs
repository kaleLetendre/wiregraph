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

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const POSTURES = ['off', 'conservative', 'balanced', 'aggressive'];
export const GITIGNORE_LINE = '.wiregraph/';

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
    // Stamped by the SessionStart hook each run. Absent on an indexed project ⇒
    // plugin hooks aren't firing (catch-up/nudges/re-index off); /wiregraph-status flags it.
    hooksLastFired: null,
  };
}

export function readState(project) {
  const p = stateFilePath(project);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
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
