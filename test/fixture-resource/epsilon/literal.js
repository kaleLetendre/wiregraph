import { readFileSync } from 'node:fs';

// DOCUMENTED LIMITATION, exercised on purpose: this compartment reads the same file
// but names only the bare STRING LITERAL, never the shared constant. wiregraph is
// literal-blind by design, so this side is MISSED — no REFERENCES edge, no seam.
export function epsilonPeek() {
  return readFileSync('/var/run/game/state.json', 'utf8');
}
