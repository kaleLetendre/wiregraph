// A shared human-readable MESSAGE, vendored into two compartments with an identical
// value — the exact shape the name+value join would otherwise accept. A resource
// identifier (path, table+key, shm key, pipe name) is a single unbroken token; prose is
// not, so a value containing whitespace is not a resource id. Measured on wiregraph's
// own source, this was the ONLY seam the scan proposed before the rule existed.
export const OPERATOR_HINT_TEXT = 'Run the thing to fix it.';

export function msgAHint() {
  return OPERATOR_HINT_TEXT;
}
