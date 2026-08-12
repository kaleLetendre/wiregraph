// A THIRD crate with NOTHING to do with the ecs-sim seam, which happens to spell `World`
// for its own unrelated purpose — a render world, a different type entirely.
//
// This is the fixture's whole point about short ids. The contract's join key is the bare
// symbol name matched as `\bWorld\b`, so these two symbols DO mint REFERENCES edges to the
// contract, and nothing in the graph can tell them apart from the real ones. What the
// design does about it is bound the damage with the declared roles: render is neither the
// provider nor a consumer, so buildInprocEdges can never pair it into an INPROC seam, and
// it surfaces instead as an UNDECLARED PARTICIPANT — the honest report, and the thing to
// go and look at before widening the spec.

pub struct World {
    layers: u8,
}

pub fn draw(w: &World) -> u8 {
    w.layers
}
