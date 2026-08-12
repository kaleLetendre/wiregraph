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

// --- `new` is a convention, not a keyword -----------------------------------
// Every Rust crate has several inherent `new`s, so a callee reduced to its last path
// segment cannot tell them apart — nor tell any of them from `Vec::new()`. The TYPE
// qualifier is what does, and it has to survive as far as resolve.js, which is the first
// place that knows which types this compartment actually defines.
pub struct Cache {
    hits: usize,
}

impl Cache {
    pub fn new() -> Cache {
        Cache { hits: 0 }
    }
}

// `Vec` is not a type this crate defines, so `Vec::new()` is an EXTERNAL constructor and
// must reach nothing here. Reduced to `new` it landed on Cache::new instead — a fabricated
// edge out of a function that constructs no Cache at all.
pub fn slots() -> Vec<u32> {
    Vec::new()
}

// The same shape with a LOCAL type still resolves, and resolves to that type's own `new`.
pub fn warm() -> Cache {
    Cache::new()
}

// crate-a's names, spelled from crate-b. These two crates are separate compartments and
// resolution never crosses a compartment boundary by name, so neither may resolve — the
// FIRST cross-compartment call relationship in this fixture. Without it every CALLS
// assertion here was intra-compartment and the "no cross-compartment resolution" check
// had no call to be negative about.
pub fn borrow_names() -> i32 {
    let _s = crate_a::Service::new();
    crate_a::util(1)
}
