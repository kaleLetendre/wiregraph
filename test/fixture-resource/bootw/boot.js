import { writeFileSync } from 'node:fs';

// VENDORED copy of the constant — this compartment does NOT import the shared
// module, so there is no IMPORTS edge to the reader side. The resource contract is
// the only join. The write also happens at MODULE SCOPE (import-time side effect),
// so the reference is attributed to the file's synthetic <module> symbol.
const BOOT_FLAG_PATH = '/var/run/game/booted.flag';

writeFileSync(BOOT_FLAG_PATH, 'up');
