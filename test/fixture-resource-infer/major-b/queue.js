import { readFileSync } from 'node:fs';

export const MAJORITY_QUEUE_PATH = '/var/spool/infer/q';

export function majorBDrain() {
  return readFileSync(MAJORITY_QUEUE_PATH, 'utf8');
}
