// server/sim — the world (§03). Consumes ecs's tick, produces the per-tick snapshot that
// server/network encodes. Names /ecs/storage/read even though that token belongs to the
// LEVEL-3 contract one directory deeper: a sibling inside the SAME level-2 scope is still
// outside a level-3 scope, and nothing but the scope test excludes it.
use std::fmt::Debug;

pub fn sim_on_tick() -> &'static str {
    "/tick/loop"
}

// The two snapshot tokens of server/contracts/sim-network. sim is the PRODUCER of both.
pub fn sim_publish_delta() -> &'static str {
    "/snapshot/delta"
}

pub fn sim_publish_frame() -> &'static str {
    "/snapshot/frame"
}

// One level UP from the level-3 contracts dir that declares this. Must mint nothing.
pub fn sim_peek_storage() -> &'static str {
    "/ecs/storage/read"
}

pub fn sim_probe() -> impl Debug {
    "/shared/probe"
}
