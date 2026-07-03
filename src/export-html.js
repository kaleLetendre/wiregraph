#!/usr/bin/env node
// wiregraph export-html — render the graph as a standalone HTML file using a
// d3 clustered-force layout: each repo has its own gravity center (same color
// attracts), every node repels (charge), repo centers are spread apart
// (different colors separate), contracts sit in the middle as bridges. Sliders
// tune attraction vs repulsion live. No Neo4j needed to view the result.
//
// Modes:
//   (default)              symbols that REFERENCE a contract + the contracts
//   --all                  full Symbol/Contract graph + CALLS edges
//   --contract "<name>"    ONE contract, all repos, with the call stacks that
//                          reach it: callers up to --up hops, callees down to
//                          --down hops, plus a single collapsed REFERENCES edge
//                          per symbol (no per-token fan-out).
//
// Parallel REFERENCES edges are always collapsed to one weighted edge. Reads the
// project's embedded SQLite graph (<project>/.wiregraph/graph.db, or --db <path>);
// target project defaults to --project or cwd. No Neo4j needed to build or view.

import { writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { connect } from './store/sqlite.js';
import { gatherHtml } from './store/sqlite-export.js';

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const D3_BUNDLE = join(PLUGIN_DIR, 'node_modules', 'd3', 'dist', 'd3.min.js');

// Inline the vendored d3 so the page renders with zero network access (the whole
// point of wiregraph is that nothing leaves the machine). If the bundle is missing
// we FAIL LOUD rather than silently emitting a CDN <script> — a quiet CDN swap
// breaks the "100% local" promise on an air-gapped machine (blank page, no error).
// --allow-cdn is the explicit, opt-in escape hatch.
export function d3ScriptTag(allowCdn, bundlePath = D3_BUNDLE) {
  try {
    return `<script>${readFileSync(bundlePath, 'utf8')}</script>`;
  } catch {
    if (allowCdn) return '<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>';
    throw new Error(
      `d3 bundle not found at ${D3_BUNDLE}. The offline visualization needs it — run `
      + `\`npm install\` in the plugin dir, or pass --allow-cdn to load d3 from a CDN `
      + `(requires network; not "100% local").`);
  }
}

// Open a file in the OS default browser, detached, so this process can exit.
function openInBrowser(file) {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', file] : [file];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', (e) => process.stderr.write(`could not open browser (${e.message}); open ${file} yourself.\n`));
  child.unref();
}
// Must match the palette/order in build.js so HTML colors are stable across runs.
const PALETTE = ['#E15554', '#4D9DE0', '#3BB273', '#7768AE', '#E67E22', '#1B9AAA', '#D81159', '#8F2D56'];
const CONTRACT_COLOR = '#F2C94C';

function parseArgs(argv) {
  const o = { out: null, all: false, tests: false, contract: null, up: 3, down: 1, project: null, db: null, open: false, functions: false, allowCdn: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (a === '--include-tests') o.tests = true;
    else if (a === '--functions') o.functions = true;
    else if (a === '--allow-cdn') o.allowCdn = true;
    else if (a === '--open') o.open = true;
    else if (a === '--contract') o.contract = argv[++i];
    else if (a === '--up') o.up = parseInt(argv[++i], 10);
    else if (a === '--down') o.down = parseInt(argv[++i], 10);
    else if (a === '--project') o.project = argv[++i];
    else if (a === '--db') o.db = argv[++i];
    else rest.push(a);
  }
  // Explicit path wins; otherwise default into the project's .wiregraph/ (resolved
  // in main, once we know the project) so the file lives with the graph, not the plugin.
  o.out = rest[0] ? resolve(rest[0]) : null;
  return o;
}

