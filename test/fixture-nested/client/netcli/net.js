// netcli: calls the server's /api/state over the wire (OUTER contract) and receives
// /ui/frame from world_state (INNER client contract).
export function fetchState() {
  return call('/api/state');
}
export function onFrame() {
  return call('/ui/frame');
}
function call(p) { return p; }
