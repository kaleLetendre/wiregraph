import { readFileSync } from 'node:fs';

// §11 acceptance item 4, on the INFERENCE side: this compartment reads the very same
// file as svc-writer/svc-reader, but names only the bare STRING LITERAL and never the
// constant. The join key is the CONSTANT, so this side is MISSED — documented as
// intended, and pinned here so the limitation is a decision rather than an accident.
// Without a literal-only compartment in this fixture, nothing distinguished
// "inference keys on the constant" from "inference keys on the value".
export function literalOnlyRead() {
  return readFileSync('/var/run/infer/shared-state.json', 'utf8');
}
