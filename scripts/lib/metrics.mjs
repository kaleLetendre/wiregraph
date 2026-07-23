// Local, append-only impact metrics for wiregraph. One JSON line per event to
// <project>/.wiregraph/metrics.jsonl, so /wiregraph-status can show real usage
// and an estimate of the tokens the graph saved. Everything stays local (the file
// lives under the gitignored .wiregraph/ dir) — consistent with wiregraph never
// uploading anything.
//
// HONESTY — "tokens saved" is a COUNTERFACTUAL, never billed tokens. You can't
// observe both what happened (used get_source) and what would have happened (Read
// the whole file) for the same action, so every number here is an estimate under
// a stated assumption, on a chars/DIV token proxy:
//   - get_source saving: returned body vs the whole file you'd otherwise Read.
//     Clean counterfactual — that IS get_source's job.
//   - trace facts: node count + returned tokens are exact; any "saved" figure is
//     MODELED (assumed grep+confirm per node) and labeled as such, never merged
//     into the get_source total.
//   - adoption gap: a grep whose pattern is a name the graph already knows —
//     get_source/find_symbol would have answered. Measures leakage, the actual
//     "wiregraph isn't being used" complaint.
//
// CRITICAL: this module must stay cheap to IMPORT — the PreToolUse hook imports it
// on every grep. So it must NOT statically import the sql.js-backed store
// (src/store/sqlite.js does a top-level `await initSqlJs` + loads the whole db
// into memory). Only summarize() touches the db, via a dynamic import, on demand.
//
// Library + thin CLI:
//   node scripts/lib/metrics.mjs summary <project> [--session <id>]

import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync, renameSync, realpathSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readState, updateState, wiregraphDir, findIndexedRoot, METRICS_VERSION, readRegistry, deregisterProject } from './state.mjs';
import { colorEnabled } from './color.mjs';
import { block } from './claudemd.mjs';

// Approximate chars-per-token for source code. Good for trend/relative tracking,
// not for billing. Configurable here if we ever calibrate against a tokenizer.
const DIV = 3.5;
// Rotate the log once it grows past this so it can't accumulate forever; the
// headline is a recent-activity view, so dropping rotated history is fine.
const ROTATE_BYTES = 5 * 1024 * 1024;
// Modeled cost of reconstructing one trace node by hand (a grep + a confirming
// read). Stated as an assumption wherever it is used — never a precise number.
const ASSUMED_PER_NODE_TOKENS = 120;
// wiregraph's own recurring context tax, carried EVERY turn regardless of savings:
// the CLAUDE.md directive (measured live from the installed block) plus the MCP
// tool schemas the client keeps in context. The savings above are GROSS; a session
// only nets positive once cumulative savings exceed this tax × turns. Honesty
// demands showing it — the old dashboard counted only the win side.
const TOOL_SCHEMA_TOKENS = 720; // ~10 tool defs + params, est. chars/DIV
function contextTaxPerTurn() { return estTokens(block()) + TOOL_SCHEMA_TOKENS; }

// --- recurring-context model (the compounding session win) -----------------
// The headline counts each avoided read ONCE, but context the graph kept out of the
// prompt would otherwise ride EVERY following turn until compaction. With prompt
// caching a resident block re-bills at ~10% of the input rate per turn, so a block
// carried across N turns costs ~1 + 0.1·(N−1) times its size. We surface the recurring
// saving as a range over a typical read-residency window (~20–50 follow-up turns).
// A clearly-labeled model, not a measurement.
const CACHE_READ_FRACTION = 0.1;   // cached input ≈ 10% of the full input rate
const RESIDENCY_TURNS_LO = 20;
const RESIDENCY_TURNS_HI = 50;
const recurMult = (turns) => 1 + CACHE_READ_FRACTION * (turns - 1);

export function estTokens(s) {
  if (!s) return 0;
  return Math.ceil(String(s).length / DIV);
}

export function metricsPath(project) {
  return join(wiregraphDir(project), 'metrics.jsonl');
}

// Record only on an active posture (reuse the existing opt-out: 'off' or no state
// means the user turned wiregraph off), with a hard env kill-switch.
function enabled(project) {
  if (process.env.WIREGRAPH_METRICS === '0') return false;
  const state = readState(project);
  return !!state && state.autoUpdate !== 'off';
}

