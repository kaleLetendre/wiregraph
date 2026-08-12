// harness sits in NO inner contracts subtree, so only the outer contract can reach it.
// /vendored/only and /dist/only are declared solely by specs under IGNORE_DIRS dirs, so a
// correct recursive discovery never sees them and these mentions mint nothing.
export function driveProbe() {
  return hit('/harness/probe');
}
export function driveState() {
  return hit('/api/state');
}
export function driveVendored() {
  return hit('/vendored/only') + hit('/dist/only');
}
function hit(p) { return p; }
