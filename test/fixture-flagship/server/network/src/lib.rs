// server/network — transport, baselines, delta encoding (§03). One half of the
// `network` BASENAME COLLISION: client/network is the other, and neither directory is
// misnamed. Its inferred compartment name is therefore `server/network`, not `network`.

// The wire seam of contracts/server-client (LEVEL 1, whole tree).
pub fn serve_session() -> &'static str {
    "/ws/session"
}

// The two snapshot tokens of server/contracts/sim-network (LEVEL 2). This crate is the
// side those channels MEAN, whichever name the spec happens to spell.
pub fn encode_delta() -> &'static str {
    "/snapshot/delta"
}

pub fn encode_frame() -> &'static str {
    "/snapshot/frame"
}

// Declared ONLY by client/contracts (LEVEL 2, scope client/). A route table entry here
// must mint nothing — the mirror image of client/world_state naming /tick/loop.
pub fn present_table_entry() -> &'static str {
    "/ui/present"
}

pub fn network_probe() -> &'static str {
    "/shared/probe"
}

// --- resource contract ids ---------------------------------------------------
// VENDORED copies: server/host and client/network each hold their own `const` of the
// same NAME, so no import links them and the resource spec is the only join.
pub const REPLAY_LOG_PATH: &str = "/var/run/flagship/replay.log";
pub const SNAPSHOT_SHM_PATH: &str = "/dev/shm/flagship-snapshot";

pub fn append_replay(line: &str) -> usize {
    REPLAY_LOG_PATH.len() + line.len()
}

pub fn publish_shm() -> usize {
    SNAPSHOT_SHM_PATH.len()
}