function rotateIfBig(p) {
  try { if (statSync(p).size > ROTATE_BYTES) renameSync(p, p + '.1'); }
  catch { /* missing file or rotate failed — ignore */ }
}

// Append one event. BEST-EFFORT: never throws into the caller — a tool call or a
// hook must not fail because metrics couldn't be written.
export function record(project, event) {
  try {
    if (!enabled(project)) return;
    const p = metricsPath(project);
    mkdirSync(dirname(p), { recursive: true });
    rotateIfBig(p);
    appendFileSync(p, JSON.stringify({ t: Date.now(), ...event }) + '\n'); // O_APPEND ⇒ atomic per line
  } catch { /* metrics are best-effort */ }
}

// Pre-v2 metrics migration. Before turn/boundary tracking (v2) existed, metrics.jsonl
// held only reads with no turns/boundaries; mixing those pre-v2 reads with new turns
// would misstate the MEASURED recurring-context figure (a pre-v2 read has no following
// turns, so it should score ~0 recurring — but only if it isn't sharing a global
// timeline with new sessions' turns). So on upgrading to METRICS_VERSION, a project's
// pre-v2 log is ARCHIVED (never deleted) and the measured log restarts clean.
//
// Runs automatically for EVERY user on update — it is wired into every natural
// post-update entry point (SessionStart, runBuild, summarize) and self-applies from
// whichever the user reaches first. Contract:
//   • VERSION-GATED — runs exactly ONCE per project (metricsVersion < METRICS_VERSION).
//   • IDEMPOTENT — a second call from any entry point is a no-op (version now current).
//   • BEST-EFFORT — never throws; a failed migration must not break a session/build/report.
//   • NON-CLOBBERING — an existing archive is never overwritten (unique suffix chosen);
//     data is retained forever. summarize() reads ONLY the live metrics.jsonl, never the archive.
export function migrateMetrics(project) {
  try {
    const state = readState(project);
    // No state ⇒ not an indexed project (or a fresh init before its state is seeded):
    // nothing to migrate, and we must NOT plant a state.json in an unindexed dir. A
    // brand-new project created by THIS version already carries metricsVersion (defaultState).
    if (!state) return;
    const cur = typeof state.metricsVersion === 'number' ? state.metricsVersion : 0;
    if (cur >= METRICS_VERSION) return; // already current — idempotent no-op

    const p = metricsPath(project);
    if (existsSync(p)) {
      const dir = dirname(p);
      let dest = join(dir, 'metrics.v1.jsonl');
      // Non-clobbering: if an archive already exists, pick a unique suffix rather than
      // overwrite it — never destroy previously-archived data.
      for (let i = 2; existsSync(dest); i++) dest = join(dir, `metrics.v1.${i}.jsonl`);
      renameSync(p, dest);
    }
    // Stamp the version even when there was no log to archive, so this never re-runs.
    updateState(project, { metricsVersion: METRICS_VERSION });
  } catch { /* best-effort: a failed migration must never break anything */ }
}