// Collapse parallel edges of the same type between the same pair into one,
// summing weight and unioning tokens. Fixes the "20 edges = 1 relationship" fan-out.
function collapseLinks(links) {
  const m = new Map();
  for (const l of links) {
    const key = `${l.source}|${l.target}|${l.type}`;
    const e = m.get(key);
    if (e) {
      e.count += l.count || 1;
      for (const t of l.tokens || []) if (!e.tokens.includes(t)) e.tokens.push(t);
    } else {
      m.set(key, { source: l.source, target: l.target, type: l.type, count: l.count || 1, tokens: [...(l.tokens || [])] });
    }
  }
  // For REFERENCES, weight = number of distinct tokens (fields), which is what
  // the user actually wants to see, not the raw edge count.
  for (const e of m.values()) if (e.type === 'REFERENCES') e.count = e.tokens.length || 1;
  return [...m.values()];
}

// The default contract view: collapse every function->contract reference to ONE
// arrow per (repo -> contract), so a big workspace shows which repos touch which
// contracts instead of a hairball of per-function edges. Arrow weight = number of
// distinct functions in that repo referencing the contract; tokens = union of
// fields. Symbol nodes are dropped in favor of one hub node per repo.
function aggregateByRepo(built) {
  const symRepo = new Map(); const contracts = new Map();
  for (const n of built.nodes) { if (n.kind === 'contract') contracts.set(n.id, n); else symRepo.set(n.id, n.repo); }
  const repoNodes = new Map(); const agg = new Map();
  for (const l of built.links) {
    if (l.type !== 'REFERENCES') continue;
    const r = symRepo.get(l.source); const c = l.target;
    if (!r || !contracts.has(c)) continue;
    if (!repoNodes.has(r)) repoNodes.set(r, { id: 'repo::' + r, kind: 'repo', repo: r, name: r, file: null, line: null });
    const key = r + '||' + c; let e = agg.get(key);
    if (!e) { e = { source: 'repo::' + r, target: c, type: 'REFERENCES', tokens: new Set(), funcs: new Set() }; agg.set(key, e); }
    for (const t of l.tokens || []) e.tokens.add(t);
    e.funcs.add(l.source);
  }
  const links = [...agg.values()].map((e) => ({ source: e.source, target: e.target, type: 'REFERENCES', tokens: [...e.tokens], count: e.funcs.size }));
  return { nodes: [...repoNodes.values(), ...contracts.values()], links };
}

function resolveProject(opts) {
  const raw = opts.project || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try { return realpathSync(raw); } catch { return raw; }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const project = resolveProject(opts);
  if (!opts.out) opts.out = join(project, '.wiregraph', 'graph.html');
  const dbPath = opts.db || process.env.WIREGRAPH_DB || join(project, '.wiregraph', 'graph.db');
  if (!existsSync(dbPath)) { process.stderr.write(`No graph db at ${dbPath}. Run /wiregraph-init or build first.\n`); process.exit(1); }
  const db = connect(dbPath, { readonly: true });

  let built;
  try {
    built = gatherHtml(db, project, opts);
    if (opts.contract && !built) { process.stderr.write(`No contract matching "${opts.contract}" with references.\n`); process.exit(1); }
  } finally {
    db.close();
  }

  // Default contract view aggregates per repo; --functions keeps the per-function
  // detail; --all / --contract are their own modes.
  const repoMode = !opts.all && !opts.contract && !opts.functions;
  if (repoMode) built = aggregateByRepo(built);
  else built.links = collapseLinks(built.links);
  const repos = [...new Set(built.nodes.map((n) => n.repo).filter(Boolean))].sort();
  const repoColor = {};
  repos.forEach((r, i) => { repoColor[r] = PALETTE[i % PALETTE.length]; });

  const title = opts.contract || (opts.all ? 'full graph' : repoMode ? 'contracts × repos' : 'contract references');
  const data = { nodes: built.nodes, links: built.links, repos, repoColor, contractColor: CONTRACT_COLOR, title, aggregated: repoMode };
  writeFileSync(opts.out, renderHtml(data, { allowCdn: opts.allowCdn }));
  process.stderr.write(`wrote ${data.nodes.length} nodes / ${data.links.length} links -> ${opts.out}\n`);
  process.stderr.write('repos: ' + repos.map((r) => `${r}=${repoColor[r]}`).join(', ') + '\n');
  if (opts.open) { openInBrowser(opts.out); process.stderr.write(`opening ${opts.out} in your default browser…\n`); }
}

