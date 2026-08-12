import { statSync } from 'node:fs';
import * as shared from '../common/constants.js';

// A THIRD compartment that only ever READS — an additional reader, no writer.
export function gammaWatchState() {
  return statSync(shared.GAME_STATE_PATH).mtimeMs;
}

// The pure READER half of the dual-role resource above — gamma reads the cache index
// zeta both writes and reads.
export function gammaCacheRead() {
  return statSync(shared.CACHE_INDEX_PATH).size;
}