// Aggregate the current log into a rollup. ASYNC because classifying the grep gap
// needs the graph db, which we open exactly once here (on demand) via a dynamic
// import — so importing this module never pulls in sql.js.
export async function summarize(project, { sessionId = null, migrate = true } = {}) {
  // Self-apply the pre-v2 migration on the bare /wiregraph-stats path too — one of the
  // natural post-update entry points, so a user who reaches a report first still gets a
  // clean measured log. summarize otherwise stays read-only; this is the sole mutating
  // exception, and it is safe because migrateMetrics is version-gated + idempotent +
  // best-effort (a no-op once the version is current). GLOBAL aggregation passes
  // migrate:false so a stats run never mutates every project on the machine.
  if (migrate) { try { migrateMetrics(project); } catch { /* best-effort */ } }

  const agg = {
    events: 0,
    getSourceCalls: 0, savedTokens: 0, gsFileTokens: 0, gsReturnedTokens: 0,
    traceCalls: 0, traceNodes: 0, traceReturnedTokens: 0,
    otherUses: 0,
    grepTotal: 0, gapCount: 0, gapTokens: 0,
    // measured recurring-context (populated below from turn/boundary events):
    turns: 0, boundaries: 0, measuredCoverage: false, recurringMeasured: 0,
    // true when a pre-v2 archive (metrics.v1*.jsonl) exists — a dim dashboard footer
    // notes it. summarize reads ONLY the live log; the archive is never counted.
    preV2Archived: false,
  };
  try { agg.preV2Archived = readdirSync(wiregraphDir(project)).some((f) => /^metrics\.v1(?:\.\d+)?\.jsonl$/.test(f)); }
  catch { /* dir missing — leave false */ }
  const p = metricsPath(project);
  if (!existsSync(p)) return agg;
  let raw;
  try { raw = readFileSync(p, 'utf8'); } catch { return agg; }

  const grepPatterns = []; // bare-identifier grep patterns, classified against the graph below
  const gsUses = [];       // { t, sessionId, saved } — one per get_source read, for residency
  const turnEvents = [];   // { t, sessionId } — one per user prompt (UserPromptSubmit hook)
  const boundaryEvents = []; // { t, sessionId } — context drops (compaction / clear)
  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue;
    let e; try { e = JSON.parse(ln); } catch { continue; }
    if (sessionId && e.sessionId !== sessionId) continue;
    agg.events++;
    if (e.kind === 'use') {
      if (e.tool === 'get_source') {
        agg.getSourceCalls++;
        agg.savedTokens += e.savedTokens || 0;
        agg.gsFileTokens += e.fileTokens || 0;        // what a full Read would have cost
        agg.gsReturnedTokens += e.returnedTokens || 0; // what get_source actually returned
        gsUses.push({ t: e.t, sessionId: e.sessionId ?? null, saved: e.savedTokens || 0 });
      }
      else if (e.tool === 'trace_callers' || e.tool === 'trace_callees') {
        agg.traceCalls++; agg.traceNodes += e.nodes || 0; agg.traceReturnedTokens += e.returnedTokens || 0;
      } else agg.otherUses++;
    } else if (e.kind === 'grep') {
      agg.grepTotal++;
      if (typeof e.pattern === 'string' && /^[A-Za-z_]\w*$/.test(e.pattern)) grepPatterns.push(e.pattern);
    } else if (e.kind === 'turn') {
      turnEvents.push({ t: e.t, sessionId: e.sessionId ?? null });
    } else if (e.kind === 'boundary') {
      boundaryEvents.push({ t: e.t, sessionId: e.sessionId ?? null });
    }
  }

  // MEASURED recurring context. Each get_source read kept ~saved tokens out of the
  // prompt; those tokens would otherwise ride EVERY following turn until the context
  // is dropped (a compaction or /clear boundary). So the real recurring saving per
  // read = saved × (1 + CACHE_READ_FRACTION × turnsUntilNextBoundary), where the turn
  // count is MEASURED from logged events instead of assumed. Only the ~10%/turn cache
  // rate stays a modeled constant. All correlation happens HERE, at report time.
  agg.turns = turnEvents.length;
  agg.boundaries = boundaryEvents.length;
  agg.measuredCoverage = agg.turns > 0; // any turn data at all ⇒ we can measure
  if (agg.measuredCoverage) {
    // Precise correlation is by sessionId; but graph 'use' events can carry a null
    // sessionId (a long-lived MCP server may not see CLAUDE_SESSION_ID) while turns
    // do carry the real hook id. So: prefer the read's own session when that session
    // logged turns, else fall back to a single GLOBAL timeline over the local log.
    const bySession = new Map(); // sid -> { turns:[t...], boundaries:[t...] }
    const globalTurns = [], globalBoundaries = [];
    const bucket = (sid) => { if (!bySession.has(sid)) bySession.set(sid, { turns: [], boundaries: [] }); return bySession.get(sid); };
    for (const e of turnEvents) { globalTurns.push(e.t); bucket(e.sessionId).turns.push(e.t); }
    for (const e of boundaryEvents) { globalBoundaries.push(e.t); bucket(e.sessionId).boundaries.push(e.t); }
    const asc = (a, b) => a - b;
    globalTurns.sort(asc); globalBoundaries.sort(asc);
    for (const s of bySession.values()) { s.turns.sort(asc); s.boundaries.sort(asc); }

    for (const u of gsUses) {
      const s = u.sessionId != null ? bySession.get(u.sessionId) : null;
      const turns = s && s.turns.length ? s.turns : globalTurns;
      const boundaries = s && s.turns.length ? s.boundaries : globalBoundaries;
      let nextBoundary = Infinity;                 // nearest boundary strictly after the read
      for (const bt of boundaries) { if (bt > u.t) { nextBoundary = bt; break; } } // sorted asc
      let residency = 0;                           // turns living between the read and that boundary
      for (const tt of turns) { if (tt > u.t && tt < nextBoundary) residency++; }
      agg.recurringMeasured += u.saved * (1 + CACHE_READ_FRACTION * residency);
    }
  }

  // The adoption gap: which bare-identifier greps searched for a KNOWN symbol?
  // Open the db ONCE here, never on the hot hook path.
  if (grepPatterns.length) {
    try {
      const { connect } = await import('../../src/store/sqlite.js');
      const dbp = join(wiregraphDir(project), 'graph.db');
      if (existsSync(dbp)) {
        const db = connect(dbp, { readonly: true });
        try {
          const roots = new Map();         // compartment name -> root path
          for (const r of db.prepare('SELECT name,root FROM compartments WHERE project=?').all(project)) roots.set(r.name, r.root);
          const byName = new Map();        // symbol name -> {file, root}
          for (const s of db.prepare("SELECT name, file, compartment FROM symbols WHERE project=? AND kind <> 'module'").all(project)) {
            if (!byName.has(s.name)) byName.set(s.name, { file: s.file, root: roots.get(s.compartment) });
          }
          const fileTok = new Map();
          let reads = 0;
          for (const pat of grepPatterns) {
            const hit = byName.get(pat);
            if (!hit) continue;
            agg.gapCount++;
            if (!hit.root) continue;
            const abs = join(hit.root, hit.file);
            if (fileTok.has(abs)) { agg.gapTokens += fileTok.get(abs); continue; }
            if (reads >= 200) continue;    // cap file I/O — the gap COUNT is the real signal
            reads++;
            let tk = 0;
            try { tk = estTokens(readFileSync(abs, 'utf8')); } catch { /* file gone */ }
            fileTok.set(abs, tk);
            agg.gapTokens += tk;
          }
        } finally { db.close(); }
      }
    } catch { /* classification is best-effort */ }
  }
  return agg;
}

