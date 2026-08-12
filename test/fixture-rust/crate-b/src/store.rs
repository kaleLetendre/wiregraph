// The second Cargo.toml compartment. It VENDORS its own copy of GAME_SOCK_PATH — same
// NAME, same VALUE — and there is no cross-compartment import between the two crates
// (`use` is crate-relative, and wiregraph emits no import candidates for Rust at all), so
// name+value is the only join available. That is the vendored-copy resource seam.
use std::env;

pub const GAME_SOCK_PATH: &str = "/var/run/wiregraph-fixture/game.sock";

// Same NAME and same VALUE as crate-a's function-local — but both are locals, so neither
// is extracted and the pair must NOT become a seam.
pub fn scratch() -> usize {
    const LOCAL_SCRATCH_PATH: &str = "/tmp/wiregraph-fixture/scratch";
    LOCAL_SCRATCH_PATH.len()
}

pub fn connect() -> String {
    let overridden = env::var("WIREGRAPH_FIXTURE_SOCK");
    match overridden {
        Ok(v) => v,
        Err(_) => String::from(GAME_SOCK_PATH),
    }
}
