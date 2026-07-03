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

import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readState, wiregraphDir, findIndexedRoot } from './state.mjs';
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

// Aggregate the current log into a rollup. ASYNC because classifying the grep gap
// needs the graph db, which we open exactly once here (on demand) via a dynamic
// import — so importing this module never pulls in sql.js.
export async function summarize(project, { sessionId = null } = {}) {
  const agg = {
    events: 0,
    getSourceCalls: 0, savedTokens: 0, gsFileTokens: 0, gsReturnedTokens: 0,
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
      if (e.tool === 'get_source') {
        agg.getSourceCalls++;
        agg.savedTokens += e.savedTokens || 0;
        agg.gsFileTokens += e.fileTokens || 0;        // what a full Read would have cost
        agg.gsReturnedTokens += e.returnedTokens || 0; // what get_source actually returned
      }
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
      const dbp = join(wiregraphDir(project), 'graph.db');
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
function bar(v, max, width) {
  if (!(max > 0)) return '░'.repeat(width);
  const f = Math.max(0, Math.min(width, Math.round((v / max) * width)));
  return '█'.repeat(f) + '░'.repeat(width - f);
}

export function formatReport(agg, project) {
  const name = project ? (project.split('/').filter(Boolean).pop() || '') : '';
  const W = 70;
  const top = '╭' + '─'.repeat(W) + '╮';
  const bot = '╰' + '─'.repeat(W) + '╯';
  const titleText = `  wiregraph · measured impact${name ? ' · ' + name : ''}`;
  const head = '│' + (titleText + ' '.repeat(W)).slice(0, W) + '│';

  if (!agg.events) {
    return [top, head, bot, '',
      '   No activity recorded yet — numbers accrue once Claude uses the graph',
      '   tools (get_source, trace_*) in this project.'].join('\n');
  }

  const used = agg.getSourceCalls + agg.traceCalls + agg.otherUses;
  const oldWay = agg.gsFileTokens;        // what full Reads would have cost
  const newWay = agg.gsReturnedTokens;    // what get_source returned instead
  const saved = agg.savedTokens;
  const pct = oldWay > 0 ? Math.round((saved / oldWay) * 100) : 0;
  const modeled = agg.traceNodes * ASSUMED_PER_NODE_TOKENS;
  const BW = 24;
  const row = (label, n, b) => `     ${label.padEnd(31)}  ~${fmt(n).padStart(7)}  ${b}`;

  const L = [top, head, bot, ''];
  L.push(`   ESTIMATED TOKENS SAVED        ~${fmt(saved)}   (${pct}% vs whole-file reads — upper bound)`);
  L.push('');
  L.push('   get_source — read one symbol instead of the whole file');
  L.push(row('reading whole files would cost', oldWay, bar(oldWay, oldWay, BW)));
  L.push(row('wiregraph returned', newWay, bar(newWay, oldWay, BW)));
  L.push('');
  L.push(`   Graph-tool calls (${used})`);
  L.push(`     get_source   ${String(agg.getSourceCalls).padStart(4)}    saved ~${fmt(saved)}`);
  L.push(`     traces       ${String(agg.traceCalls).padStart(4)}    ${agg.traceNodes} node(s) · +~${fmt(modeled)} if walked by hand (modeled)`);
  L.push(`     other        ${String(agg.otherUses).padStart(4)}    find_symbol / path_between / trace_contract / query_sql`);
  L.push('');
  L.push('   Adoption gap');
  L.push(`     ${agg.gapCount} of ${agg.grepTotal} grep(s) searched for a symbol the graph already had`);
  if (agg.gapCount) L.push(`     (~${fmt(agg.gapTokens)} tokens of files opened the slow way — get_source would answer)`);
  L.push('');
  const tax = contextTaxPerTurn();
  L.push('   Context cost (the tax, every turn)');
  L.push(`     ~${fmt(tax)} tokens/turn carried regardless: CLAUDE.md directive + MCP`);
  L.push('     tool schemas. Savings above are GROSS — a session nets positive only');
  L.push(`     once cumulative savings clear this tax × turns (~${fmt(tax)} × turns).`);
  L.push('');
  L.push('   How this is projected');
  L.push('     • get_source saved = whole-file tokens − returned-symbol tokens. This is');
  L.push('       an UPPER BOUND — a targeted Read (offset/limit) would also skip some.');
  L.push(`     • traces are MODELED: a tree returned in one query vs. walking it by`);
  L.push(`       hand at ~${ASSUMED_PER_NODE_TOKENS} tok/node. Shown apart; never in the headline.`);
  L.push(`     • the context tax above is NOT subtracted from the headline — compare it`);
  L.push('       yourself against savings to judge whether the graph paid for itself.');
  L.push(`     • tokens ≈ chars ÷ ${DIV} (a proxy). Local estimate, not billed tokens.`);
  L.push('');
  L.push(`   ${agg.events} events · counterfactual estimate · never leaves your machine`);
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
  if (cmd !== 'report' && cmd !== 'summary') {
    process.stderr.write('usage: metrics.mjs <report|summary> [project] [--session <id>]\n');
    process.exit(2);
  }
  let projectArg = null, sessionId = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--session') sessionId = argv[++i];
    else if (!projectArg) projectArg = argv[i];
  }
  const project = resolveProject(projectArg);
  const agg = await summarize(project, { sessionId });
  process.stdout.write((cmd === 'report' ? formatReport(agg, project) : formatSummary(agg)) + '\n');
}

const isCli = process.argv[1] && process.argv[1].endsWith('metrics.mjs');
if (isCli) main(process.argv.slice(2));
