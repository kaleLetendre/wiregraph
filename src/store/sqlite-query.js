// Query layer for the SQLite backend — implements the same tools as the Neo4j
// MCP server (graph_stats, find_symbol, get_source, trace_callers/callees,
// path_between, trace_contract), scoped to a project, returning the same text
// shapes. Graph traversals run as in-JS BFS over the edge rows (the graph is
// small), which is simpler and faster here than recursive SQL.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const isTest = (f) => f.includes('tests/') || f.includes('/test/') || f.includes('.test.') || f.includes('_test.') || f.includes('/test_');
const loc = (n) => `${n.compartment}:${n.file}:${n.startLine} ${n.name}${n.kind && n.kind !== 'function' ? ` (${n.kind})` : ''}`;

function symbolMatches(db, project, name, compartment, file) {
  let q = `SELECT id,compartment,file,name,kind,startLine,endLine FROM symbols
           WHERE project=@project AND name=@name AND kind <> 'module'`;
  if (compartment) q += ' AND compartment=@compartment';
  if (file) q += ' AND instr(file,@file)>0';
  return db.prepare(q + ' ORDER BY compartment,file,startLine').all({ project, name, compartment, file });
}

// Absolute path -> {mtime, size} for every indexed file in the project. The abs
// path is reconstructed from the file's compartment root, matching what
// changedSince and build.js produce, so the keys line up for staleness comparison.
export function indexedFiles(db, project) {
  const rows = db.prepare(
    `SELECT f.path AS path, f.mtime AS mtime, f.size AS size, c.root AS root
       FROM files f JOIN compartments c ON c.project = f.project AND c.name = f.compartment
      WHERE f.project = ?`,
  ).all(project);
  const m = new Map();
  for (const r of rows) m.set(join(r.root, r.path), { mtime: r.mtime, size: r.size });
  return m;
}

// Of the given candidate absolute paths, which actually differ from what's indexed
// — changed on disk (mtime/size mismatch), newly added (not indexed), or deleted
// (gone from disk)? This is independent of git commit state, so a file that was
// edited, re-indexed, but not yet committed is correctly reported as FRESH (its
// recorded mtime matches disk) instead of stale forever. mtime is compared with a
// 1ms tolerance to absorb float/filesystem rounding.
export function staleAmong(db, project, candidates) {
  if (!candidates || !candidates.length) return [];
  const indexed = indexedFiles(db, project);
  const stale = [];
  for (const abs of candidates) {
    let st;
    try { st = statSync(abs); } catch { stale.push(abs); continue; } // deleted/unreadable → re-index prunes it
    const rec = indexed.get(abs);
    if (!rec) { stale.push(abs); continue; } // present on disk but never indexed → new file
    if (rec.size !== st.size || Math.abs((rec.mtime ?? 0) - st.mtimeMs) > 1) stale.push(abs);
  }
  return stale;
}

export function graphStats(db, project) {
  const c = (t) => db.prepare(`SELECT count(*) n FROM ${t} WHERE project=?`).get(project).n;
  const nodes = { Compartment: c('compartments'), File: c('files'), Symbol: c('symbols'), Contract: c('contracts') };
  const edges = db.prepare('SELECT type, count(*) n FROM edges WHERE project=? GROUP BY type ORDER BY n DESC').all(project);
  const compartments = db.prepare("SELECT compartment, count(*) n FROM symbols WHERE project=? AND kind<>'module' GROUP BY compartment ORDER BY n DESC").all(project);
  if (!nodes.Symbol) return `No wiregraph for this project (${project}).`;
  return [
    `Project: ${project}`,
    'Nodes: ' + Object.entries(nodes).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(', '),
    'Edges: ' + edges.map((r) => `${r.type}=${r.n}`).join(', '),
    'Symbols per compartment:',
    ...compartments.map((r) => `  ${r.compartment}: ${r.n}`),
  ].join('\n');
}

export function findSymbol(db, project, name, repo) {
  const rows = symbolMatches(db, project, name, repo).slice(0, 100);
  if (!rows.length) return `No symbol named "${name}"${repo ? ` in ${repo}` : ''}.`;
  return `${rows.length} match(es) for "${name}":\n` + rows.map((r) => '  ' + loc(r)).join('\n');
}

