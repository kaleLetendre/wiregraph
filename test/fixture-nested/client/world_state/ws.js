// world_state: produces /ui/frame for netcli. Also names /internal/tick, which is
// declared ONLY by server/contracts/ — governing server/ — so it must mint nothing.
export function emitFrame() {
  return send('/ui/frame');
}
export function tickMirror() {
  return send('/internal/tick');
}
function send(p) { return p; }
