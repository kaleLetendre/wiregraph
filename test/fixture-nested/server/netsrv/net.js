// netsrv: serves /api/state. It ALSO names /ui/frame in a route table, but /ui/frame is
// declared only by client/contracts/ — a contracts dir that governs client/ and nothing
// else — so this mention must mint NO reference. Same for /harness/probe, which the OUTER
// contract does declare and which therefore DOES match here.
export function serveState() {
  return route('/api/state');
}
export function serveProbe() {
  return route('/harness/probe');
}
export function frameTableEntry() {
  return route('/ui/frame');
}
function route(p) { return p; }