export function getSource(db, project, name, repo, file, context = 0) {
  const rows = symbolMatches(db, project, name, repo, file).filter((r) => r.endLine >= r.startLine && r.startLine > 0);
  if (!rows.length) return `No symbol named "${name}"${repo ? ` in ${repo}` : ''} with a known line span.`;
  if (rows.length > 1 && !file && !repo) {
    return `"${name}" is ambiguous (${rows.length}). Narrow with compartment/file:\n` +
      rows.map((r) => `  ${r.compartment}:${r.file}:${r.startLine} ${r.name}`).join('\n');
  }
  const r = rows[0];
  const root = db.prepare('SELECT root FROM compartments WHERE project=? AND name=?').get(project, r.compartment)?.root;
  let lines;
  try { lines = readFileSync(join(root, r.file), 'utf8').split('\n'); }
  catch (e) { return `Could not read ${r.file}: ${e.message}`; }
  const ctx = Math.max(0, Math.min(20, Math.floor(Number(context) || 0)));
  const from = Math.max(1, r.startLine - ctx);
  const MAX = 400;
  let to = Math.min(lines.length, r.endLine + ctx), truncated = false;
  if (to - from + 1 > MAX) { to = from + MAX - 1; truncated = true; }
  const body = lines.slice(from - 1, to).map((ln, i) => `${from + i}\t${ln}`).join('\n');
  const header = `${r.compartment}:${r.file}:${r.startLine}-${r.endLine} ${r.name}${r.kind && r.kind !== 'function' ? ` (${r.kind})` : ''}`;
  return header + '\n' + body + (truncated ? `\n… (truncated at ${MAX} lines)` : '');
}

// Shared CALLS adjacency + symbol metadata for a project.
// NOTE (deferred perf): this rebuilds the full CALLS adjacency on every trace_*
// call (O(edges) — a few ms at a few-thousand-node scale). Negligible here; if wiregraph ever
// targets much larger graphs, memoize this per (db, project) for the process.
function callGraph(db, project) {
  const meta = new Map();
  for (const s of db.prepare('SELECT id,compartment,file,name,kind,startLine FROM symbols WHERE project=?').all(project)) meta.set(s.id, s);
  const fwd = new Map(); // src -> [{dst,count,resolution}]
  const rev = new Map(); // dst -> [{src,...}]
  for (const e of db.prepare("SELECT src,dst,cnt,resolution FROM edges WHERE project=? AND type='CALLS'").all(project)) {
    (fwd.get(e.src) || fwd.set(e.src, []).get(e.src)).push({ dst: e.dst, count: e.cnt, resolution: e.resolution });
    (rev.get(e.dst) || rev.set(e.dst, []).get(e.dst)).push({ dst: e.src, count: e.cnt, resolution: e.resolution });
  }
  return { meta, fwd, rev };
}

function trace(db, project, name, repo, file, depth, direction, includeTests) {
  const d = Math.max(1, Math.min(8, Math.floor(Number(depth) || 3)));
  const seeds = symbolMatches(db, project, name, repo, file);
  if (!seeds.length) return { seeds: [], text: null };
  if (seeds.length > 1 && !repo && !file) {
    return { seeds, text: `"${name}" is ambiguous (${seeds.length} defs). Narrow with compartment/file:\n` + seeds.map((s) => '  ' + loc(s)).join('\n') };
  }
  const { meta, fwd, rev } = callGraph(db, project);
  const adj = direction === 'callers' ? rev : fwd;

  // reachable set within d hops, and the parent->children adjacency among them
  const seed = seeds[0];
  const childrenOf = new Map();
  const seen = new Set([seed.id]);
  let frontier = [seed.id];
  // Match Neo4j semantics `(seed)-[:CALLS*0..d]->(a)-[e:CALLS]->(b)`: the seed's
  // subgraph includes nodes up to d hops away (the `a`s) PLUS their direct
  // children (`b`, at depth d+1). So expand depth 0..d inclusive.
  for (let hop = 0; hop <= d; hop++) {
    const next = [];
    for (const id of frontier) {
      for (const k of (adj.get(id) || [])) {
        const m = meta.get(k.dst);
        if (!m) continue;
        if (!includeTests && isTest(m.file)) continue;
        if (!childrenOf.has(id)) childrenOf.set(id, []);
        childrenOf.get(id).push({ id: k.dst, count: k.count, resolution: k.resolution });
        if (!seen.has(k.dst)) { seen.add(k.dst); next.push(k.dst); }
      }
    }
    frontier = next;
  }

  const out = [];
  const shown = new Set([seed.id]);
  const arrow = direction === 'callers' ? '◄ ' : '→ ';
  // Count EVERY ambiguous edge encountered (even ones whose subtree is collapsed as
  // "already shown"), so the trace-level caveat below reflects the true uncertainty
  // — the per-line "~ambiguous" marker is dropped on a second visit, and the model
  // is told to trust results, so uncertainty must also travel as a header.
  let ambCount = 0;
  function walk(id, prefix, depthN) {
    const kids = (childrenOf.get(id) || []).slice().sort((x, y) => (y.count || 0) - (x.count || 0));
    for (const k of kids) {
      const m = meta.get(k.id) || {};
      const isAmb = k.resolution === 'ambiguous';
      if (isAmb) ambCount++;
      out.push(`${prefix}${arrow}${m.file}:${m.startLine} ${m.name}${isAmb ? ' ~ambiguous' : ''}`);
      if (!shown.has(k.id) && depthN < 12) { shown.add(k.id); walk(k.id, prefix + '   ', depthN + 1); }
      else if (childrenOf.has(k.id)) out.push(`${prefix}   … (already shown)`);
    }
  }
  const head = `${seed.compartment}:${seed.file}:${seed.startLine} ${seed.name}`;
  walk(seed.id, '', 0);
  const note = includeTests ? '' : '\n(test files excluded; includeTests=true to show)';
  // Data-triggered caveat: only when the tree actually holds ambiguous edges, so a
  // clean trace pays nothing. Calls resolve by NAME, so a collision fans one call to
  // several same-named symbols — those branches are possibilities, not facts.
  const ambNote = ambCount
    ? `\n⚠ ${ambCount} branch(es) marked ~ambiguous: the call resolves by name and collided with several same-named symbols — treat those as one-of-several, not certainty. (Also blind to callback/function-pointer and string-literal dispatch.)`
    : '';
  if (!out.length) return { seeds, text: `${loc(seed)}\n  (${direction === 'callers' ? 'no resolvable callers' : 'calls nothing resolvable'} within its compartment)` };
  return { seeds, text: head + '\n' + out.join('\n') + note + ambNote };
}

