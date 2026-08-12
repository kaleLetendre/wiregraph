// The CONSUMER crate. It genuinely uses ecs's types — this is not a fixture that merely
// mentions them.
//
// The `use` line below is an IMPORT and mints nothing (extract/contracts.js
// importLineFlags has a Rust `use` arm precisely so a crate that only names a symbol in
// its use-tree is not promoted to a participant). Every reference that counts is in a
// body or a field type.

use ecs::{spawn_entity, Scheduler, World};

pub struct Simulation {
    scheduler: Scheduler,
    world: World,
}

impl Simulation {
    pub fn new() -> Simulation {
        Simulation { scheduler: Scheduler::new(), world: World::new() }
    }

    pub fn step(&mut self) -> u32 {
        self.scheduler.advance();
        spawn_entity(&mut self.world)
    }
}

pub fn build_world() -> World {
    let mut w = World::new();
    spawn_entity(&mut w);
    w
}
