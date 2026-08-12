import { existsSync } from 'node:fs';

const VENDORED_LOCK_PATH = '/var/run/infer/vendored.lock';

export function vendBLockHeld() {
  return existsSync(VENDORED_LOCK_PATH);
}
