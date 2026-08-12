import { readFileSync, writeFileSync } from 'node:fs';
import { CACHE_INDEX_PATH } from '../common/constants.js';

// zeta is declared as BOTH a writer and a reader of this resource — it owns the cache
// index and also consumes it. That makes buildResourceEdges' intra-compartment guard
// REACHABLE: without it, zetaCacheWrite <-> zetaCacheRead would mint two phantom
// same-compartment "seams" for what is ordinary internal state the call graph already
// covers. Two distinct symbols on purpose — with only one, the earlier `w.id === r.id`
// check would mask the compartment guard entirely.
export function zetaCacheWrite(entries) {
  writeFileSync(CACHE_INDEX_PATH, JSON.stringify(entries));
}

export function zetaCacheRead() {
  return JSON.parse(readFileSync(CACHE_INDEX_PATH, 'utf8'));
}
