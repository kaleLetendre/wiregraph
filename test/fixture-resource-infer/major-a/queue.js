import { writeFileSync } from 'node:fs';

// M11: TWO compartments agree on the value and a THIRD holds a stale copy. Dropping the
// whole NAME on any disagreement (the old rule) meant one out-of-date vendored copy
// killed the seam for everybody, with no diagnostic anywhere. The majority value wins,
// the outlier is EXCLUDED from the seam and REPORTED.
export const MAJORITY_QUEUE_PATH = '/var/spool/infer/q';

export function majorAEnqueue(item) {
  writeFileSync(MAJORITY_QUEUE_PATH, item);
}
