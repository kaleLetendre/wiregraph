// Managed CLAUDE.md directive block.
//
// The token win wiregraph delivers is gated on a behavioral directive that tells
// Claude to reach for the graph first and use it economically. A plugin cannot
// ship an always-on CLAUDE.md, so /wiregraph-init writes this block into the
// project's CLAUDE.md (consent-gated, idempotent: replace between the sentinels
// if present, else append). Teardown removes it. The prose below is the proven
// "economical" directive (validated across Experiments 5–10), adapted to call the
// registered MCP tools and to mention the auto-update path.
//
// Library + thin CLI:
//   node scripts/lib/claudemd.mjs diff   <project>   # show what would change
//   node scripts/lib/claudemd.mjs apply  <project>   # upsert the block
//   node scripts/lib/claudemd.mjs remove <project>   # strip the block (teardown)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BEGIN = '<!-- BEGIN wiregraph (managed) -->';
export const END = '<!-- END wiregraph -->';

// The directive body (between the sentinels).
const DIRECTIVE = `## Code navigation — use wiregraph first, economically

When locating or reading code in this project, prefer the **wiregraph** call-graph — its registered MCP tools — over grep/Read. It indexes every symbol and CALLS/REFERENCES edge across the project's repos. Call the MCP tools directly: \`find_symbol\` (locate a symbol); \`get_source\` (read one function's body — use instead of opening the whole file); \`trace_callers\`/\`trace_callees\`/\`path_between\` (call structure — these return the *whole* chain in one call, so don't walk it hop-by-hop); \`trace_contract\` (cross-repo wire seams); \`graph_stats\`/\`graph_status\` (size + freshness). Reach for the graph on any "where is X / what calls Y / how do these connect" question and before opening any file larger than ~200 lines. In a multi-repo workspace, cross-repo links flow through **contracts**: use \`trace_contract\`/\`path_between\`, and if a cross-repo wire question comes up with no contracts defined yet, tell the user to run \`/wiregraph-contracts\` to infer them from the code.

**Be economical:** plan a minimal set of queries, trust the result, and don't re-grep what the graph already showed — query count is the dominant token cost, not file reads. The static graph is **blind to (a) function-pointer/callback edges, (b) string literals** (JSON field names, route paths), and **(c) the C preprocessor** — it counts call sites inside \`#if 0\` / disabled \`#ifdef\` blocks, so a C refactor caller-list is an *upper bound*; verify compilation guards before trusting it. Reason about indirect call paths yourself (a callback adapter is its own distinct path), and for wire questions confirm the exact field/endpoint the server actually *reads* with a single targeted grep/get_source. Fall back to grep/Read only for those cases and non-code files.

These are the **registered wiregraph MCP tools**, not a CLI. **The graph self-heals on read:** every query re-indexes any file that changed on disk (yours or the user's, committed or not) before answering, so traces reflect the latest code — **do not fall back to grep on the assumption the graph is out of date.** Reach for \`update_graph full:true\` only after a large cross-file rename/refactor (the correctness backstop); \`graph_status\` reports freshness if you want to confirm. If the tools report the project isn't indexed, run \`/wiregraph-init\`.`;

export function block() {
  return `${BEGIN}\n${DIRECTIVE}\n${END}`;
}

export function targetPath(project) {
  return join(project, 'CLAUDE.md');
}

// Upsert the managed block into existing CLAUDE.md content.
export function withBlock(content) {
  const b = block();
  if (!content || !content.trim()) return b + '\n';
  const bi = content.indexOf(BEGIN);
  const ei = content.indexOf(END);
  if (bi !== -1 && ei !== -1 && ei > bi) {
    return content.slice(0, bi) + b + content.slice(ei + END.length);
  }
  // Append with a blank-line separator.
  return content.replace(/\n*$/, '') + '\n\n' + b + '\n';
}

// Remove the managed block (and any surrounding blank lines it introduced).
export function withoutBlock(content) {
  if (!content) return content;
  const bi = content.indexOf(BEGIN);
  const ei = content.indexOf(END);
  if (bi === -1 || ei === -1 || ei < bi) return content;
  const before = content.slice(0, bi).replace(/\n+$/, '\n');
  const after = content.slice(ei + END.length).replace(/^\n+/, '');
  return (before + after).replace(/\n{3,}/g, '\n\n');
}

export function present(content) {
  return !!content && content.includes(BEGIN) && content.includes(END);
}

// --- CLI --------------------------------------------------------------------
function readTarget(project) {
  const p = targetPath(project);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

function main(argv) {
  const [cmd, projectArg] = argv;
  if (!cmd || !projectArg) {
    process.stderr.write('usage: claudemd.mjs <diff|apply|remove> <project>\n');
    process.exit(2);
  }
  const project = projectArg;
  const path = targetPath(project);
  const cur = readTarget(project);

  if (cmd === 'diff') {
    const next = withBlock(cur);
    if (next === cur) { process.stdout.write(`No change: ${path} already has the current wiregraph block.\n`); return; }
    process.stdout.write(`Would ${present(cur) ? 'update' : 'add'} the wiregraph block in ${path}:\n\n${block()}\n`);
    return;
  }
  if (cmd === 'apply') {
    const next = withBlock(cur);
    writeFileSync(path, next);
    process.stdout.write(`${present(cur) ? 'Updated' : 'Wrote'} wiregraph block in ${path}.\n`);
    return;
  }
  if (cmd === 'remove') {
    if (!present(cur)) { process.stdout.write(`No wiregraph block in ${path}.\n`); return; }
    writeFileSync(path, withoutBlock(cur));
    process.stdout.write(`Removed wiregraph block from ${path}.\n`);
    return;
  }
  process.stderr.write(`unknown command: ${cmd}\n`);
  process.exit(2);
}

const isCli = process.argv[1] && process.argv[1].endsWith('claudemd.mjs');
if (isCli) main(process.argv.slice(2));
