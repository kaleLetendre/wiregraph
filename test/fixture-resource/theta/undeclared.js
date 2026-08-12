import { existsSync } from 'node:fs';
import { BOOT_FLAG_PATH } from '../common/constants.js';

// An UNDECLARED PARTICIPANT: theta references the resource constant, and
// contracts/game-state.resource.yaml names it as NEITHER a writer nor a reader of
// BOOT_FLAG_PATH. It therefore derives no RESOURCE edge at all — the seam it is
// silently part of is invisible in the edge set, which is exactly why it has to be
// surfaced as its own finding.
//
// This is what an honest "single-writer" story looks like: wiregraph cannot tell
// whether this touch is a write or a read (there is no write detection), so it cannot
// say theta breaks the discipline. It CAN say the spec does not account for theta.
export function thetaPeekBootFlag() {
  return existsSync(BOOT_FLAG_PATH);
}
