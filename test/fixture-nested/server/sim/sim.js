// sim: consumes the internal tick and produces the shared /api/state snapshot.
export function simOnTick() {
  return handle('/internal/tick');
}
export function simPublishState() {
  return handle('/api/state');
}
function handle(route) { return route; }
