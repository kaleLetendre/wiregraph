#!/usr/bin/env node
// codegraph export-gexf — write a GEXF file for Gephi. Nodes carry repo/kind/
// file/line attributes and a viz:color matching the repo palette; edges are
// DIRECTED (a CALLS b; publisher WIRE consumer) with type/token/contract/
// direction attributes. Open in Gephi, run ForceAtlas2, partition-color by
// "repo" (colors are pre-set so it already matches).
//
// Modes:
//   (default)             the cross-repo WIRE surface (symbol->symbol wire edges)
//   --contract "<name>"   ONE contract: its WIRE edges + the in-repo call stacks
//                         that reach each endpoint (callers --up, callees --down)
//   --all                 every symbol + CALLS + WIRE
//
// Reads the project's embedded SQLite graph (<project>/.codegraph/graph.db, or
// --db <path>). Target project defaults to --project or the cwd.

import { writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './store/sqlite.js';
import { gatherGexf } from './store/sqlite-export.js';

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PALETTE = ['#E15554', '#4D9DE0', '#3BB273', '#7768AE', '#E67E22', '#1B9AAA', '#D81159', '#8F2D56'];

function parseArgs(argv) {
  const o = { out: null, all: false, tests: false, contract: null, up: 3, down: 1, project: null, db: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (a === '--include-tests') o.tests = true;
    else if (a === '--contract') o.contract = argv[++i];
    else if (a === '--up') o.up = parseInt(argv[++i], 10);
    else if (a === '--down') o.down = parseInt(argv[++i], 10);
    else if (a === '--project') o.project = argv[++i];
    else if (a === '--db') o.db = argv[++i];
    else rest.push(a);
  }
  o.out = rest[0] ? resolve(rest[0]) : join(PLUGIN_DIR, 'codegraph.gexf');
  return o;
}

const hexToRgb = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// Collapse parallel same-type edges between a pair; union tokens, sum weight.
function collapse(links) {
  const m = new Map();
  for (const l of links) {
    const key = `${l.source}|${l.target}|${l.type}`;
    const e = m.get(key);
    if (e) { e.weight += l.count || 1; if (l.token && !e.tokens.includes(l.token)) e.tokens.push(l.token); }
    else m.set(key, { source: l.source, target: l.target, type: l.type, weight: l.count || 1, tokens: l.token ? [l.token] : [], contract: l.contract || '', direction: l.direction || '' });
  }
  return [...m.values()];
}

function renderGexf(nodes, links, repoColor) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<gexf xmlns="http://gexf.net/1.3" xmlns:viz="http://gexf.net/1.3/viz" version="1.3">');
  out.push('  <meta><creator>codegraph</creator><description>cross-repo call + wire graph</description></meta>');
  out.push('  <graph defaultedgetype="directed" mode="static">');
  out.push('    <attributes class="node"><attribute id="0" title="repo" type="string"/><attribute id="1" title="kind" type="string"/><attribute id="2" title="file" type="string"/><attribute id="3" title="line" type="integer"/></attributes>');
  out.push('    <attributes class="edge"><attribute id="0" title="type" type="string"/><attribute id="1" title="tokens" type="string"/><attribute id="2" title="contract" type="string"/><attribute id="3" title="direction" type="string"/></attributes>');
  out.push('    <nodes>');
  for (const n of nodes) {
    const c = hexToRgb(repoColor[n.repo] || '#9aa1ac');
    // Contract nodes have no repo/file/line — emit empty, not the literal "null".
    out.push(`      <node id="${xml(n.id)}" label="${xml(n.name)}">` +
      `<attvalues><attvalue for="0" value="${xml(n.repo ?? '')}"/><attvalue for="1" value="${xml(n.kind ?? '')}"/><attvalue for="2" value="${xml(n.file ?? '')}"/><attvalue for="3" value="${xml(n.line ?? '')}"/></attvalues>` +
      `<viz:color r="${c.r}" g="${c.g}" b="${c.b}"/></node>`);
  }
  out.push('    </nodes>');
  out.push('    <edges>');
  links.forEach((l, i) => {
    out.push(`      <edge id="e${i}" source="${xml(l.source)}" target="${xml(l.target)}" weight="${l.weight}">` +
      `<attvalues><attvalue for="0" value="${xml(l.type)}"/><attvalue for="1" value="${xml(l.tokens.join(', '))}"/><attvalue for="2" value="${xml(l.contract)}"/><attvalue for="3" value="${xml(l.direction)}"/></attvalues></edge>`);
  });
  out.push('    </edges>');
  out.push('  </graph>');
  out.push('</gexf>');
  return out.join('\n') + '\n';
}

function resolveProject(opts) {
  const raw = opts.project || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try { return realpathSync(raw); } catch { return raw; }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const project = resolveProject(opts);
  const dbPath = opts.db || process.env.CODEGRAPH_DB || join(project, '.codegraph', 'graph.db');
  if (!existsSync(dbPath)) { process.stderr.write(`No graph db at ${dbPath}. Run /codegraph-init or build first.\n`); process.exit(1); }
  const db = connect(dbPath, { readonly: true });
  let built;
  try {
    built = gatherGexf(db, project, opts);
    if (!built) { process.stderr.write(`No WIRE edges for contract "${opts.contract}".\n`); process.exit(1); }
  } finally { db.close(); }

  const links = collapse(built.links);
  const repos = [...new Set(built.nodes.map((n) => n.repo).filter(Boolean))].sort();
  const repoColor = {};
  repos.forEach((r, i) => { repoColor[r] = PALETTE[i % PALETTE.length]; });

  writeFileSync(opts.out, renderGexf(built.nodes, links, repoColor));
  process.stderr.write(`wrote ${built.nodes.length} nodes / ${links.length} edges -> ${opts.out}\n`);
  process.stderr.write('repos: ' + repos.map((r) => `${r}=${repoColor[r]}`).join(', ') + '\n');
}

main().catch((e) => { process.stderr.write('ERROR: ' + (e.stack || e.message) + '\n'); process.exit(1); });
