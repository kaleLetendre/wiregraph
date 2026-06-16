// Data-gathering for the GEXF / HTML exporters, reading the embedded SQLite
// store (the renderers stay pure-JS and unchanged). Returns { nodes, links }
// where a node is { id, kind, repo, name, file, line } (kind 'contract' for
// Contract nodes) and a link is { source, target, type, token?, contract?,
// direction?, count? }. Mirrors the shapes the old Neo4j gather produced.

// Match the query layer's test-file predicate exactly (path-segment markers, not a
// bare "test" substring — else "latest"/"fastest"/"contest" would be misfiltered).
const isTest = (f) => !!f && (f.includes('tests/') || f.includes('/test/') || f.includes('.test.') || f.includes('_test.') || f.includes('/test_'));

function symbolNodes(db, project) {
  const m = new Map();
  for (const s of db.prepare('SELECT id,repo,file,name,kind,startLine FROM symbols WHERE project=?').all(project)) {
    m.set(s.id, { id: s.id, kind: s.kind || 'symbol', repo: s.repo || null, name: s.name || s.id, file: s.file || null, line: s.startLine != null ? Number(s.startLine) : null });
  }
  return m;
}
function contractNodes(db, project) {
  const m = new Map();
  for (const c of db.prepare('SELECT id,name FROM contracts WHERE project=?').all(project)) {
    m.set(c.id, { id: c.id, kind: 'contract', repo: null, name: c.name || c.id, file: null, line: null });
  }
  return m;
}

// CALLS adjacency for in-JS variable-depth traversal (callers/callees).
function callsAdj(db, project) {
  const fwd = new Map(); const rev = new Map();
  for (const e of db.prepare("SELECT src,dst FROM edges WHERE project=? AND type='CALLS'").all(project)) {
    (fwd.get(e.src) || fwd.set(e.src, []).get(e.src)).push(e.dst);
    (rev.get(e.dst) || rev.set(e.dst, []).get(e.dst)).push(e.src);
  }
  return { fwd, rev };
}

// gather for GEXF (symbol-centric: WIRE surface / --all CALLS+WIRE / --contract).
export function gatherGexf(db, project, opts) {
  const syms = symbolNodes(db, project);
  const nodes = new Map();
  const links = [];
  const keep = (f) => opts.tests || !isTest(f);
  const addSym = (id) => { const n = syms.get(id); if (n && keep(n.file)) { nodes.set(id, n); return true; } return false; };

  if (opts.contract) {
    const wires = db.prepare("SELECT src,dst,token,direction FROM edges WHERE project=? AND type='WIRE' AND contract=?").all(project, opts.contract);
    if (!wires.length) return null;
    const seeds = new Set();
    for (const w of wires) {
      if (addSym(w.src) && addSym(w.dst)) {
        links.push({ source: w.src, target: w.dst, type: 'WIRE', token: w.token, contract: opts.contract, direction: w.direction });
        seeds.add(w.src); seeds.add(w.dst);
      }
    }
    const { fwd, rev } = callsAdj(db, project);
    const up = Math.max(0, Math.min(6, opts.up)), down = Math.max(0, Math.min(4, opts.down));
    const walk = (adj, depth, asLink) => {
      let frontier = [...seeds];
      for (let h = 0; h < depth; h++) {
        const next = [];
        for (const id of frontier) for (const nb of (adj.get(id) || [])) {
          const [a, b] = asLink(id, nb);
          if (addSym(a) && addSym(b)) { links.push({ source: a, target: b, type: 'CALLS', count: 1 }); next.push(nb); }
        }
        frontier = next;
      }
    };
    if (up > 0) walk(rev, up, (id, nb) => [nb, id]);   // caller -> id
    if (down > 0) walk(fwd, down, (id, nb) => [id, nb]); // id -> callee
    return { nodes: [...nodes.values()], links };
  }

  if (opts.all) {
    for (const [id, n] of syms) if (keep(n.file)) nodes.set(id, n);
    for (const e of db.prepare("SELECT src,dst,type,token,contract,direction,cnt FROM edges WHERE project=? AND type IN ('CALLS','WIRE')").all(project)) {
      if (nodes.has(e.src) && nodes.has(e.dst)) links.push({ source: e.src, target: e.dst, type: e.type, token: e.token, contract: e.contract, direction: e.direction, count: e.cnt != null ? Number(e.cnt) : 1 });
    }
    return { nodes: [...nodes.values()], links };
  }

  // default: the WIRE surface
  for (const e of db.prepare("SELECT src,dst,token,contract,direction FROM edges WHERE project=? AND type='WIRE'").all(project)) {
    if (addSym(e.src) && addSym(e.dst)) links.push({ source: e.src, target: e.dst, type: 'WIRE', token: e.token, contract: e.contract, direction: e.direction });
  }
  return { nodes: [...nodes.values()], links };
}

