import { readFileSync } from 'node:fs';
import { SHARED_STATE_PATH } from '../shared/constants.js';

export function svcReadState() {
  return JSON.parse(readFileSync(SHARED_STATE_PATH, 'utf8'));
}
