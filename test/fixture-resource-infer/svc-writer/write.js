import { writeFileSync } from 'node:fs';
import { SHARED_STATE_PATH } from '../shared/constants.js';

// Only ONE compartment defines the constant, so definitions alone find one compartment
// and no seam at all. This side is discovered by REFERENCE.
export function svcWriteState(state) {
  writeFileSync(SHARED_STATE_PATH, JSON.stringify(state));
}
