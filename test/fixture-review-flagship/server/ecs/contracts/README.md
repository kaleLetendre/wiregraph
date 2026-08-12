# server/ecs/contracts

Contracts between the parts of the ECS.

`queries-storage` — direct raw-column access, and the only place holding `unsafe`.
**Populated at build step 1**, alongside the query core.
