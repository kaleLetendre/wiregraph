# Contracts: connecting two compartments

A **contract** is simply **the defined communication between two compartments**. A
"compartment" is any bounded unit of a system, and the contract is the agreed shape
of whatever crosses the boundary between them. That's the whole idea — it is **not**
limited to microservices talking over a network.

wiregraph links code *within* a repo by following calls. But the most valuable
connections in a real system are the ones that **aren't a code-level call at all** —
where two compartments only agree on a shape. Those are exactly what a contract
captures, and what `trace_contract` / `path_between` let you walk.

## The variety of situations a contract covers

- **Service ↔ service over the wire.** A producer in one repo sends an HTTP request
  or a queue message; a consumer in another repo handles it. There is no function
  call between them — only the message *shape*. This is the case wiregraph automates
  today (see [Inferring contracts](#inferring-contracts-wiregraph-contracts)).
- **Library / SDK ↔ consumer.** A package's public API surface *is* a contract: the
  exported functions, types, and payloads a caller is allowed to depend on — whether
  it's packaged with the library (an OpenAPI/IDL/`.d.ts`/published schema) or derived
  from its exported symbols. The compartments are the package and the code that
  imports it.
- **Program ↔ program via shared state.** One program reads another's state — a
  shared database table, a status file, a memory-mapped region, an environment
  contract. The contract is the shape and keys of that shared state.

In every case the model is the same: a **Contract** node that both sides
**REFERENCE**, joined into a directed edge. Only the *source* of the contract — a
wire spec, a library's API surface, a shared-state schema — differs.

## Why it matters: the otherwise-invisible bug class

When two compartments share a shape but no call, **nothing in ordinary code analysis
connects them.** Rename a field on the producing side and the consumer keeps reading
the old name; change an endpoint path on one side and the other silently 404s. grep
won't surface it (the two sides live in different repos), and a call graph won't
either (there is no edge to follow). This cross-boundary blast radius is precisely
what a contract graph makes visible — *before* it ships as a broken integration.

## How wiregraph models a contract

1. A contract source (today: an AsyncAPI spec) becomes a **Contract** node.
2. wiregraph extracts the contract's **distinctive wire tokens** — channel/endpoint
   address paths (e.g. `/api/register`) and payload field names (e.g.
   `device_token`). Low-signal names (`id`, `type`, `status`, `data`, …) are filtered
   out so links stay meaningful.
3. Any symbol whose body mentions one of those tokens gets a `REFERENCES` edge to the
   Contract node. When symbols in **different** repos reference the same token, they
   are joined producer→consumer.

The edges are a **heuristic** — "this code mentions a token this contract defines,"
not "verified to implement it" — so they carry an `evidence` tag, and link quality
tracks how distinctive your endpoint/field names are. Confirm the exact field or
endpoint with a targeted `get_source` when it matters.

## Inferring contracts (`/wiregraph-contracts`)

Most teams haven't hand-written contracts. wiregraph can **infer them from the
code**: run `/wiregraph-contracts` and it scans the workspace for **HTTP routes one
repo defines and another repo calls**, clusters the shared paths, and proposes a
draft **AsyncAPI 3.0** spec wiring them together. You review it, and on confirmation
it's written into your contracts directory — a real, committable artifact you own.

- It detects server route definitions (Express/Fastify/NestJS, Flask/FastAPI) and
  client calls (`fetch`, `axios`, `requests`, …) and keeps only paths that span
  **2+ repos** (a single-repo path isn't a contract).
- The repo that *defines* a route is treated as the server, so the request direction
  is inferred for you.
- The result is a **draft** — heuristic, a starting point to review and commit, not
  the truth.

This needs your repos indexed **together as a workspace** (see below). HTTP routes
are the first source automated; queues/topics, library API surfaces, and shared-state
schemas are planned as additional inference sources onto the same machinery.

## The workspace model (required for cross-repo contracts)

wiregraph can only see a shared route if both repos are indexed together. So:

> **Put all the related repos side-by-side under one parent folder — each its own
> git repo — and run `/wiregraph-init` in that parent.**

If you index repos separately, the shared seams aren't visible. `/wiregraph-init`
lists the repos it would cover and confirms scope before building, so you don't
accidentally index a single repo (or your whole home directory). Cross-repo
attribution relies on each repo having its own `.git`.

## Authoring contracts by hand

You can also write contracts yourself (or edit the inferred ones):

- Put them in a directory at the workspace root named `contracts`, `asyncapi`, or
  `*-contracts` (e.g. `api-contracts`) — or pass `--contracts <dir>` to the build.
- Write **AsyncAPI 3.0** specs named `*.asyncapi.yaml` / `*.asyncapi.yml` (other
  files are ignored).
- Channel `address` paths and payload `properties` field names are what get matched
  against code, so name them the way they actually appear on the wire.

Inferred and hand-written specs coexist: wiregraph writes its draft as
`wiregraph-inferred.asyncapi.yaml` and never overwrites your own files.

## Sources

- **AsyncAPI 3.0.0 specification** — the contract format wiregraph reads and writes:
  <https://www.asyncapi.com/docs/reference/specification/v3.0.0>
- **Consumer-Driven Contracts: A Service Evolution Pattern** (Ian Robinson) — the
  pattern behind why these agreements exist:
  <https://martinfowler.com/articles/consumerDrivenContracts.html>
- **Pact** — consumer-driven contract *testing* for HTTP and message integrations,
  a complementary discipline: <https://docs.pact.io/>
