import { writeFileSync } from 'node:fs';

// VENDORED layout: this compartment holds its OWN copy of the constant, so it imports
// nothing across a compartment boundary and no IMPORTS edge exists to resolve through.
// The only available join is same NAME *and* same VALUE.
const VENDORED_LOCK_PATH = '/var/run/infer/vendored.lock';

export function vendATakeLock() {
  writeFileSync(VENDORED_LOCK_PATH, 'a');
}
