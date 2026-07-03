// Library/SDK boundary resolution: turn cross-compartment import specifiers into
// direct IMPORTS edges. Unlike the token-matched contracts (wire/message/state),
// an import is a real, explicit dependency — so it's safe to link across
// compartments by name (resolveCalls deliberately won't). Scope: TS/JS
// package-name + relative imports, and C #include "..." relative paths.
// Same-compartment imports are skipped (only cross-compartment boundaries are contracts).
//
// Edges connect the importing file's <module> symbol to the target file's
// <module> symbol, so they coexist with CALLS and are traversable by path_between.

import { readFileSync } from 'node:fs';
import { join, dirname, resolve as pathResolve, relative } from 'node:path';
import { fileId, moduleId } from '../model.js';

const TS_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// Resolve import candidates against the built graph. Returns [{ from, to }] of
// <module> symbol ids to add as IMPORTS edges (deduped, cross-compartment only).
export function resolveImports(candidates, graph) {
  const imports = candidates.filter((c) => c.kind === 'import');
  if (!imports.length) return [];

  // Per-compartment metadata: root + package.json name + entry (for package imports).
  const compartments = [];
  for (const r of graph.compartments.values()) {
    let pkgName = null, entry = 'index.js';
    try {
      const pj = JSON.parse(readFileSync(join(r.root, 'package.json'), 'utf8'));
      pkgName = pj.name || null;
      entry = pj.module || pj.main || 'index.js';
    } catch { /* no/invalid package.json — package imports just won't resolve here */ }
    compartments.push({ name: r.name, root: r.root, pkgName, entry });
  }
  const has = (compartment, rel) => graph.files.has(fileId(compartment, rel));

  // First existing file among `relNoExt` + common extensions / index files.
  const pick = (compartment, relNoExt) => {
    for (const ext of TS_EXT) if (has(compartment, relNoExt + ext)) return relNoExt + ext;
    for (const idx of ['index.ts', 'index.js']) if (has(compartment, join(relNoExt, idx))) return join(relNoExt, idx);
    if (has(compartment, relNoExt + '.h')) return relNoExt + '.h';
    if (has(compartment, relNoExt + '.c')) return relNoExt + '.c';
    return null;
  };

  const edges = [];
  const seen = new Set();
  for (const imp of imports) {
    const from = compartments.find((r) => r.name === imp.compartment);
    if (!from) continue;
    let target = null; // { compartment, rel }

    if (imp.token.startsWith('.')) {
      // relative import — resolve against the importing file's directory
      const abs = pathResolve(dirname(join(from.root, imp.file)), imp.token);
      let best = null;
      for (const r of compartments) {
        if (abs === r.root || abs.startsWith(r.root + '/')) { if (!best || r.root.length > best.root.length) best = r; }
      }
      if (best && best.name !== imp.compartment) {
        const rel = pick(best.name, relative(best.root, abs));
        if (rel) target = { compartment: best.name, rel };
      }
    } else {
      // bare specifier — match against another compartment's package.json name
      for (const r of compartments) {
        if (!r.pkgName || r.name === imp.compartment) continue;
        if (imp.token === r.pkgName || imp.token.startsWith(r.pkgName + '/')) {
          const entryNoExt = r.entry.replace(/\.[cm]?[jt]sx?$/, '');
          const rel = pick(r.name, entryNoExt);
          if (rel) target = { compartment: r.name, rel };
          break;
        }
      }
    }

    if (!target) continue;
    const fromId = moduleId(imp.compartment, imp.file);
    const toId = moduleId(target.compartment, target.rel);
    const key = `${fromId}\0${toId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: fromId, to: toId });
  }
  return edges;
}
