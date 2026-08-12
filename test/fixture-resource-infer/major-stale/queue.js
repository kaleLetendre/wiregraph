import { readFileSync } from 'node:fs';

// The stale copy — same name, an older path. This compartment is NOT part of the seam
// (it is not coupled to the other two), but the other two still are.
export const MAJORITY_QUEUE_PATH = '/var/spool/infer/q-old';

export function majorStaleDrain() {
  return readFileSync(MAJORITY_QUEUE_PATH, 'utf8');
}
