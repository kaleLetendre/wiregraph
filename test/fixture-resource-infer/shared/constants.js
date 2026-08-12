// The ONE shared constants module — join mechanism 1 (both compartments import it).
// This compartment DEFINES the constant and never touches the resource, which is the
// whole point of the definition-site rule: `shared` must NOT appear as a participant in
// the inferred seam, or the draft names a compartment that only declares a name.
export const SHARED_STATE_PATH = '/var/run/infer/shared-state.json';
