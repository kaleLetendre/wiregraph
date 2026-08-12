import { writeFileSync } from 'node:fs';
// NAMED import — the canonical shared-module layout (§11 join mechanism 1), and the
// exact shape that used to defeat the matcher: the FIRST word-bounded occurrence of
// the constant in this file is the import line at module scope, so a
// first-occurrence-only match handed the REFERENCES edge to <module> and left
// alphaWriteState with none. Both halves of the fix are exercised here — every
// enclosing symbol gets an edge, and an import line is not an occurrence.
// (These comments deliberately never spell the constant: a mention anywhere at file
// scope would mint exactly the module-scope edge this fixture must not have.)
import { GAME_STATE_PATH } from '../common/constants.js';

// FUNCTION-SCOPED writer of the shared game-state file.
export function alphaWriteState(state) {
  writeFileSync(GAME_STATE_PATH, JSON.stringify(state));
  return state;
}

// A wire call too, so a resource seam and a wire seam coexist in one build.
export async function alphaPing() {
  return fetch('/api/resource-ping', { method: 'POST' });
}