export function traceCallers(db, project, name, repo, file, depth, includeTests) {
  return trace(db, project, name, repo, file, depth, 'callers', includeTests).text || `No symbol named "${name}".`;
}
export function traceCallees(db, project, name, repo, file, depth, includeTests) {
  return trace(db, project, name, repo, file, depth, 'callees', includeTests).text || `No symbol named "${name}".`;
}

export function traceContract(db, project, contract, token, includeTests) {
  let q = `SELECT c.name contract, s.compartment compartment, s.file file, s.name name, s.startLine startLine, e.token token
           FROM edges e JOIN symbols s ON s.id=e.src JOIN contracts c ON c.id=e.dst
           WHERE e.project=@project AND e.type='REFERENCES' AND lower(c.name) LIKE '%'||lower(@contract)||'%'`;
  if (token) q += ' AND e.token=@token';
  const rows = db.prepare(q + ' ORDER BY c.name,s.compartment,s.file,s.startLine').all({ project, contract, token });
  const filtered = rows.filter((r) => includeTests || !isTest(r.file));
  if (!filtered.length) return `No symbols reference a contract matching "${contract}"${token ? ` via token "${token}"` : ''}.`;
  // aggregate tokens per (contract,compartment,file,name,line)
  const byKey = new Map();
  for (const r of filtered) {
    const k = `${r.contract}|${r.compartment}|${r.file}|${r.name}|${r.startLine}`;
    if (!byKey.has(k)) byKey.set(k, { ...r, tokens: [] });
    if (r.token && !byKey.get(k).tokens.includes(r.token)) byKey.get(k).tokens.push(r.token);
  }
  const byContract = new Map();
  for (const r of byKey.values()) {
    if (!byContract.has(r.contract)) byContract.set(r.contract, new Map());
    const compartments = byContract.get(r.contract);
    if (!compartments.has(r.compartment)) compartments.set(r.compartment, []);
    compartments.get(r.compartment).push(r);
  }
  const out = [];
  for (const [cname, compartments] of byContract) {
    out.push(`Contract: ${cname}`);
    for (const [compartment, list] of compartments) {
      out.push(`  [${compartment}]`);
      for (const r of list) {
        const toks = r.tokens.slice(0, 10).join(', ') + (r.tokens.length > 10 ? `, +${r.tokens.length - 10} more` : '');
        out.push(`    ${r.file}:${r.startLine} ${r.name} — ${toks}`);
      }
    }
  }
  if (!includeTests) out.push('(test files excluded; includeTests=true to show)');
  return out.join('\n');
}