// gather for HTML (includes Contract nodes + REFERENCES edges).
export function gatherHtml(db, project, opts) {
  const syms = symbolNodes(db, project);
  const cons = contractNodes(db, project);
  const nodes = new Map();
  const links = [];
  const keep = (f) => opts.tests || !isTest(f);
  const addSym = (id) => { const n = syms.get(id); if (n && keep(n.file)) { nodes.set(id, n); return true; } return false; };
  const addCon = (id) => { const n = cons.get(id); if (n) { nodes.set(id, n); return true; } return false; };

  if (opts.contract) {
    const refs = db.prepare(`SELECT e.src src, e.dst dst, e.token token FROM edges e JOIN contracts c ON c.id=e.dst
                             WHERE e.project=? AND e.type='REFERENCES' AND c.name=?`).all(project, opts.contract);
    if (!refs.length) return null;
    const seeds = new Set();
    for (const r of refs) {
      if (addSym(r.src) && addCon(r.dst)) { links.push({ source: r.src, target: r.dst, type: 'REFERENCES', tokens: r.token ? [r.token] : [], count: 1 }); seeds.add(r.src); }
    }
    const { fwd, rev } = callsAdj(db, project);
    const up = Math.max(0, Math.min(6, opts.up)), down = Math.max(0, Math.min(4, opts.down));
    const walk = (adj, depth, asLink) => {
      let frontier = [...seeds];
      for (let h = 0; h < depth; h++) {
        const next = [];
        for (const id of frontier) for (const nb of (adj.get(id) || [])) {
          const [a, b] = asLink(id, nb);
          if (addSym(a) && addSym(b)) { links.push({ source: a, target: b, type: 'CALLS', tokens: [], count: 1 }); next.push(nb); }
        }
        frontier = next;
      }
    };
    if (up > 0) walk(rev, up, (id, nb) => [nb, id]);
    if (down > 0) walk(fwd, down, (id, nb) => [id, nb]);
    return { nodes: [...nodes.values()], links };
  }

  if (opts.all) {
    for (const [id, n] of syms) if (keep(n.file)) nodes.set(id, n);
    for (const [id, n] of cons) nodes.set(id, n);
    for (const e of db.prepare("SELECT src,dst,type,token,cnt FROM edges WHERE project=? AND type IN ('CALLS','REFERENCES')").all(project)) {
      if (nodes.has(e.src) && nodes.has(e.dst)) links.push({ source: e.src, target: e.dst, type: e.type, tokens: e.token ? [e.token] : [], count: e.cnt != null ? Number(e.cnt) : 1 });
    }
    return { nodes: [...nodes.values()], links };
  }

  // default: symbols that REFERENCE a contract + the contracts
  for (const e of db.prepare("SELECT src,dst,token FROM edges WHERE project=? AND type='REFERENCES'").all(project)) {
    if (addSym(e.src) && addCon(e.dst)) links.push({ source: e.src, target: e.dst, type: 'REFERENCES', tokens: e.token ? [e.token] : [], count: 1 });
  }
  return { nodes: [...nodes.values()], links };
}
