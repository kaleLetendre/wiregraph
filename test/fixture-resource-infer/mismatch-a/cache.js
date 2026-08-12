import { readFileSync } from 'node:fs';

// SAME NAME, DIFFERENT VALUE as mismatch-b. Two compartments that agree on a spelling
// and disagree on what it points at are not coupled to anything — this must NOT be a
// seam, and matching on the name alone would call it one.
const CONFLICT_CACHE_PATH = '/var/cache/infer/a.idx';

export function mismatchARead() {
  return readFileSync(CONFLICT_CACHE_PATH, 'utf8');
}
