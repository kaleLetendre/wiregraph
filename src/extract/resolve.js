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

import { CALLEE_QUALIFIER_SEP } from './parse.js';

const AMBIGUOUS_CAP = 6; // don't fan a single ambiguous call out to more than this

// A callee name may carry the TYPE it was reached through: `Vec::new`, `World::new`. Only
// Rust's rule produces one (see parse.js's CALLEE_QUALIFIER_SEP note) and it produces at
// most one separator, so a plain `lastIndexOf` recovers both halves. A name without the
// separator — every other language, and Rust's own module paths — is returned unqualified
// and takes the untouched path below.
function splitQualified(name) {
  const i = name.lastIndexOf(CALLEE_QUALIFIER_SEP);
  if (i <= 0) return { qualifier: null, member: name };
  return { qualifier: name.slice(0, i), member: name.slice(i + CALLEE_QUALIFIER_SEP.length) };
}

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
    const { qualifier, member } = splitQualified(c.name);
    const cands = byName.get(member);
    if (!cands || cands.length === 0) {
      unresolved++;
      continue;
    }
    const sameCompartment = cands.filter((s) => s.compartment === c.compartment);
    let scope;
    if (qualifier) {
      // `Type::member()`. The definition of `Type` is the only thing that says whether this
      // call can land here at all, and this is the first point in the pipeline that knows:
      // the parser sees one file, but the symbol table sees the compartment.
      //
      // Not a container in this compartment -> the type is EXTERNAL (`Vec`, `HashMap`,
      // `Instant`, a generic parameter, another crate's type) and the call leaves the
      // compartment. Unresolved, and deliberately NOT falling back to bare-name matching:
      // the fallback is precisely the fabrication — `Vec::new()` landing on every local
      // `new`. Counting it unresolved keeps the tally honest about what was skipped.
      const qFiles = new Set(
        (byName.get(qualifier) || [])
          .filter((s) => s.compartment === c.compartment && s.kind === 'class')
          .map((s) => s.file),
      );
      if (qFiles.size === 0) {
        unresolved++;
        continue;
      }
      // A local type. Prefer the file(s) that define it — that is what separates
      // `World::new` from a same-named `Scheduler::new` next door. When the type's inherent
      // impl lives in a DIFFERENT file from its declaration (legal, and something no
      // file-local signal can see) the narrowed set is empty, so fall back to the whole
      // compartment: same-name ambiguity, which is what this call already had.
      const narrowed = sameCompartment.filter((s) => qFiles.has(s.file));
      scope = narrowed.length ? narrowed : sameCompartment;
    } else {
      const sameFile = cands.filter((s) => s.compartment === c.compartment && s.file === c.relPath);
      scope = sameFile.length ? sameFile : sameCompartment;
    }

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