export function formatSummary(agg) {
  if (!agg.events) return 'No wiregraph metrics recorded yet.';
  const usedTotal = agg.getSourceCalls + agg.traceCalls + agg.otherUses;
  const modeled = agg.traceNodes * ASSUMED_PER_NODE_TOKENS;
  return [
    `wiregraph measured impact — LOCAL ESTIMATE (counterfactual, not billed tokens; chars/${DIV} proxy):`,
    ``,
    `  Graph-tool calls: ${usedTotal}`,
    `  • get_source: ${agg.getSourceCalls} call(s) → est. ~${agg.savedTokens} tokens saved`,
    `      vs Reading the whole file (clean counterfactual — that is get_source's job).`,
    `  • traces: ${agg.traceCalls} call(s) covering ${agg.traceNodes} node(s) one-shot (~${agg.traceReturnedTokens} tokens returned)`,
    `      MODELED saving ~${modeled} tokens (assumes ${ASSUMED_PER_NODE_TOKENS} tok/node if walked by hand) — soft, not added above.`,
    `  • other graph tools: ${agg.otherUses} call(s)`,
    ``,
    `  Adoption gap: ${agg.gapCount} of ${agg.grepTotal} grep(s) searched for a KNOWN symbol`,
    `      (get_source/find_symbol would have answered directly; ~${agg.gapTokens} tokens of files opened the slow way).`,
  ].join('\n');
}

// --- dashboard report (deterministic; the /wiregraph-stats output) ----------
// A self-contained, usage-page-style rollup. The command that calls this prints
// it VERBATIM — all the framing/explanation lives here, not in agent prose.
function fmt(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function fmtM(n) { return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : fmt(n); }
// Compact magnitude for the dashboard: 1.9M / 277K / 1.6K / 940. K keeps one
// decimal below 10 (1.6K) and rounds at/above it (277K), so the numbers stay short.
function fmtK(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) { const k = n / 1e3; return `${k >= 10 ? Math.round(k) : k.toFixed(1)}K`; }
  return fmt(n);
}
function bar(v, max, width, paint = (s) => s) {
  if (!(max > 0)) return '░'.repeat(width);
  const f = Math.max(0, Math.min(width, Math.round((v / max) * width)));
  return paint('█'.repeat(f)) + '░'.repeat(width - f);
}

