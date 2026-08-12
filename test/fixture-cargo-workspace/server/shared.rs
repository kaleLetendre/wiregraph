// A stray source file beside the virtual manifest. It belongs to no crate, so it must
// attribute to the ROOT compartment — not to a `server` compartment invented by the
// manifest sitting next to it.
pub fn shared_helper() -> u32 {
    7
}
