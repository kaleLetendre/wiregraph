import { writeFileSync } from 'node:fs';

// FUNCTION-LOCAL, in both compartments, with an identical value — the exact shape that
// made 19 of wiregraph's own 24 const candidates noise. Module scope is required at
// EXTRACTION time, so this name never becomes a candidate and never becomes a seam.
export function localAWrite() {
  const LOCAL_SCRATCH_PATH = '/var/tmp/infer/scratch';
  writeFileSync(LOCAL_SCRATCH_PATH, 'a');
}
