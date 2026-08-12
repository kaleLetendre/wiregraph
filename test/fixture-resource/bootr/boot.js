import { existsSync } from 'node:fs';

// The reader half of the vendored pair — its own copy of the constant, read at
// MODULE SCOPE.
const BOOT_FLAG_PATH = '/var/run/game/booted.flag';

export const booted = existsSync(BOOT_FLAG_PATH);
