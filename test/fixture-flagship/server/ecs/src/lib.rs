// server/ecs — the bottom of the server stack (project-structure.md §03: "deps: —").
// It is the ONLY compartment under server/ecs/, which is what makes the LEVEL-3
// contracts dir beneath it a scope that excludes even its own sibling `sim`.

// Declared by server/contracts/ecs-sim (LEVEL 2). ecs is the producer.
pub fn ecs_step() -> &'static str {
    "/tick/loop"
}

// Declared by server/ecs/contracts/queries-storage (LEVEL 3), which the test writes in
// after first proving the dir is inert while empty. `sim` names this token too, one level
// UP, and must not match it — that is the level-3 scope.
pub fn ecs_query_storage() -> &'static str {
    "/ecs/storage/read"
}

// Declared at ALL THREE levels. Under server/ecs/ the deepest declaration owns it.
pub fn ecs_probe() -> &'static str {
    "/shared/probe"
}
