#!/usr/bin/env node
// wiregraph export-html — render the graph as a standalone HTML file using a
// d3 clustered-force layout: each compartment has its own gravity center (same
// color attracts), every node repels (charge), compartment centers are spread
// apart (different colors separate), contracts sit in the middle as bridges.
// Sliders tune attraction vs repulsion live. No Neo4j needed to view the result.
//
// Modes:
//   (default)              symbols that REFERENCE a contract + the contracts
//   --all                  full Symbol/Contract graph + CALLS edges
//   --contract "<name>"    ONE contract, all compartments, with the call stacks that
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
import { contractDriftByName } from './store/sqlite-query.js';

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
// Returns true if a launch was attempted. On headless Linux/SSH (no display) or
// WSL (xdg-open can't reach the Windows browser) we don't spawn a doomed helper —
// we just report the path, so the caller doesn't claim it opened when it didn't.
function openInBrowser(file) {
  const plat = platform();
  if (plat === 'linux') {
    const headless = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    let wsl = false;
    try { wsl = /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8')); } catch { /* no /proc */ }
    if (headless || wsl) {
      process.stderr.write(`not opening a browser (${wsl ? 'WSL' : 'no display'}); open ${file} yourself.\n`);
      return false;
    }
  }
  const cmd = plat === 'darwin' ? 'open' : plat === 'win32' ? 'cmd' : 'xdg-open';
  const args = plat === 'win32' ? ['/c', 'start', '', file] : [file];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', (e) => process.stderr.write(`could not open browser (${e.message}); open ${file} yourself.\n`));
  child.unref();
  return true;
}
// Must match the palette/order in build.js so HTML colors are stable across runs.
const PALETTE = ['#E15554', '#4D9DE0', '#3BB273', '#7768AE', '#E67E22', '#1B9AAA', '#D81159', '#8F2D56'];
const CONTRACT_COLOR = '#F2C94C';
// Contract-edge colors by drift status: a wire you can trust vs one to look at.
const DRIFT_COLORS = { ok: '#3BB273', 'one-sided': '#E6A23C', drift: '#E15554' };

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

// The default view: a contract IS an edge, not a node. Compartments are the
// nodes; each contract becomes an edge between every PAIR of compartments that
// reference it (a contract spanning N compartments -> C(N,2) edges, one label,
// curved apart in the renderer). Each edge is colored by the contract's DRIFT
// status. The exception that proves the rule: a contract NO pair can connect —
// referenced by 0 or 1 compartment — has no edge to draw, so it surfaces as a red
// "unwired" node. That a broken contract is the only thing rendered as a node is
// the point: a healthy contract is a wire; a drifted one is a dangling flag.
function contractEdges(built, driftByName) {
  const symCompartment = new Map(); const contracts = new Map();
  for (const n of built.nodes) { if (n.kind === 'contract') contracts.set(n.id, n); else symCompartment.set(n.id, n.compartment); }
  // contractId -> Map(compartment -> {tokens:Set, funcs:Set})
  const perContract = new Map();
  for (const l of built.links) {
    if (l.type !== 'REFERENCES') continue;
    const r = symCompartment.get(l.source); const c = l.target;
    if (!r || !contracts.has(c)) continue;
    if (!perContract.has(c)) perContract.set(c, new Map());
    const m = perContract.get(c);
    if (!m.has(r)) m.set(r, { tokens: new Set(), funcs: new Set() });
    const side = m.get(r);
    for (const t of l.tokens || []) side.tokens.add(t);
    side.funcs.add(l.source);
  }
  const compartmentNodes = new Map();
  const ensure = (r) => { if (!compartmentNodes.has(r)) compartmentNodes.set(r, { id: 'compartment::' + r, kind: 'compartment', compartment: r, name: r, file: null, line: null }); return 'compartment::' + r; };
  const links = []; const danglers = [];
  const seenNames = new Set();
  for (const [cid, cnode] of contracts) {
    seenNames.add(cnode.name);
    const sides = perContract.get(cid) || new Map();
    const drift = driftByName[cnode.name] || null;
    const comps = [...sides.keys()].sort();
    if (comps.length >= 2) {
      for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) {
        const a = sides.get(comps[i]), b = sides.get(comps[j]);
        links.push({
          source: ensure(comps[i]), target: ensure(comps[j]), type: 'CONTRACT', contract: cnode.name,
          tokens: [...new Set([...a.tokens, ...b.tokens])], count: a.funcs.size + b.funcs.size,
          status: drift ? drift.status : 'ok', drift,
        });
      }
    } else {
      // 0 or 1 referencing compartment -> unwired. Draw a red node; if exactly one
      // side touches it, tether that compartment to the node so you can see who.
      const id = 'contract::' + cnode.id;
      danglers.push({ id, kind: 'contract', dangling: true, compartment: null, name: cnode.name, file: null, line: null, status: drift ? drift.status : 'one-sided', drift });
      if (comps.length === 1) links.push({ source: ensure(comps[0]), target: id, type: 'CONTRACT', contract: cnode.name, tokens: [...sides.get(comps[0]).tokens], count: sides.get(comps[0]).funcs.size, status: 'one-sided', drift, toDangler: true });
    }
  }
  // Contracts NO code references at all never made it into built.nodes (gatherHtml
  // only emits a contract node when some symbol references it). Those are the
  // fully-drifted contracts — resurrect them as red dangling nodes so they can't
  // vanish from the picture, which is the whole point of the drift work.
  for (const [name, drift] of Object.entries(driftByName)) {
    if (seenNames.has(name)) continue;
    danglers.push({ id: 'contract::' + name, kind: 'contract', dangling: true, compartment: null, name, file: null, line: null, status: drift.status || 'drift', drift });
  }
  return { nodes: [...compartmentNodes.values(), ...danglers], links };
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

  // Default contract view renders contracts AS edges (needs the per-contract drift
  // status to color them); --functions keeps the per-function detail; --all /
  // --contract are their own modes.
  const compartmentMode = !opts.all && !opts.contract && !opts.functions;
  let built, driftByName = {};
  try {
    built = gatherHtml(db, project, opts);
    if (opts.contract && !built) { process.stderr.write(`No contract matching "${opts.contract}" with references.\n`); process.exit(1); }
    if (compartmentMode) driftByName = Object.fromEntries(contractDriftByName(db, project));
  } finally {
    db.close();
  }

  if (compartmentMode) built = contractEdges(built, driftByName);
  else built.links = collapseLinks(built.links);
  const compartments = [...new Set(built.nodes.map((n) => n.compartment).filter(Boolean))].sort();
  const compartmentColor = {};
  compartments.forEach((r, i) => { compartmentColor[r] = PALETTE[i % PALETTE.length]; });

  const title = opts.contract || (opts.all ? 'full graph' : compartmentMode ? 'contracts × compartments' : 'contract references');
  const data = { nodes: built.nodes, links: built.links, compartments, compartmentColor, contractColor: CONTRACT_COLOR, driftColors: DRIFT_COLORS, title, aggregated: compartmentMode };
  writeFileSync(opts.out, renderHtml(data, { allowCdn: opts.allowCdn }));
  process.stderr.write(`wrote ${data.nodes.length} nodes / ${data.links.length} links -> ${opts.out}\n`);
  process.stderr.write('compartments: ' + compartments.map((r) => `${r}=${compartmentColor[r]}`).join(', ') + '\n');
  if (opts.open && openInBrowser(opts.out)) process.stderr.write(`opening ${opts.out} in your default browser…\n`);
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
  <div class="ctl"><label>same-compartment attraction <span id="vCluster">0.30</span></label>
    <input id="cluster" type="range" min="0" max="1" step="0.02" value="0.30"></div>
  <div class="ctl"><label>repulsion <span id="vCharge">40</span></label>
    <input id="charge" type="range" min="0" max="300" step="5" value="40"></div>
  <div class="ctl"><label>link length <span id="vLink">45</span></label>
    <input id="link" type="range" min="10" max="200" step="5" value="45"></div>
  <div class="ctl"><label style="cursor:pointer"><input id="labels" type="checkbox" style="vertical-align:middle"> show all labels</label></div>
  <div id="legend"></div>
  <div class="hint">hover a node for its name &middot; drag nodes &middot; scroll to zoom &middot; click a swatch to hide a compartment</div>
</div>
<div id="tip"></div>
<script>
const DATA = ${JSON.stringify(data)};
const DRIFT = DATA.driftColors;
const contractCol = d => DRIFT[d.status] || ${JSON.stringify(CONTRACT_COLOR)};
// A contract is drawn as an EDGE now; the only contract NODES are "dangling" ones
// (a contract nothing — or only one side — references), painted by drift status.
const color = d => d.kind === 'contract' ? contractCol(d) : (DATA.compartmentColor[d.compartment] || '#888');
const svg = d3.select('#graph'), g = svg.append('g');
const W = () => window.innerWidth, H = () => window.innerHeight;
svg.call(d3.zoom().scaleExtent([0.03, 5]).on('zoom', e => g.attr('transform', e.transform)));

// Directional arrowheads for CALLS / REFERENCES (other modes). CONTRACT edges are
// undirected (a shared seam), so they carry no arrowhead.
const defs = svg.append('defs');
function arrow(id, col){ defs.append('marker').attr('id',id).attr('viewBox','0 -5 10 10')
  .attr('refX',10).attr('refY',0).attr('markerWidth',5).attr('markerHeight',5).attr('orient','auto')
  .append('path').attr('d','M0,-5L10,0L0,5').attr('fill',col); }
arrow('aRef','#E0A458'); arrow('aCall','#7B8CDE');
const rOf = d => d.kind==='contract' ? 11 : d.kind==='compartment' ? 16 : 5;

const centers = {};
DATA.compartments.forEach((r, i) => { const a = (i/DATA.compartments.length)*2*Math.PI - Math.PI/2; centers[r] = {x:Math.cos(a), y:Math.sin(a)}; });
const radius = () => Math.min(W(),H())*0.40;
// Contract nodes only exist as dangling markers now; ring them near the center.
const contractNodes = DATA.nodes.filter(d=>d.kind==='contract');
contractNodes.forEach((c,i)=>{ c.__ci = i; });
const NC = contractNodes.length;
const innerR = () => NC<=1 ? 0 : Math.min(radius()*0.5, Math.max(Math.min(W(),H())*0.14, NC*12));
const cAngle = d => (d.__ci/NC)*2*Math.PI - Math.PI/2;
const tx = d => d.kind==='contract' ? W()/2 + Math.cos(cAngle(d))*innerR() : W()/2 + (centers[d.compartment]?.x||0)*radius();
const ty = d => d.kind==='contract' ? H()/2 + Math.sin(cAngle(d))*innerR() : H()/2 + (centers[d.compartment]?.y||0)*radius();

const tip = document.getElementById('tip');
function showTip(e, html){ tip.style.display='block'; tip.style.left=(e.clientX+12)+'px'; tip.style.top=(e.clientY+12)+'px'; tip.innerHTML=html; }
function hideTip(){ tip.style.display='none'; }

// Curve parallel edges apart: many contracts can join the same compartment pair,
// so index each link within its unordered pair and bow it by that index.
const pairIdx = new Map();
DATA.links.forEach(l=>{ const s=(typeof l.source==='object'?l.source.id:l.source), t=(typeof l.target==='object'?l.target.id:l.target);
  const k = s<t? s+'|'+t : t+'|'+s; const a=pairIdx.get(k)||[]; a.push(l); pairIdx.set(k,a); });
pairIdx.forEach(a=>{ const n=a.length; a.forEach((l,i)=>{ l._curv = n===1?0:(i-(n-1)/2); }); });

const driftFlag = d => d.status==='drift' ? ' 🔴 DRIFT' : d.status==='one-sided' ? ' ⚠️ one-sided' : '';
const linkStroke = d => d.type==='CONTRACT' ? contractCol(d) : (d.type==='REFERENCES' ? '#E0A458' : '#7B8CDE');
const linkWidth = d => d.type==='CONTRACT' ? Math.min(6, 1.4 + Math.log2(1+d.tokens.length)*1.4)
  : d.type==='REFERENCES' ? Math.min(7, 1 + d.count*0.6) : Math.min(3.5, 0.8 + d.count*0.3);
const linkTip = d => d.type==='CONTRACT'
    ? '<b>'+d.contract+'</b>'+driftFlag(d)+'<br>contract seam &middot; '+d.tokens.length+' field(s)'
        + (d.drift? '<br>'+d.drift.satisfied+' satisfied &middot; '+d.drift.oneSided+' one-sided &middot; '+d.drift.unreferenced+' unreferenced':'')
        + '<br>'+d.tokens.slice(0,12).join(', ')+(d.tokens.length>12?' …':'')
    : d.type==='REFERENCES' ? '<b>REFERENCES</b> &middot; '+d.count+' field(s)<br>'+d.tokens.join(', ')
    : '<b>CALLS</b> &times;'+d.count;

const link = g.append('g').attr('fill','none').attr('stroke-opacity',0.5).selectAll('path')
  .data(DATA.links).join('path')
  .attr('stroke', linkStroke).attr('stroke-width', linkWidth)
  .attr('marker-end', d => d.type==='CONTRACT' ? null : (d.type==='REFERENCES' ? 'url(#aRef)' : 'url(#aCall)'))
  .on('mousemove', (e,d)=> showTip(e, linkTip(d))).on('mouseout', hideTip);

const node = g.append('g').selectAll('circle')
  .data(DATA.nodes).join('circle')
  .attr('r', rOf)
  .attr('fill', color).attr('stroke','#1b1d23').attr('stroke-width',d=>d.kind==='compartment'?2:1.2)
  .on('mousemove', (e,d)=> showTip(e, d.kind==='contract'
      ? '<b>'+d.name+'</b>'+driftFlag(d)+'<br>unwired contract — no code, or only one side, references it'
      : d.kind==='compartment'
      ? '<b>'+d.name+'</b><br>compartment'
      : '<b>'+d.name+'</b><br>'+d.compartment+'<br>'+(d.file||'')+(d.line?(':'+d.line):'')))
  .on('mouseout', hideTip)
  .call(d3.drag()
    .on('start',(e,d)=>{ if(!e.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
    .on('drag',(e,d)=>{ d.fx=e.x; d.fy=e.y; })
    .on('end',(e,d)=>{ if(!e.active) sim.alphaTarget(0); d.fx=null; d.fy=null; }));

// Node labels (compartments always; dangling contracts when labels are on).
const label = g.append('g').selectAll('text')
  .data(DATA.nodes.filter(d=>d.kind==='contract'||d.kind==='compartment')).join('text')
  .text(d=>d.name).attr('fill',d=>d.kind==='compartment'?'#e6e6e6':'#f2b8b8')
  .attr('font-size',d=>d.kind==='compartment'?'13px':'11px').attr('font-weight',d=>d.kind==='compartment'?'600':'400')
  .attr('text-anchor','middle').attr('dy',d=>d.kind==='compartment'?-21:-14)
  .style('pointer-events','none');

// Contract-edge labels: the whole point of the view, so on by default. Placed at
// each edge's bowed midpoint; the "show all labels" toggle also reveals node names.
const elabelData = DATA.links.filter(d=>d.type==='CONTRACT' && !d.toDangler);
const elabel = g.append('g').selectAll('text')
  .data(elabelData).join('text')
  .text(d=>d.contract).attr('fill',d=>contractCol(d)).attr('font-size','10px')
  .attr('text-anchor','middle').attr('dy','-2').style('pointer-events','none').style('opacity',0.9);

// Quadratic-bezier path (bowed by _curv) with endpoints trimmed to node borders.
function geom(d){
  const s=d.source, t=d.target, dx=t.x-s.x, dy=t.y-s.y, L=Math.hypot(dx,dy)||1;
  const nx=-dy/L, ny=dx/L, off=(d._curv||0)*24;
  const cx=(s.x+t.x)/2+nx*off, cy=(s.y+t.y)/2+ny*off;
  const gap = d.type==='CONTRACT'?0:4;
  const sx=s.x+dx/L*(rOf(s)), sy=s.y+dy/L*(rOf(s));
  const ex=t.x-dx/L*(rOf(t)+gap), ey=t.y-dy/L*(rOf(t)+gap);
  // midpoint of the quadratic at u=0.5
  const mx=0.25*sx+0.5*cx+0.25*ex, my=0.25*sy+0.5*cy+0.25*ey;
  return {sx,sy,cx,cy,ex,ey,mx,my};
}

const sim = d3.forceSimulation(DATA.nodes)
  .force('link', d3.forceLink(DATA.links).id(d=>d.id).distance(90).strength(0.06))
  .force('charge', d3.forceManyBody().strength(-160))
  .force('x', d3.forceX(tx).strength(d=>d.kind==='contract'?0.5:0.22))
  .force('y', d3.forceY(ty).strength(d=>d.kind==='contract'?0.5:0.22))
  .force('collide', d3.forceCollide(d=>d.kind==='contract'?18:d.kind==='compartment'?30:6))
  .on('tick', ()=>{
    link.attr('d',d=>{ const p=geom(d); return d._curv? \`M\${p.sx},\${p.sy} Q\${p.cx},\${p.cy} \${p.ex},\${p.ey}\` : \`M\${p.sx},\${p.sy} L\${p.ex},\${p.ey}\`; });
    node.attr('cx',d=>d.x).attr('cy',d=>d.y);
    label.attr('x',d=>d.x).attr('y',d=>d.y);
    elabel.attr('x',d=>geom(d).mx).attr('y',d=>geom(d).my);
  });

const bind=(id,vid,fn,fmt)=>{ const el=document.getElementById(id);
  el.addEventListener('input',()=>{ document.getElementById(vid).textContent=fmt(+el.value); fn(+el.value); sim.alpha(0.5).restart(); }); };
bind('cluster','vCluster', v=>{ const f=d=>d.kind==='contract'?Math.min(1,v+0.2):v; sim.force('x').strength(f); sim.force('y').strength(f); }, v=>v.toFixed(2));
bind('charge','vCharge', v=> sim.force('charge').strength(-v), v=>v.toFixed(0));
bind('link','vLink', v=> sim.force('link').distance(v), v=>v.toFixed(0));

const hidden=new Set();
const legend=d3.select('#legend');
// Compartment swatches (click to hide). Circles => nodes you can toggle.
DATA.compartments.forEach(r=>{ const it={key:r,col:DATA.compartmentColor[r]};
  const row=legend.append('div').attr('class','leg').on('click',function(){
    hidden.has(it.key)?hidden.delete(it.key):hidden.add(it.key); d3.select(this).classed('off',hidden.has(it.key)); applyFilter(); });
  row.append('div').attr('class','sw').style('background',it.col); row.append('div').text(r); });
// Drift color key for the contract EDGES (non-clickable — it explains, not filters).
if (DATA.aggregated) {
  legend.append('div').style('border-top','1px solid #3a3f4b').style('margin-top','6px').style('padding-top','6px').style('font-size','10px').style('color','#7d8492').text('contract edges');
  [['ok','satisfied'],['one-sided','one-sided'],['drift','has drift']].forEach(([k,lbl])=>{
    const row=legend.append('div').attr('class','leg').style('cursor','default');
    row.append('div').attr('class','sw').style('border-radius','2px').style('background',DRIFT[k]); row.append('div').text(lbl); });
}
const isHidden=d=> d.kind==='contract' ? false : hidden.has(d.compartment);
let labelsOn=false;
document.getElementById('labels').addEventListener('change', e=>{ labelsOn=e.target.checked; applyFilter(); });
function applyFilter(){ node.attr('display',d=>isHidden(d)?'none':null);
  label.attr('display',d=>((d.kind==='compartment'||labelsOn) && !isHidden(d))?null:'none');
  link.attr('display',d=>(isHidden(d.source)||isHidden(d.target))?'none':null);
  elabel.attr('display',d=>(isHidden(d.source)||isHidden(d.target))?'none':null); }
applyFilter();
</script>
</body>
</html>
`;
}

const isCli = process.argv[1] && process.argv[1].endsWith('export-html.js');
if (isCli) main().catch((e) => { process.stderr.write('ERROR: ' + (e.stack || e.message) + '\n'); process.exit(1); });