export function renderHtml(data, { allowCdn = false } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>wiregraph — ${data.title}</title>
${d3ScriptTag(allowCdn)}
<style>
  html,body { margin:0; height:100%; background:#1b1d23; color:#e6e6e6; font:13px/1.4 system-ui,sans-serif; overflow:hidden; }
  #graph { width:100vw; height:100vh; display:block; cursor:grab; }
  #panel { position:fixed; top:12px; left:12px; background:rgba(30,33,40,.92); border:1px solid #3a3f4b;
           border-radius:8px; padding:12px 14px; width:235px; box-shadow:0 4px 20px rgba(0,0,0,.4); }
  #panel h1 { font-size:13px; margin:0 0 8px; font-weight:600; }
  .ctl { margin:8px 0; }
  .ctl label { display:flex; justify-content:space-between; font-size:11px; color:#aeb4c0; }
  .ctl input[type=range] { width:100%; }
  #legend { margin-top:10px; border-top:1px solid #3a3f4b; padding-top:8px; }
  .leg { display:flex; align-items:center; gap:7px; margin:3px 0; font-size:12px; cursor:pointer; user-select:none; }
  .leg .sw { width:13px; height:13px; border-radius:50%; flex:none; }
  .leg.off { opacity:.35; }
  .hint { font-size:10px; color:#7d8492; margin-top:8px; }
  #tip { position:fixed; pointer-events:none; background:#0f1116; border:1px solid #3a3f4b; border-radius:5px;
         padding:5px 8px; font-size:11px; max-width:360px; display:none; z-index:10; }
</style>
</head>
<body>
<svg id="graph"></svg>
<div id="panel">
  <h1>${data.title} &middot; ${data.nodes.length} nodes</h1>
  <div class="ctl"><label>same-repo attraction <span id="vCluster">0.30</span></label>
    <input id="cluster" type="range" min="0" max="1" step="0.02" value="0.30"></div>
  <div class="ctl"><label>repulsion <span id="vCharge">40</span></label>
    <input id="charge" type="range" min="0" max="300" step="5" value="40"></div>
  <div class="ctl"><label>link length <span id="vLink">45</span></label>
    <input id="link" type="range" min="10" max="200" step="5" value="45"></div>
  <div class="ctl"><label style="cursor:pointer"><input id="labels" type="checkbox" style="vertical-align:middle"> show all labels</label></div>
  <div id="legend"></div>
  <div class="hint">hover a node for its name &middot; drag nodes &middot; scroll to zoom &middot; click a swatch to hide a repo</div>
</div>
<div id="tip"></div>
<script>
const DATA = ${JSON.stringify(data)};
const color = d => d.kind === 'contract' ? ${JSON.stringify(CONTRACT_COLOR)} : (DATA.repoColor[d.repo] || '#888');
const svg = d3.select('#graph'), g = svg.append('g');
const W = () => window.innerWidth, H = () => window.innerHeight;
svg.call(d3.zoom().scaleExtent([0.03, 5]).on('zoom', e => g.attr('transform', e.transform)));

// Directional arrowheads (a CALLS b, symbol REFERENCES contract point at the target).
const defs = svg.append('defs');
function arrow(id, col){ defs.append('marker').attr('id',id).attr('viewBox','0 -5 10 10')
  .attr('refX',10).attr('refY',0).attr('markerWidth',5).attr('markerHeight',5).attr('orient','auto')
  .append('path').attr('d','M0,-5L10,0L0,5').attr('fill',col); }
arrow('aRef','#E0A458'); arrow('aCall','#7B8CDE');
const rOf = d => d.kind==='contract' ? 12 : d.kind==='repo' ? 16 : 5;

const centers = {};
DATA.repos.forEach((r, i) => { const a = (i/DATA.repos.length)*2*Math.PI - Math.PI/2; centers[r] = {x:Math.cos(a), y:Math.sin(a)}; });
const radius = () => Math.min(W(),H())*0.40;
// Spread contracts around a smaller inner ring (stable index order) instead of
// pinning every one to the exact center — otherwise all the seams and their
// labels collapse into a single unreadable blob.
const contractNodes = DATA.nodes.filter(d=>d.kind==='contract');
contractNodes.forEach((c,i)=>{ c.__ci = i; });
const NC = contractNodes.length;
const innerR = () => NC<=1 ? 0 : Math.min(radius()*0.66, Math.max(Math.min(W(),H())*0.16, NC*10));
const cAngle = d => (d.__ci/NC)*2*Math.PI - Math.PI/2;
const tx = d => d.kind==='contract' ? W()/2 + Math.cos(cAngle(d))*innerR() : W()/2 + (centers[d.repo]?.x||0)*radius();
const ty = d => d.kind==='contract' ? H()/2 + Math.sin(cAngle(d))*innerR() : H()/2 + (centers[d.repo]?.y||0)*radius();

const tip = document.getElementById('tip');
function showTip(e, html){ tip.style.display='block'; tip.style.left=(e.clientX+12)+'px'; tip.style.top=(e.clientY+12)+'px'; tip.innerHTML=html; }
function hideTip(){ tip.style.display='none'; }

const link = g.append('g').attr('stroke-opacity',0.38).selectAll('line')
  .data(DATA.links).join('line')
  .attr('stroke', d => d.type==='REFERENCES' ? '#E0A458' : '#7B8CDE')
  .attr('stroke-width', d => d.type==='REFERENCES' ? Math.min(7, 1 + d.count*0.6) : Math.min(3.5, 0.8 + d.count*0.3))
  .attr('marker-end', d => d.type==='REFERENCES' ? 'url(#aRef)' : 'url(#aCall)')
  .on('mousemove', (e,d)=> showTip(e, d.type==='REFERENCES'
      ? (DATA.aggregated
          ? '<b>'+d.count+' function(s)</b> in this repo &rarr; contract<br>'+d.tokens.length+' field(s): '+d.tokens.join(', ')
          : '<b>REFERENCES</b> &middot; '+d.count+' field(s)<br>'+d.tokens.join(', '))
      : '<b>CALLS</b> &times;'+d.count))
  .on('mouseout', hideTip);

const node = g.append('g').selectAll('circle')
  .data(DATA.nodes).join('circle')
  .attr('r', rOf)
  .attr('fill', color).attr('stroke','#1b1d23').attr('stroke-width',d=>d.kind==='repo'?2:1.2)
  .on('mousemove', (e,d)=> showTip(e, d.kind==='contract'
      ? '<b>'+d.name+'</b><br>contract'
      : d.kind==='repo'
      ? '<b>'+d.name+'</b><br>repo'
      : '<b>'+d.name+'</b><br>'+d.repo+'<br>'+(d.file||'')+(d.line?(':'+d.line):'')))
  .on('mouseout', hideTip)
  .call(d3.drag()
    .on('start',(e,d)=>{ if(!e.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
    .on('drag',(e,d)=>{ d.fx=e.x; d.fy=e.y; })
    .on('end',(e,d)=>{ if(!e.active) sim.alphaTarget(0); d.fx=null; d.fy=null; }));

const label = g.append('g').selectAll('text')
  .data(DATA.nodes.filter(d=>d.kind==='contract'||d.kind==='repo')).join('text')
  .text(d=>d.name).attr('fill',d=>d.kind==='repo'?'#e6e6e6':'#f2e9c0')
  .attr('font-size',d=>d.kind==='repo'?'13px':'12px').attr('font-weight',d=>d.kind==='repo'?'600':'400')
  .attr('text-anchor','middle').attr('dy',d=>d.kind==='repo'?-21:-15)
  .style('pointer-events','none');

const sim = d3.forceSimulation(DATA.nodes)
  .force('link', d3.forceLink(DATA.links).id(d=>d.id).distance(45).strength(0.08))
  .force('charge', d3.forceManyBody().strength(-70))
  .force('x', d3.forceX(tx).strength(d=>d.kind==='contract'?0.5:0.28))
  .force('y', d3.forceY(ty).strength(d=>d.kind==='contract'?0.5:0.28))
  .force('collide', d3.forceCollide(d=>d.kind==='contract'?20:d.kind==='repo'?24:6))
  .on('tick', ()=>{
    // Trim each line to the target node's border so the arrowhead is visible.
    link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
      .attr('x2',d=>{ const dx=d.target.x-d.source.x, dy=d.target.y-d.source.y, L=Math.hypot(dx,dy)||1; return d.target.x - dx/L*(rOf(d.target)+4); })
      .attr('y2',d=>{ const dx=d.target.x-d.source.x, dy=d.target.y-d.source.y, L=Math.hypot(dx,dy)||1; return d.target.y - dy/L*(rOf(d.target)+4); });
    node.attr('cx',d=>d.x).attr('cy',d=>d.y);
    label.attr('x',d=>d.x).attr('y',d=>d.y);
  });

const bind=(id,vid,fn,fmt)=>{ const el=document.getElementById(id);
  el.addEventListener('input',()=>{ document.getElementById(vid).textContent=fmt(+el.value); fn(+el.value); sim.alpha(0.5).restart(); }); };
bind('cluster','vCluster', v=>{ const f=d=>d.kind==='contract'?Math.min(1,v+0.2):v; sim.force('x').strength(f); sim.force('y').strength(f); }, v=>v.toFixed(2));
bind('charge','vCharge', v=> sim.force('charge').strength(-v), v=>v.toFixed(0));
bind('link','vLink', v=> sim.force('link').distance(v), v=>v.toFixed(0));

const hidden=new Set();
const items=[...DATA.repos.map(r=>({key:r,label:r,col:DATA.repoColor[r]})),{key:'__contract',label:'contract',col:${JSON.stringify(CONTRACT_COLOR)}}];
const legend=d3.select('#legend');
items.forEach(it=>{ const row=legend.append('div').attr('class','leg').on('click',function(){
    hidden.has(it.key)?hidden.delete(it.key):hidden.add(it.key); d3.select(this).classed('off',hidden.has(it.key)); applyFilter(); });
  row.append('div').attr('class','sw').style('background',it.col); row.append('div').text(it.label); });
const isHidden=d=> hidden.has(d.kind==='contract'?'__contract':d.repo);
// Labels are OFF by default: with many seams the always-on text is the main source
// of clutter, and hovering any node already shows its name in the tooltip. The
// "show all labels" checkbox turns them on for when the user has zoomed into a region.
let labelsOn=false;
document.getElementById('labels').addEventListener('change', e=>{ labelsOn=e.target.checked; applyFilter(); });
function applyFilter(){ node.attr('display',d=>isHidden(d)?'none':null);
  label.attr('display',d=>((d.kind==='repo'||labelsOn) && !isHidden(d))?null:'none');
  link.attr('display',d=>(isHidden(d.source)||isHidden(d.target))?'none':null); }
applyFilter();
</script>
</body>
</html>
`;
}

const isCli = process.argv[1] && process.argv[1].endsWith('export-html.js');
if (isCli) main().catch((e) => { process.stderr.write('ERROR: ' + (e.stack || e.message) + '\n'); process.exit(1); });
