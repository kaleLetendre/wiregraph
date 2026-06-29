// Local, append-only impact metrics for codegraph. One JSON line per event to
// <project>/.codegraph/metrics.jsonl, so /codegraph-status can show real usage
// and an estimate of the tokens the graph saved. Everything stays local (the file
// lives under the gitignored .codegraph/ dir) — consistent with codegraph never
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
//     "codegraph isn't being used" complaint.
//
// CRITICAL: this module must stay cheap to IMPORT — the PreToolUse hook imports it
// on every grep. So it must NOT statically import the sql.js-backed store
// (src/store/sqlite.js does a top-level `await initSqlJs` + loads the whole db
// into memory). Only summarize() touches the db, via a dynamic import, on demand.
//
// Library + thin CLI:
//   node scripts/lib/metrics.mjs summary <project> [--session <id>]

import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readState, codegraphDir } from './state.mjs';

// Approximate chars-per-token for source code. Good for trend/relative tracking,
// not for billing. Configurable here if we ever calibrate against a tokenizer.
const DIV = 3.5;
// Rotate the log once it grows past this so it can't accumulate forever; the
// headline is a recent-activity view, so dropping rotated history is fine.
const ROTATE_BYTES = 5 * 1024 * 1024;
// Modeled cost of reconstructing one trace node by hand (a grep + a confirming
// read). Stated as an assumption wherever it is used — never a precise number.
const ASSUMED_PER_NODE_TOKENS = 120;

export function estTokens(s) {
  if (!s) return 0;
  return Math.ceil(String(s).length / DIV);
}

export function metricsPath(project) {
  return join(codegraphDir(project), 'metrics.jsonl');
}

// Record only on an active posture (reuse the existing opt-out: 'off' or no state
// means the user turned codegraph off), with a hard env kill-switch.
function enabled(project) {
  if (process.env.CODEGRAPH_METRICS === '0') return false;
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

// Aggregate the current log into a rollup. ASYNC because classifying the grep gap
// needs the graph db, which we open exactly once here (on demand) via a dynamic
// import — so importing this module never pulls in sql.js.
export async function summarize(project, { sessionId = null } = {}) {
  const agg = {
    events: 0,
    getSourceCalls: 0, savedTokens: 0,
    traceCalls: 0, traceNodes: 0, traceReturnedTokens: 0,
    otherUses: 0,
    grepTotal: 0, gapCount: 0, gapTokens: 0,
  };
  const p = metricsPath(project);
  if (!existsSync(p)) return agg;
  let raw;
  try { raw = readFileSync(p, 'utf8'); } catch { return agg; }

  const grepPatterns = []; // bare-identifier grep patterns, classified against the graph below
  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue;
    let e; try { e = JSON.parse(ln); } catch { continue; }
    if (sessionId && e.sessionId !== sessionId) continue;
    agg.events++;
    if (e.kind === 'use') {
      if (e.tool === 'get_source') { agg.getSourceCalls++; agg.savedTokens += e.savedTokens || 0; }
      else if (e.tool === 'trace_callers' || e.tool === 'trace_callees') {
        agg.traceCalls++; agg.traceNodes += e.nodes || 0; agg.traceReturnedTokens += e.returnedTokens || 0;
      } else agg.otherUses++;
    } else if (e.kind === 'grep') {
      agg.grepTotal++;
      if (typeof e.pattern === 'string' && /^[A-Za-z_]\w*$/.test(e.pattern)) grepPatterns.push(e.pattern);
    }
  }

  // The adoption gap: which bare-identifier greps searched for a KNOWN symbol?
  // Open the db ONCE here, never on the hot hook path.
  if (grepPatterns.length) {
    try {
      const { connect } = await import('../../src/store/sqlite.js');
      const dbp = join(codegraphDir(project), 'graph.db');
      if (existsSync(dbp)) {
        const db = connect(dbp, { readonly: true });
        try {
          const roots = new Map();         // repo name -> root path
          for (const r of db.prepare('SELECT name,root FROM repos WHERE project=?').all(project)) roots.set(r.name, r.root);
          const byName = new Map();        // symbol name -> {file, root}
          for (const s of db.prepare("SELECT name, file, repo FROM symbols WHERE project=? AND kind <> 'module'").all(project)) {
            if (!byName.has(s.name)) byName.set(s.name, { file: s.file, root: roots.get(s.repo) });
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
  if (!agg.events) return 'No codegraph metrics recorded yet.';
  const usedTotal = agg.getSourceCalls + agg.traceCalls + agg.otherUses;
  const modeled = agg.traceNodes * ASSUMED_PER_NODE_TOKENS;
  return [
    `codegraph measured impact — LOCAL ESTIMATE (counterfactual, not billed tokens; chars/${DIV} proxy):`,
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

// --- CLI --------------------------------------------------------------------
async function main(argv) {
  const [cmd, projectArg, ...rest] = argv;
  if (cmd !== 'summary' || !projectArg) {
    process.stderr.write('usage: metrics.mjs summary <project> [--session <id>]\n');
    process.exit(2);
  }
  let project = projectArg;
  try { project = realpathSync(projectArg); } catch { /* keep as-is */ }
  const si = rest.indexOf('--session');
  const sessionId = si !== -1 ? rest[si + 1] : null;
  const agg = await summarize(project, { sessionId });
  process.stdout.write(formatSummary(agg) + '\n');
}

const isCli = process.argv[1] && process.argv[1].endsWith('metrics.mjs');
if (isCli) main(process.argv.slice(2));
