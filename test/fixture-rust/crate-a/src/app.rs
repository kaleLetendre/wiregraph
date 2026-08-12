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

// --- macros -----------------------------------------------------------------
// tree-sitter-rust parses macro ARGUMENTS as an unstructured `token_tree`, never as
// expressions, so before parse.js scanned that token stream every call written inside a
// macro was invisible: `println!("{}", helper(n))` produced no edge at all, and a
// `macro_rules!` definition produced no symbol, which left find_symbol and trace_callers
// on a macro returning nothing. `host/` in the flagship is to be built out of
// `tokio::select!`, whose whole body is macro arguments.
#[macro_export]
macro_rules! twice_run {
    ($n:expr) => {
        helper($n) + helper($n)
    };
}

// Calls in a macro's BODY belong to the macro symbol; calls in an INVOCATION's arguments
// belong to the function that wrote them, and the invocation itself is a call to the macro.
pub fn shout(n: i32) -> i32 {
    println!("{} {}", sock_path(), helper(n));
    twice_run!(n)
}
