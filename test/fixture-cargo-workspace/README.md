# fixture-cargo-workspace — manifests that do NOT declare a module

Every directory here holds a manifest. Only five of them are compartments, and the
other three are the point of the fixture: a manifest FILE is not proof of a module.

    Cargo.toml            [workspace] only — a VIRTUAL manifest, at the ROOT
    server/Cargo.toml     [workspace] only — a VIRTUAL manifest, NESTED (the defect)
    server/shared.rs      a stray source file beside it — it must attribute to the ROOT
    server/net/           [package]  -> compartment `net`
    server/sim/           [package]  -> compartment `sim`
    harness/              [package] AND [workspace] — a workspace root that IS a crate
    tools/                pyproject.toml holding only [tool.ruff] — tool config
    pkgs/app/             pyproject.toml with [project]
    pkgs/legacy/          pyproject.toml holding only [tool.black], PLUS setup.py

The nested virtual manifest is the shape that bites: `server/` is the ordinary place a
Rust monorepo puts its workspace manifest, and before the manifest table carried a rule
per manifest it minted a phantom `server` compartment that owned `shared.rs`. The crates
still won by longest prefix, so attribution was unharmed and nothing failed — a whole
compartment simply existed that no code declares.

The ROOT virtual manifest is the benign half, and it is here so the two are not confused:
the root is the fallback compartment either way, so dropping it as a boundary changes no
file's attribution and no id. It changes the partition FINGERPRINT, which is why it is
pinned rather than assumed.
