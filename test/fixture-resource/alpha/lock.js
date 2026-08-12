import { writeFileSync } from 'node:fs';
import * as shared from '../common/constants.js';

export function alphaTakeLock() {
  writeFileSync(shared.LOCK_FILE_PATH, String(process.pid));
}