// ANSI palette for the dashboard. Every paint fn is IDENTITY when color is off
// (NO_COLOR or --no-color), so the plain text stays byte-identical. Color is ON by
// default: Claude Code and terminals both render ANSI in command output, so the
// dashboard shows in color in the /wiregraph-stats relay too, not only a raw TTY.
const A = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
function palette(on) {
  const w = (codes) => (on ? (s) => codes + s + A.reset : (s) => s);
  return {
    border: w(A.cyan), title: w(A.bold + A.cyan), head: w(A.bold + A.cyan),
    saved: w(A.bold + A.green),
    cost: w(A.red), good: w(A.green), num: w(A.bold), dim: w(A.dim),
  };
}

export function formatReport(agg, project, { color = false } = {}) {
  const C = palette(color);
  const name = project ? (project.split('/').filter(Boolean).pop() || '') : '';
  const W = 70;
  const top = C.border('╭' + '─'.repeat(W) + '╮');
  const bot = C.border('╰' + '─'.repeat(W) + '╯');
  const titleText = `  wiregraph · measured impact${name ? ' · ' + name : ''}`;
  const head = C.border('│') + C.title((titleText + ' '.repeat(W)).slice(0, W)) + C.border('│');

  if (!agg.events) {
    return [top, head, bot, '',
      C.dim('   No activity recorded yet — numbers accrue once Claude uses the graph'),
      C.dim('   tools (get_source, trace_*) in this project.')].join('\n');
  }

  const used = agg.getSourceCalls + agg.traceCalls + agg.otherUses;
  const oldWay = agg.gsFileTokens;        // what full Reads would have cost
  const newWay = agg.gsReturnedTokens;    // what get_source returned instead
  const saved = agg.savedTokens;
  const pct = oldWay > 0 ? Math.round((saved / oldWay) * 100) : 0;
  const modeled = agg.traceNodes * ASSUMED_PER_NODE_TOKENS;
  const BW = 24;

  const cachePct = Math.round(CACHE_READ_FRACTION * 100);
  const tax = contextTaxPerTurn();
  const L = [top, head, bot, ''];

  // Headline: one-time saving, then the measured compounding factor beneath it.
  // (saved is an UPPER BOUND — whole-file minus returned tokens, a chars÷DIV proxy.)
  const scope = agg.measuredCoverage ? 'measured' : 'estimated';
  L.push(`   ${C.head('TOKENS SAVED')}  ${C.saved('~' + fmtK(saved))}    ${C.dim(scope + ' · this project only')}`);
  L.push(`     ${C.dim('per read:')} ~${fmtK(oldWay)} whole-file → ~${fmtK(newWay)} returned  ${C.dim(`(${pct}% leaner ×${agg.getSourceCalls})`)}`);
  L.push(`       ${bar(oldWay, oldWay, BW, C.cost)}  ${C.dim('whole-file')}`);
  L.push(`       ${bar(newWay, oldWay, BW, C.good)}  ${C.dim('wiregraph')}`);
  if (agg.measuredCoverage) {
    // MEASURED residency: recurring / one-time is the effective compounding factor,
    // bounded by real turn/boundary events — no assumed window. ×1.0 = no residency.
    const mult = saved > 0 ? agg.recurringMeasured / saved : 1;
    L.push(`     ${C.dim('+ compounding while resident:')} ${C.saved('×' + mult.toFixed(1))} ${C.dim('this window')}`);
    L.push(`       ${C.dim(`(${agg.turns} turns · ${agg.boundaries} boundaries · ~${cachePct}%/turn cache)`)}`);
  } else {
    // FALLBACK (pre-measurement logs / no turn events yet): the modeled range.
    const lo = recurMult(RESIDENCY_TURNS_LO), hi = recurMult(RESIDENCY_TURNS_HI);
    L.push(`     ${C.dim('+ compounding (estimated):')} ${C.saved(`×${lo.toFixed(1)}–${hi.toFixed(1)}`)} ${C.dim(`over a ${RESIDENCY_TURNS_LO}–${RESIDENCY_TURNS_HI}-turn residency`)}`);
  }
  L.push('');

  // Calls · adoption · the per-turn context tax (shown, never netted from the headline).
  const traceNote = agg.traceNodes ? ` ${C.dim(`· traces ~${fmtK(modeled)} modeled`)}` : '';
  L.push(`   ${C.dim('calls')} (${used}): ${agg.getSourceCalls} get_source · ${agg.traceCalls} trace · ${agg.otherUses} other${traceNote}`);
  L.push(`   ${C.dim(`adoption: ${agg.gapCount}/${agg.grepTotal} grep gaps · tax not netted ~${fmtK(tax)}/turn`)}`);
  L.push('');

  // Where the log lives.
  const archived = agg.preV2Archived ? ' · pre-v2 archived (not counted)' : '';
  if (project) {
    L.push(`   ${C.dim('log:')} ${C.dim(metricsPath(project))}`);
    L.push(`        ${C.dim(`${agg.events} events · local${archived}`)}`);
  } else {
    L.push(`   ${C.dim(`${agg.events} events · local${archived}`)}`);
  }
  return L.join('\n');
}

