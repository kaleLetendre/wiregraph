// client/input_handling — samples keyboard/pointer, packages input frames (§04).
// Present so the client half has the same four compartments the flagship declares; it
// only names the all-levels probe token.
export function sample(): string {
  return pack('/shared/probe');
}

function pack(p: string): string {
  return p;
}
