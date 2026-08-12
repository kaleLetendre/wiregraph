import { readFileSync } from 'node:fs';

export function localBRead() {
  const LOCAL_SCRATCH_PATH = '/var/tmp/infer/scratch';
  return readFileSync(LOCAL_SCRATCH_PATH, 'utf8');
}
