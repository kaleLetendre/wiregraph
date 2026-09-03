---
description: Learn wiregraph by example — the mental model, WHERE to init (usually the parent of your repos, so cross-repo contracts light up), how contracts work, and the tools you'll use day to day. Reads your actual layout so the guidance is concrete.
argument-hint: "[target-dir] (defaults to the current directory — the tutorial inspects it to make the advice specific)"
allowed-tools: Bash, Read, AskUserQuestion
---

Teach the user how wiregraph works, grounded in **their own directory** rather than in
the abstract. This command explains and demonstrates; it does not change anything until
the user asks. Keep it a conversation — short sections, check they're with you, and use
what the detection commands report so every point is about *their* layout, not a generic
one.

**Target:** `$1` if provided, else `${CLAUDE_PROJECT_DIR}`, else the current working
directory. Call it `<TARGET>` and use its realpath. Also compute `<PARENT>` = the
directory one level above `<TARGET>` — you'll need it for the "where to init" section,
which is the heart of this tutorial.

Work through the sections in order. Don't dump them all at once; teach one, then move on.

---

## 0. Look at their layout first (read-only — nothing is built)

Before explaining anything, find out what situation they're actually in, so the whole
tutorial can be specific. Run these two — both are read-only:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/state.mjs check "<TARGET>"
```

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/workspace.mjs repos "<TARGET>"
```

From `check`: `indexed: yes/no`, the `root:` it's indexed at (if any), and whether
`<TARGET>` is that root (`sameDir`). From `repos`: the `scope:` line
(`SINGLE` / `MULTI` / `NO-GIT`) and the compartment list — how many packages/repos
`<TARGET>` contains and their names.