// --- global aggregation ------------------------------------------------------
// Sum a list of per-project aggs into one machine-wide agg. Everything is additive;
// measuredCoverage / preV2Archived are OR-ed (any project measured ⇒ the total shows
// its measured compounding).
const SUM_FIELDS = ['events', 'getSourceCalls', 'traceCalls', 'otherUses', 'traceNodes',
  'gsFileTokens', 'gsReturnedTokens', 'savedTokens', 'turns', 'boundaries',
  'recurringMeasured', 'gapCount', 'grepTotal', 'gapTokens'];
function sumAggs(aggs) {
  const t = Object.fromEntries(SUM_FIELDS.map((k) => [k, 0]));
  t.measuredCoverage = false; t.preV2Archived = false;
  for (const a of aggs) {
    for (const k of SUM_FIELDS) t[k] += a[k] || 0;
    t.measuredCoverage = t.measuredCoverage || !!a.measuredCoverage;
    t.preV2Archived = t.preV2Archived || !!a.preV2Archived;
  }
  return t;
}

// Aggregate the given graph roots READ-ONLY (migrate:false — a stats run must never
// mutate every project). Returns per-project rows that have activity (sorted biggest
// saver first) and the summed total.
export async function summarizeAll(roots, { sessionId = null } = {}) {
  const perProject = [];
  for (const root of roots) {
    const agg = await summarize(root, { sessionId, migrate: false });
    if (agg.events) perProject.push({ root, name: root.split('/').filter(Boolean).pop() || root, agg });
  }
  perProject.sort((a, b) => b.agg.savedTokens - a.agg.savedTokens);
  return { perProject, total: sumAggs(perProject.map((p) => p.agg)) };
}

// Resolve the global set of graph roots from the REGISTRY (never a filesystem scan):
// every root a full build stamped, minus any that no longer exist on disk (pruned
// lazily here so a deleted-without-remove project stops counting). Returns live roots.
export function globalRoots() {
  const listed = readRegistry();
  const live = listed.filter((r) => existsSync(join(wiregraphDir(r), 'metrics.jsonl')));
  for (const r of listed) if (!existsSync(r)) { try { deregisterProject(r); } catch { /* best-effort */ } }
  return live;
}

