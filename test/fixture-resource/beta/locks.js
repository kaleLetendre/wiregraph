import { existsSync } from 'node:fs';
import * as shared from '../common/constants.js';

export function betaLockHeld() {
  return existsSync(shared.LOCK_FILE_PATH);
}
