// Top-level extraction: walk -> parse each file -> populate the Graph with
// Compartment/File/Symbol nodes and DEFINED_IN edges, and accumulate raw
// (unresolved) calls that resolve.js will turn into CALLS edges.

import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { walkSources } from './walk.js';
import { parseSource, shapeCandidate } from './parse.js';
import { symbolId, moduleId } from '../model.js';

const MAX_BYTES = 2_000_000; // skip pathologically large/generated files

// fileFilter (optional): a Set of absolute paths. When present, only those files
// are parsed — the incremental path. The walker still discovers compartment roots
// so a changed file is attributed to the right compartment.
export function extractCode(graph, rootDir, log = () => {}, fileFilter = null) {
  const calls = []; // { fromId, compartment, relPath, name, line }
  const candidates = []; // contract signals; shape owned by shapeCandidate (parse.js)
  // `${compartment}\0${relPath}` -> [[start,end), …] comment ranges, from the SAME parse.
  // matchContracts scans raw file text and cannot see comments on its own; handing it
  // these is what stops a token mentioned only in prose from minting a REFERENCES edge.
  const comments = new Map();
  let fileCount = 0;

  for (const f of walkSources(rootDir)) {
    if (fileFilter && !fileFilter.has(f.abs)) continue;
    let source;
    try {
      source = readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    if (source.length > MAX_BYTES) continue;

    // Record the on-disk mtime+size so staleness can be "differs from what was
    // indexed" rather than "differs from the last git sha" (which never clears
    // for an uncommitted edit). Best-effort: a stat failure leaves them null.
    let mtime = null, size = null;
    try { const st = statSync(f.abs); mtime = st.mtimeMs; size = st.size; } catch { /* keep null */ }
    // Content hash (v5): the authoritative tiebreaker for the invalid-baseline
    // reconcile when mtime+size still MATCH — it catches a same-size, mtime-preserved
    // edit (cp -p / rsync -a / coarse-mtime FS) that mtime+size alone would miss.
    // Reuse `source` we already read (no second read); sha1 is change-detection only,
    // not security, so its speed is the point.
    const hash = createHash('sha1').update(source).digest('hex');

    graph.addCompartment(f.compartment, f.compartmentRoot);
    graph.addFile(f.compartment, f.relPath, f.lang, mtime, size, hash);
    graph.addEdge('IN_COMPARTMENT', `file:${f.compartment}:${f.relPath}`, `compartment:${f.compartment}`);

    // Synthetic module symbol owns top-level calls.
    const modId = moduleId(f.compartment, f.relPath);
    graph.addSymbol({
      id: modId, compartment: f.compartment, file: f.relPath, name: '<module>',
      kind: 'module', lang: f.lang, startLine: 0, endLine: 0,
    });
    graph.addEdge('DEFINED_IN', modId, `file:${f.compartment}:${f.relPath}`);

    let parsed;
    try {
      parsed = parseSource(source, f.lang, f.variant);
    } catch (e) {
      log(`  parse error in ${f.relPath}: ${e.message}`);
      continue;
    }

    // Mint global ids for this file's symbols (index-aligned with parsed.symbols).
    const localIds = parsed.symbols.map((s) => {
      const id = symbolId(f.compartment, f.relPath, s.name, s.startLine);
      graph.addSymbol({
        id, compartment: f.compartment, file: f.relPath, name: s.name, kind: s.kind,
        lang: f.lang, startLine: s.startLine, endLine: s.endLine,
      });
      graph.addEdge('DEFINED_IN', id, `file:${f.compartment}:${f.relPath}`);
      return id;
    });

    for (const c of parsed.calls) {
      const fromId = c.enclosing == null ? modId : localIds[c.enclosing];
      calls.push({ fromId, compartment: f.compartment, relPath: f.relPath, name: c.name, line: c.line });
    }
    for (const c of parsed.candidates || []) candidates.push(shapeCandidate(c, f));
    if (parsed.comments?.length) comments.set(`${f.compartment}\0${f.relPath}`, parsed.comments);

    fileCount++;
    if (fileCount % 200 === 0) log(`  parsed ${fileCount} files...`);
  }

  log(`  parsed ${fileCount} files total`);
  return { calls, candidates, comments };
}
