// run() reaches three of the four Rust callee shapes at once: a same-file free function
// (helper — a plain `identifier`), an associated function on another file's type
// (Service::new — a `scoped_identifier`), and a method on the value it gets back
// (s.handle — a `field_expression`). handle() then calls util(), so callees(run) reaches
// util transitively and callers(util) reaches run. Same shape as fixture-py/-java/-kotlin.
mod svc;

use svc::Service;

// Module-scope string const. crate-b vendors its own identical copy (same NAME, same
// VALUE, no cross-compartment import), which is the join the resource-seam inference
// makes. sock_path() below is a genuine USE of it — a compartment that only DECLARES the
// name is not a participant.
pub const GAME_SOCK_PATH: &str = "/var/run/wiregraph-fixture/game.sock";

// A function-local const with a resource-shaped name and value: it must NOT be extracted
// (module scope is required), or two crates that happen to share a local would look like
// a seam.
fn helper(n: i32) -> i32 {
    const LOCAL_SCRATCH_PATH: &str = "/tmp/wiregraph-fixture/scratch";
    n + 1 + LOCAL_SCRATCH_PATH.len() as i32
}

fn sock_path() -> &'static str {
    GAME_SOCK_PATH
}

pub fn run(n: i32) -> i32 {
    let s = Service::new();
    s.handle(n) + helper(n) + sock_path().len() as i32
}
