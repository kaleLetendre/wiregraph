// server/host — channel construction, thread + runtime startup, no logic of its own
// (§02). It is the READER half of the REPLAY_LOG_PATH resource contract, with its own
// vendored copy of the constant.
pub const REPLAY_LOG_PATH: &str = "/var/run/flagship/replay.log";

pub fn tail_replay() -> usize {
    REPLAY_LOG_PATH.len()
}

pub fn host_probe() -> &'static str {
    "/shared/probe"
}
