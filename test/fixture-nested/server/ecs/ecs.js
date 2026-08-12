// ecs: produces the internal tick the simulation consumes. Inner (server) contract only.
export function ecsStep() {
  return post('/internal/tick', { frame: 1 });
}
function post(route, body) { return { route, body }; }
