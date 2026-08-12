# Project Structure

The smallest correct application of `compartments-and-contracts.md`. This fixture must
produce ZERO drift and ZERO questions — it is the false-positive guard.

## 01 · The tree

```
contracts/  README.md   → a-b, at step 1
a/          whoami.md
b/          whoami.md
```

## 03 · Compartments

| Compartment | Owns | Must not know about |
| --- | --- | --- |
| `a/` | The thing a owns. | b. |
| `b/` | The thing b owns. | a. |

## 06 · Contract index

| Contract | Between | Carries |
| --- | --- | --- |
| `contracts/a-b.md` | `a/` ↔ `b/` | Whatever crosses. Deliberately unwritten. |
