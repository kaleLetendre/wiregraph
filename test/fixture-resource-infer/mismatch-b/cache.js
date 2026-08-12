import { readFileSync } from 'node:fs';

const CONFLICT_CACHE_PATH = '/var/cache/infer/b.idx';

export function mismatchBRead() {
  return readFileSync(CONFLICT_CACHE_PATH, 'utf8');
}
