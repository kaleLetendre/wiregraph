// Graph model: deterministic node/edge identity so re-runs MERGE cleanly.
//
// Node kinds : Repo, File, Symbol, Contract
// Edge kinds : IN_REPO, DEFINED_IN, CALLS, REFERENCES, WIRE
//
// Every id is a stable string derived from content, never a random value, so a
// second build over unchanged code produces identical ids and the loader's
// upsert is a no-op rather than a duplicate.

export function repoId(name) {
  return `repo:${name}`;
}

export function fileId(repo, relPath) {
  return `file:${repo}:${relPath}`;
}

// Symbols include the start line so two same-named functions in one file (or an
// overload set) stay distinct.
export function symbolId(repo, relPath, name, startLine) {
  return `sym:${repo}:${relPath}:${name}:${startLine}`;
}

// One synthetic "module" symbol per file owns any call made at top level
// (import-time side effects, route registration, etc.) so entrypoints are visible.
export function moduleId(repo, relPath) {
  return `sym:${repo}:${relPath}:<module>:0`;
}

export function contractId(name) {
  return `contract:${name}`;
}

// A mutable container the extractors fill and the loader drains.
//
// Every node carries a `project` (the init root that owns it, realpath) so the
// store can hold several projects' graphs side by side and the MCP server can
// scope every query to the active one. A project may span several git repos
// (a multi-repo workspace) — `repo` stays the per-.git name; `project` is the root.
export class Graph {
  constructor(project = null) {
    this.project = project;
    this.repos = new Map(); // id -> {id, name, root, project}
    this.files = new Map(); // id -> {id, repo, path, lang, project}
    this.symbols = new Map(); // id -> {id, repo, file, name, kind, lang, startLine, endLine, project}
    this.contracts = new Map(); // id -> {id, name, kind, file, project}
    this.edges = []; // {type, from, to, props}
  }

  addRepo(name, root) {
    const id = repoId(name);
    if (!this.repos.has(id)) this.repos.set(id, { id, name, root, project: this.project });
    return id;
  }

  addFile(repo, path, lang) {
    const id = fileId(repo, path);
    if (!this.files.has(id)) this.files.set(id, { id, repo, path, lang, project: this.project });
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
      repos: this.repos.size,
      files: this.files.size,
      symbols: this.symbols.size,
      contracts: this.contracts.size,
      edges: this.edges.length,
      edgesByType: byKind,
    };
  }
}
