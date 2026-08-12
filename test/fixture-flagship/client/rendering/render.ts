// client/rendering — draws interpolated state (§04). Consumer of /ui/present, and the
// one client compartment that must never see the network.
export function draw(): string {
  return take('/ui/present');
}

export function probe(): string {
  return take('/shared/probe');
}

function take(p: string): string {
  return p;
}
