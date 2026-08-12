// harness — an independent Rust client that draws nothing (§01). It sits at the TOP
// level, inside no server/ or client/ subtree, so the ONLY contracts dir that can reach it
// is the level-1 `contracts/`. That is what makes it the probe for "the outer scope really
// is the whole tree", rather than merely "the files nothing inner claimed".
pub fn drive_session() -> &'static str {
    "/ws/session"
}

pub fn drive_probe() -> &'static str {
    "/shared/probe"
}
