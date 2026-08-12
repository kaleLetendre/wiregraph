# Project Structure

Deliberately drifted, one finding per code. Every disagreement here is between the
structure document and the disk, and per §11 the disk wins every one of them.

## 01 · The tree

```
contracts/  README.md
a/          whoami.md  Cargo.toml
b/          whoami.md
ghost/      whoami.md
```

## 06 · Contract index

| Contract | Between | Carries |
| --- | --- | --- |
| `contracts/a-b.md` | `a/` ↔ `b/` | Not on disk, and no note anywhere records the absence. |
| `contracts/a-b-c.md` | `a/` ↔ `b/` ↔ `c/` | Three sides — R1. |
| `contracts/a-z.md` | `a/` ↔ `z/` | `z/` is not a compartment on disk, and is not marked a role. |
| `contracts/prose.md` | see the design document | A row whose sides cannot be read at all. |
