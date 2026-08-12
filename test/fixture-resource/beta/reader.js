import { readFileSync } from 'node:fs';
// NAMED import, multi-line — the reader half of the canonical shared-module layout.
// Written across lines on purpose: the import-line rule has to cover the whole
// statement, not just the line the keyword sits on.
import {
  GAME_STATE_PATH,
} from '../common/constants.js';

// TWO function-scoped readers in ONE file. Only one of them can be "the first
// occurrence", so a matcher that stops at the first mints a single edge and the other
// reader is invisible; both must get their own seam back to the writer. There is NO
// call edge of any kind between either of these and alphaWriteState — the shared
// resource is the only join.
export function betaReadState() {
  return JSON.parse(readFileSync(GAME_STATE_PATH, 'utf8'));
}

export function betaReadStateRaw() {
  return readFileSync(GAME_STATE_PATH, 'utf8');
}
