# sim ↔ queries

MISFILED ON PURPOSE (§05). `sim/` is a child of `server/`; `queries/` is a child of
`server/ecs/`. The two sides sit at different levels, so either this is really the
`sim` ↔ `ecs` contract written one level too deep, or `sim` is reaching past `ecs` into
its internals. Nothing here says which.
