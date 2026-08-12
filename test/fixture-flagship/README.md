# fixture-flagship

The tree of `project-structure.md` §01 (the flagship recursive-mode project), reduced to
the smallest form that still exercises every discovery/scoping question that layout asks:

```
Cargo.toml                     [workspace] — the root boundary
contracts/                     LEVEL 1 — governs the whole tree
server/
    contracts/                 LEVEL 2 — governs server/ only
    ecs/     Cargo.toml src/
        contracts/             LEVEL 3 — governs server/ecs/ only. Created EMPTY by the
                               test helper (git cannot carry an empty directory), which
                               is also the flagship's real state today.
    sim/     Cargo.toml src/
    network/ Cargo.toml src/   ← basename COLLIDES with client/network
    host/    Cargo.toml src/
client/
    contracts/                 LEVEL 2 — governs client/ only
    network/        package.json   ← the other half of the collision
    world_state/    package.json
    rendering/      package.json
    input_handling/ package.json
harness/ Cargo.toml src/
```

Eleven compartments, exactly the flagship's eleven `whoami.md` files: `server/` and
`client/` are compartments in their own right, and neither carries a build manifest, so
they only exist in the DECLARED partition. That asymmetry is deliberate — it is what makes
the inferred and declared runs produce genuinely different partitions over one tree.

Rust on the server + harness, TypeScript on the client, exactly as the flagship is.

## The tokens, and what each one proves

| token | declared in | also NAMED by | proves |
| --- | --- | --- | --- |
| `/ws/session` | `contracts/` (L1) | harness, client/network, server/network | an L1 contract really does reach the whole tree |
| `/tick/loop` | `server/contracts/` (L2) | ecs, sim, **client/world_state** | an L2 contract stops at `server/` |
| `/snapshot/delta` | `server/contracts/` (L2) | sim, server/network, **client/network** | THE R4 CASE — see below |
| `/snapshot/frame` | `server/contracts/` (L2) | sim, server/network, **client/network** | the positive control for the line above |
| `/ui/present` | `client/contracts/` (L2) | world_state, rendering, **server/network** | the mirror image, stopping at `client/` |
| `/shared/probe` | ALL THREE levels | every compartment | longest-prefix across THREE levels |
| `/ecs/storage/read` | `server/ecs/contracts/` (L3) | ecs, **sim**, **client/world_state** | an L3 contract excludes even its own SIBLING inside `server/` |
| `REPLAY_LOG_PATH` | `server/contracts/*.resource.yaml` | server/network, host, **client/network** | the resource path, which is separate code |
| `SNAPSHOT_SHM_PATH` | `server/contracts/*.resource.yaml` | server/network, **client/network** | the resource half of the R4 case |

Bold entries are the ones a correct scope EXCLUDES. Every one of them is a real literal in
a real file, so each exclusion is a fact about scoping and not about the fixture being
quiet.

## The R4 / basename-collision trap, built in on purpose

`server/contracts/sim-network.asyncapi.yaml` names its consumer `network` — the bare
basename, which is what an author sitting in `server/` naturally writes. The graph has TWO
directories that could answer to it. In the DECLARED partition the fixture's test binds the
bare name `network` to **`client/network`**, so the role resolves to the wrong side of the
server/client wall. Subtree scoping is the only thing standing between that and a
fabricated `sim -> client/network` WIRE edge across a compiler-enforced boundary.

`/snapshot/frame` (consumers `srv_network`, the correctly qualified name) is the control:
same spec, same dir, same producer, and its seam DOES light up. Without it, "no edge" could
just as easily mean "nothing works".
