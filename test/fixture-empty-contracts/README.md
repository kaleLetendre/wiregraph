# fixture-empty-contracts — contracts dirs that hold no spec

Three contracts dirs, none of which holds a spec. That is not a broken project: under
compartments-and-contracts a contract must not be written before the code it describes
exists, so a contracts dir created ahead of its first contract is the CORRECT state.

    contracts/            README only
    server/contracts/     README only
    client/contracts/     README only

detectContractsDirs matches a contracts home by NAME, so every one of these is recorded
in `state.contractsDir` / `state.contractsDirs` by a full build. A nudge gated on those
keys alone therefore reads "covered" and goes silent on a project with zero contracts —
the exact projects following the methodology most carefully.

Each dir carries a README rather than being empty because git cannot store an empty
directory, and because that is the flagship's actual state. A README is not a spec:
contractsDirSpecs only counts *.asyncapi / *.resource / *.inproc YAML.
