// The PROVIDER crate of the ecs-sim in-process contract.
//
// Nothing here imports sim and nothing here calls into it: the coupling runs one way, and
// the only thing joining the two crates is that sim's source spells the names this crate
// exports. resolve.js refuses to resolve a call across a compartment boundary by name, so
// without the contract these two crates index as two disconnected islands.
//
// `World` and `Scheduler` are deliberately SHORT, common type names — the exact shape the
// flagship's frozen ECS signatures have, and the one that fails extract/distinctive.js.
// render/ spells `World` for its own unrelated purpose, which is how the false-positive
// behaviour documented in extract/inproc-spec.js is pinned rather than asserted.

pub struct World {
    entities: Vec<u32>,
}

pub struct Scheduler {
    tick: u64,
}

// Declared in the contract, defined and used HERE, and named by NOTHING in sim — the
// one-sided drift class (provider side present, consumer half missing).
pub struct ComponentStore {
    len: usize,
}

impl World {
    pub fn new() -> World {
        World { entities: Vec::new() }
    }

    pub fn store(&self) -> ComponentStore {
        ComponentStore { len: self.entities.len() }
    }
}

impl Scheduler {
    pub fn new() -> Scheduler {
        Scheduler { tick: 0 }
    }

    pub fn advance(&mut self) -> u64 {
        self.tick += 1;
        self.tick
    }
}

pub fn spawn_entity(w: &mut World) -> u32 {
    let id = w.entities.len() as u32;
    w.entities.push(id);
    id
}
