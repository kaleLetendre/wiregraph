// Resolve raw calls (caller symbol + callee *name*) into CALLS edges.
//
// MVP resolution is name-based with scope preference: a call resolves to a
// definition in the same file first, then anywhere in the same compartment. We
// never resolve a call across compartments by name — C and TS don't share a
// namespace, so a shared name like `start` would be a false edge. Genuine
// cross-compartment links flow through Contract nodes instead (see contracts.js).
//
// Unresolved calls (library functions, wire calls, macros) are counted, not
// edged, so the graph stays honest about what it actually connected.

const AMBIGUOUS_CAP = 6; // don't fan a single ambiguous call out to more than this

// extraDefs (optional): definitions from outside `graph` to resolve against —
// the incremental path passes the rest of the project's symbols (read from
// the graph db) so a changed file's outgoing calls still resolve to definitions in
// files we didn't re-parse. Each must look like {id, compartment, file, name, kind}.
export function resolveCalls(graph, calls, log = () => {}, extraDefs = null) {
  // Index definitions by name -> [{id, compartment, file}], excluding module symbols.
  const byName = new Map();
  const add = (s) => {
    if (s.kind === 'module') return;
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  };
  for (const s of graph.symbols.values()) add(s);
  if (extraDefs) for (const s of extraDefs) add(s);

  const edgeMap = new Map(); // `${from}->${to}` -> {from, to, count, line, resolution}
  let unresolved = 0;
  let ambiguousDropped = 0;

  for (const c of calls) {
    const cands = byName.get(c.name);
    if (!cands || cands.length === 0) {
      unresolved++;
      continue;
    }
    const sameFile = cands.filter((s) => s.compartment === c.compartment && s.file === c.relPath);
    const sameCompartment = cands.filter((s) => s.compartment === c.compartment);
    const scope = sameFile.length ? sameFile : sameCompartment;

    if (scope.length === 0) {
      unresolved++; // only cross-compartment name matches existed -> not a real call
      continue;
    }
    if (scope.length > AMBIGUOUS_CAP) {
      ambiguousDropped++;
      continue;
    }
    const resolution = scope.length === 1 ? 'unique' : 'ambiguous';
    for (const target of scope) {
      if (target.id === c.fromId) continue; // drop trivial self-loops
      const key = `${c.fromId}->${target.id}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        edgeMap.set(key, {
          from: c.fromId, to: target.id, count: 1, line: c.line, resolution,
        });
      }
    }
  }

  for (const e of edgeMap.values()) {
    graph.addEdge('CALLS', e.from, e.to, {
      evidence: 'static',
      resolution: e.resolution,
      count: e.count,
      line: e.line,
    });
  }

  log(`  resolved ${edgeMap.size} CALLS edges; ${unresolved} unresolved, ${ambiguousDropped} over-ambiguous dropped`);
  return { resolved: edgeMap.size, unresolved, ambiguousDropped };
}
