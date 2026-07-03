// Graph model: deterministic node/edge identity so re-runs MERGE cleanly.
//
// Node kinds : Compartment, File, Symbol, Contract
// Edge kinds : IN_COMPARTMENT, DEFINED_IN, CALLS, REFERENCES, WIRE
//
// Every id is a stable string derived from content, never a random value, so a
// second build over unchanged code produces identical ids and the loader's
// upsert is a no-op rather than a duplicate.

export function compartmentId(name) {
  return `compartment:${name}`;
}

export function fileId(compartment, relPath) {
  return `file:${compartment}:${relPath}`;
}

// Symbols include the start line so two same-named functions in one file (or an
// overload set) stay distinct.
export function symbolId(compartment, relPath, name, startLine) {
  return `sym:${compartment}:${relPath}:${name}:${startLine}`;
}

// One synthetic "module" symbol per file owns any call made at top level
// (import-time side effects, route registration, etc.) so entrypoints are visible.
export function moduleId(compartment, relPath) {
  return `sym:${compartment}:${relPath}:<module>:0`;
}

export function contractId(name) {
  return `contract:${name}`;
}

// A mutable container the extractors fill and the loader drains.
//
// Every node carries a `project` (the init root that owns it, realpath) so the
// store can hold several projects' graphs side by side and the MCP server can
// scope every query to the active one. A project may span several compartments
// (a monorepo of packages/services, or several git repos) — `compartment` is the
// per-boundary name; `project` is the root.
export class Graph {
  constructor(project = null) {
    this.project = project;
    this.compartments = new Map(); // id -> {id, name, root, project}
    this.files = new Map(); // id -> {id, compartment, path, lang, mtime, size, project}
    this.symbols = new Map(); // id -> {id, compartment, file, name, kind, lang, startLine, endLine, project}
    this.contracts = new Map(); // id -> {id, name, kind, file, project}
    this.edges = []; // {type, from, to, props}
  }

  addCompartment(name, root) {
    const id = compartmentId(name);
    if (!this.compartments.has(id)) this.compartments.set(id, { id, name, root, project: this.project });
    return id;
  }

  addFile(compartment, path, lang, mtime = null, size = null) {
    const id = fileId(compartment, path);
    if (!this.files.has(id)) this.files.set(id, { id, compartment, path, lang, mtime, size, project: this.project });
    return id;
  }

  addSymbol(sym) {
    if (!this.symbols.has(sym.id)) this.symbols.set(sym.id, { ...sym, project: this.project });
    return sym.id;
  }

  addContract(c) {
    if (!this.contracts.has(c.id)) this.contracts.set(c.id, { ...c, project: this.project });
    return c.id;
  }

  addEdge(type, from, to, props = {}) {
    this.edges.push({ type, from, to, props });
  }

  stats() {
    const byKind = {};
    for (const e of this.edges) byKind[e.type] = (byKind[e.type] || 0) + 1;
    return {
      compartments: this.compartments.size,
      files: this.files.size,
      symbols: this.symbols.size,
      contracts: this.contracts.size,
      edges: this.edges.length,
      edgesByType: byKind,
    };
  }
}
