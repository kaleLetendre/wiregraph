# Project Structure

A faithful miniature of the flagship's `project-structure.md` §01 — same shape, same
levels, same `contracts/` placement — with two contracts DELIBERATELY MISFILED so the
axis F checks have something to catch. Everything else here is correct, which is the
point: the misfiled rows must be the only findings.

---

## 01 · The tree

```
contracts/          README.md       → server-client, at step 2
server/             whoami.md
    contracts/      README.md       → sim-queries (misfiled — see §06)
    ecs/            whoami.md
        contracts/  README.md       → queries-storage, at step 1
        queries/    whoami.md
        storage/    whoami.md
    sim/            whoami.md
    network/        whoami.md
client/             whoami.md
    contracts/      README.md       → network-world_state, at step 2
    network/        whoami.md
    world_state/    whoami.md
harness/            whoami.md
```

`harness/` sits at the top level. It implements the client side of
`contracts/server-client.md`, the same contract the browser conforms to — per R2 that
contract names the ROLES *server* and *client*, not directories.

---

## 03 · Server compartments

| Compartment | Owns | Must not know about |
| --- | --- | --- |
| `ecs/` | The generic entity/component/system machinery. | Anything at all. |
| `sim/` | The world and the fixed-tick loop. | Connections, sockets, the wire format. |
| `network/` | Transport, connection lifecycle, the wire codec. | World state. |

---

## 04 · Client compartments

| Compartment | Owns | Must not know about |
| --- | --- | --- |
| `network/` | The connection, and decoding bytes into messages. | What any message means. |
| `world_state/` | What this client believes the world looks like. | Drawing. |

---

## 06 · Contract index

| Contract | Between | Carries |
| --- | --- | --- |
| `contracts/server-client.md` | server ↔ client *(role)* | The wire. Implemented by `client/` and `harness/`. |
| `server/ecs/contracts/ecs-sim.md` | `ecs/` ↔ `sim/` | The frozen ECS signatures. **Filed inside `ecs/`, which is one of its own two sides — R4.** |
| `server/contracts/sim-queries.md` | `sim/` ↔ `queries/` | Direct column access from systems. **Its two sides live at different levels — §05.** |
| `server/ecs/contracts/queries-storage.md` | `queries/` ↔ `storage/` | Raw column access. Deliberately unwritten. |
| `client/contracts/network-world_state.md` | `network/` ↔ `world_state/` | Decoded messages. Deliberately unwritten. |
