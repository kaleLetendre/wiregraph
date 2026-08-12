import { writeFileSync } from 'node:fs';

// Defined and used in ONE compartment only. Internal state, not a seam — the call graph
// already covers it.
const SOLO_STATE_PATH = '/var/run/infer/solo.json';

export function soloWrite() {
  writeFileSync(SOLO_STATE_PATH, 'x');
}