export function pathBetween(db, project, from, to, fromRepo, toRepo, maxHops = 12) {
  const hops = Math.max(1, Math.min(20, Math.floor(Number(maxHops) || 12)));
  // A path over CALLS+REFERENCES can route THROUGH a Contract node (the
  // cross-compartment case this tool exists for), so resolve labels against both
  // tables — symbols first, then contracts (which have a name but no
  // compartment/file). Mirrors Neo4j's generic
  // coalesce(compartment,'')+':'+coalesce(file,name)+... reconstruction.
  const node = (id) =>
    db.prepare('SELECT id,compartment,file,name FROM symbols WHERE id=?').get(id) ||
    db.prepare('SELECT id,NULL compartment,file,name FROM contracts WHERE id=?').get(id) ||
    { compartment: null, file: null, name: id };
  const starts = symbolMatches(db, project, from, fromRepo).map((r) => r.id);
  const goals = new Set(symbolMatches(db, project, to, toRepo).map((r) => r.id));
  if (!starts.length || !goals.size) return `No path found between "${from}" and "${to}" within ${hops} hops.`;
  // undirected adjacency over CALLS + REFERENCES + IMPORTS (cross-compartment deps)
  const adj = new Map();
  const add = (a, b, rel) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, rel }); };
  for (const e of db.prepare("SELECT src,dst,type FROM edges WHERE project=? AND type IN ('CALLS','REFERENCES','IMPORTS')").all(project)) {
    add(e.src, e.dst, e.type); add(e.dst, e.src, e.type);
  }
  // BFS
  const prev = new Map(); const seen = new Set(starts);
  let frontier = starts.map((id) => ({ id, depth: 0 }));
  let hit = null;
  while (frontier.length && !hit) {
    const next = [];
    for (const { id, depth } of frontier) {
      if (goals.has(id)) { hit = id; break; }
      if (depth >= hops) continue;
      for (const nb of (adj.get(id) || [])) {
        if (!seen.has(nb.to)) { seen.add(nb.to); prev.set(nb.to, { from: id, rel: nb.rel }); next.push({ id: nb.to, depth: depth + 1 }); }
      }
    }
    frontier = next;
  }
  if (!hit) for (const s of starts) if (goals.has(s)) hit = s;
  if (!hit) return `No path found between "${from}" and "${to}" within ${hops} hops.`;
  // reconstruct
  const chain = [hit]; const rels = [];
  let cur = hit;
  while (prev.has(cur)) { const p = prev.get(cur); rels.unshift(p.rel); chain.unshift(p.from); cur = p.from; }
  // Match Neo4j exactly: coalesce(compartment,'') + ':' + coalesce(file,name) + (file&&name ? ':'+name : '')
  const label = (id) => {
    const n = node(id);
    return `${n.compartment || ''}:${n.file || n.name}${n.file && n.name ? ':' + n.name : ''}`;
  };
  const parts = [];
  for (let i = 0; i < chain.length; i++) { parts.push(label(chain[i])); if (i < rels.length) parts.push(`  --[${rels[i]}]-->`); }
  return parts.join('\n');
}

// Raw read-only SQL escape hatch — the SQLite analogue of the old `cypher` tool,
// for structural questions the shaped tools don't cover. The db is per-project so
// every row already belongs to this project (no scoping needed). Only a single
// read-only SELECT/WITH…SELECT is allowed; anything that could mutate is rejected.
// This regex guard is the real protection: the server's "readonly" sql.js handle
// only means "don't persist on close" (the in-memory WASM db is itself writable),
// so a write that slipped past here would still be discarded on close — but we
// reject it up front rather than rely on that.
export function querySql(db, sql) {
  const q = String(sql || '').trim().replace(/;\s*$/, '');
  if (!q) return 'Empty query.';
  if (/;/.test(q)) return 'Refused: only a single statement is allowed (no ";").';
  if (!/^(SELECT|WITH)\b/i.test(q)) return 'Refused: only read-only SELECT (or WITH … SELECT) queries are allowed.';
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|LOAD_EXTENSION)\b/i.test(q)) {
    return 'Refused: query contains a write/admin keyword. This tool is read-only.';
  }
  let rows;
  try { rows = db.prepare(q).all(); }
  catch (e) { return 'SQL error: ' + e.message; }
  if (!rows.length) return '(no rows)';
  const capped = rows.slice(0, 200);
  return JSON.stringify(capped, null, 2) + (rows.length > 200 ? `\n… (${rows.length - 200} more rows omitted)` : '');
}
