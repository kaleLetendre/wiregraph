import { writeFileSync } from 'node:fs';
import * as shared from '../common/constants.js';

// A SECOND writer of a resource declared single_writer — the flagged violation.
export function deltaTakeLock() {
  writeFileSync(shared.LOCK_FILE_PATH, 'delta');
}