// Global dashboard — the /wiregraph-stats default. Totals + a per-project breakdown.
export function formatGlobalReport({ perProject, total }, { color = false } = {}) {
  const C = palette(color);
  const W = 70;
  const top = C.border('╭' + '─'.repeat(W) + '╮');
  const bot = C.border('╰' + '─'.repeat(W) + '╯');
  const n = perProject.length;
  const titleText = `  wiregraph · global impact · ${n} project${n === 1 ? '' : 's'}`;
  const head = C.border('│') + C.title((titleText + ' '.repeat(W)).slice(0, W)) + C.border('│');

  if (!n) {
    return [top, head, bot, '',
      C.dim('   No measured activity across your indexed projects yet — numbers accrue'),
      C.dim('   once Claude uses the graph tools. /wiregraph-stats-local reports just'),
      C.dim('   the current project; /wiregraph-init indexes a new one.')].join('\n');
  }

  const t = total;
  const scope = t.measuredCoverage ? 'measured' : 'estimated';
  const used = t.getSourceCalls + t.traceCalls + t.otherUses;
  const oldWay = t.gsFileTokens, newWay = t.gsReturnedTokens;
  const pct = oldWay > 0 ? Math.round((t.savedTokens / oldWay) * 100) : 0;
  const BW = 24;
  const L = [top, head, bot, ''];
  L.push(`   ${C.head('TOKENS SAVED')}  ${C.saved('~' + fmtK(t.savedTokens))}    ${C.dim(scope + ' · across your machine')}`);
  L.push(`     ~${fmtK(oldWay)} whole-file → ~${fmtK(newWay)} returned  ${C.dim(`(${pct}% leaner · ${t.getSourceCalls} reads)`)}`);
  L.push(`       ${bar(oldWay, oldWay, BW, C.cost)}  ${C.dim('whole-file')}`);
  L.push(`       ${bar(newWay, oldWay, BW, C.good)}  ${C.dim('wiregraph')}`);
  if (t.measuredCoverage && t.savedTokens > 0) {
    const mult = t.recurringMeasured / t.savedTokens;
    L.push(`     ${C.dim('+ compounding while resident:')} ${C.saved('×' + mult.toFixed(1))} ${C.dim(`(${t.turns} turns · ${t.boundaries} boundaries)`)}`);
  }
  L.push(`   ${C.dim('calls')} (${used}): ${t.getSourceCalls} get_source · ${t.traceCalls} trace · ${t.otherUses} other`);
  L.push('');

  // Per-project breakdown with a bar sized to each project's SHARE of the machine
  // total, so the dominant saver is obvious at a glance.
  L.push(`   ${C.head('by project')} ${C.dim('(share of total saved)')}`);
  const nameW = Math.min(20, Math.max(...perProject.map((p) => p.name.length)));
  const PW = 22;
  for (const p of perProject) {
    const a = p.agg;
    const calls = a.getSourceCalls + a.traceCalls + a.otherUses;
    const share = t.savedTokens > 0 ? Math.round((a.savedTokens / t.savedTokens) * 100) : 0;
    L.push(`     ${p.name.padEnd(nameW)} ${('~' + fmtK(a.savedTokens)).padStart(7)}  ${bar(a.savedTokens, t.savedTokens, PW, C.good)} ${C.dim(String(share).padStart(3) + '%')}  ${C.dim(`${calls} call${calls === 1 ? '' : 's'}`)}`);
  }
  L.push('');
  L.push(`   ${C.dim(`${n} project(s) · ${t.events} events · local · never uploaded`)}`);
  L.push(`   ${C.dim('/wiregraph-stats-local for just the current project')}`);
  return L.join('\n');
}

// --- CLI --------------------------------------------------------------------
// Resolve the indexed workspace root so the command needs no path argument.
function resolveProject(arg) {
  const raw = arg || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return findIndexedRoot(raw) || (() => { try { return realpathSync(raw); } catch { return raw; } })();
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === 'global') {
    let sessionId = null;
    for (let i = 1; i < argv.length; i++) if (argv[i] === '--session') sessionId = argv[++i];
    const color = colorEnabled(argv.includes('--no-color'));
    const result = await summarizeAll(globalRoots(), { sessionId });
    process.stdout.write(formatGlobalReport(result, { color }) + '\n');
    return;
  }
  if (cmd !== 'report' && cmd !== 'summary') {
    process.stderr.write('usage: metrics.mjs <global|report|summary> [project] [--session <id>]\n');
    process.exit(2);
  }
  let projectArg = null, sessionId = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--session') sessionId = argv[++i];
    else if (argv[i].startsWith('--')) continue; // --color / --no-color, resolved below
    else if (!projectArg) projectArg = argv[i];
  }
  const color = colorEnabled(argv.includes('--no-color'));
  const project = resolveProject(projectArg);
  const agg = await summarize(project, { sessionId });
  process.stdout.write((cmd === 'report' ? formatReport(agg, project, { color }) : formatSummary(agg)) + '\n');
}

const isCli = process.argv[1] && process.argv[1].endsWith('metrics.mjs');
if (isCli) main(process.argv.slice(2));