**Then run `repos` on the parent too**, because the single most useful thing this
tutorial can show is what a parent-level init would capture that a `<TARGET>`-level one
would miss:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/workspace.mjs repos "<PARENT>"
```

Hold these numbers; sections 1 and 2 read them back to the user.

## 1. What wiregraph is (keep it to a few sentences)

wiregraph indexes your code into a **call graph** stored in one embedded SQLite file —
no daemon, no server. Claude then *queries* that graph (via MCP tools) instead of
grep-ing and re-reading your files, which is where the ~40–60% token saving comes from.
It **self-heals on read**: every query re-indexes any file that changed since the last
one, so it's never stale. That's the whole idea — index once, then just use Claude
normally.

## 2. WHERE to init — the decision that matters most

This is what most people get wrong, so spend the most time here and make it concrete
with the numbers from section 0.

The rule: **init at the lowest directory that contains everything you want traced
*together*.** wiregraph draws one graph over everything under the directory you point it
at, then auto-splits that into **compartments** — one per repo, or per package/module
that declares itself with a manifest. So:

- **One self-contained repo** → init at the repo root. Simple.
- **Several repos that talk to each other** — a client and a server, a handful of
  services — sitting side by side under one folder (say `~/work/client` and
  `~/work/server`) → **init at the parent (`~/work`), not inside one repo.** Both become
  compartments in *one* graph, which is the only way the connection between them can be
  traced (see section 3).
- **A monorepo of packages** → init at the monorepo root; it's already the parent of its
  packages.

**Why it matters so much:** a connection *between* two compartments — the client calling
the server's HTTP route — only exists in the graph if **both compartments are in the same
graph**. Init inside a single repo and every seam to its sibling repos is simply invisible.
There's no error; the trace just stops at the repo's edge.

Now make it real with section 0's output:

- If `<TARGET>` is a single repo (`scope: SINGLE`) **but the parent holds sibling repos**
  (the `<PARENT>` `repos` run reported more compartments), say so plainly: *"You're at a
  single repo here. One level up at `<PARENT>` there are also `<sibling names>` — if any
  of those talk to this one, init at `<PARENT>` instead so the connection can be traced."*
- If `<TARGET>` already contains several compartments (`scope: MULTI`), confirm this is a
  good spot and name what it would capture.
- The one guardrail the other way: **don't** init at something enormous like `$HOME` — pick
  the folder that holds *your* project(s), not everything you own.

If two related repos really can't share a parent, mention `/wiregraph-link` as the
alternative — it joins two separately-indexed graphs so their cross-repo seams still light
up — but a single init at the common parent is the simpler path when it's available.

## 3. How contracts work — the part people find new

A **contract** is just *the defined communication between two compartments*. It's the
thing that lets a trace cross a repo/package boundary — CALLS edges stay *inside* a
compartment, and contracts are how you follow a call from one compartment into another.
This cross-compartment tracing is wiregraph's distinguishing feature, so it's worth
understanding. There are three kinds:

- **Wire** — one compartment defines an HTTP route or message topic and another calls or
  subscribes to it. Roles: **producer → consumer**. Drafted as an **AsyncAPI** spec.
- **Resource** — a file, a DB table+key, a shared-memory region, or a named pipe that two
  compartments both touch, joined by the **shared constant** that names it. Roles:
  **writer → reader** (no request/reply — a writer updates it, readers observe it).
  Drafted as a **`*.resource.yaml`**.
- **In-process** — two compartments in *one* process (e.g. two Rust crates in one binary)
  coupled by directly using each other's exported symbols. Roles: **provider → consumer**.
  A **`*.inproc.yaml`**, and this one is **hand-written** — wiregraph does not infer it.

The key point that ties back to section 2: **wiregraph reads the wire and resource seams
straight out of your code** — you don't hand-write them. `/wiregraph-contracts` scans the
workspace and proposes draft specs. But it can only find a seam when **both sides are
compartments in the same graph**, which is exactly why initing at the parent matters.

Then `trace_contract` and `path_between` follow these contracts across the boundary, and
`/wiregraph-visualize` draws them as the bridges between your repos. Full write-up:
<https://kaleletendre.github.io/wiregraph/contracts.html>.

*(Optional — offer, don't force: global vs recursive mode. Almost everyone wants
**global**, where wiregraph infers the compartments from `.git`/manifests with zero
maintenance. **Recursive** is for a plain source tree split into subsystems that have no
manifests of their own, where you declare the compartments yourself. `/wiregraph-init`
walks this choice; only bring it up if they ask how compartments are decided.)*

## 4. The tools you'll actually use

After init, you don't run commands to navigate — you just ask Claude, and it reaches for
these (registered MCP tools):

- `find_symbol` — locate a definition by name.
- `get_source` — read one function's body without opening the whole file.
- `trace_callers` / `trace_callees` — the whole up/down call chain in one call.
- `path_between` — how two symbols connect.
- `trace_contract` — the cross-compartment seams (section 3), and drift between a contract
  and the code.
- `graph_status` — health, freshness, and which mode you're on.

Day to day the only commands you type are `/wiregraph-update` (usually automatic),
`/wiregraph-status` (a health check), and `/wiregraph-stats` (token savings).

## 5. Offer to do it with them now

End by turning the lesson into action, based on section 0. Ask with AskUserQuestion — don't
run anything unprompted:

- **Not indexed yet** → offer to run `/wiregraph-init` **at the right place**: if
  `<TARGET>` is a single repo with related siblings in `<PARENT>`, recommend initing at
  `<PARENT>`; otherwise at `<TARGET>`. Name the exact directory in the option.
- **Already indexed** → offer a next step that fits: `/wiregraph-contracts` to infer the
  seams (if it's a multi-compartment workspace), a sample `find_symbol` / `trace_callers`
  query on one of their own symbols to show the tools live, or `/wiregraph-visualize` to
  see the graph.
- **Just wanted to learn** → fine; summarize the two things to remember (init at the
  parent of related repos; contracts are how traces cross the boundary) and stop.

Keep the whole thing friendly and brief — this is orientation, not a spec. The goal is
that they leave knowing *where* to point wiregraph and *why* contracts exist.
