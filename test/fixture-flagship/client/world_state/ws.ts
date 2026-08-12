// client/world_state — snapshot history, entity table, interpolation (§04). Producer of
// the client-internal /ui/present seam.
//
// It also names two SERVER-side tokens: /tick/loop (level 2, server/) and
// /ecs/storage/read (level 3, server/ecs/). Both are real mentions — a client mirroring
// server vocabulary is ordinary — and both must mint nothing.

export function present(): string {
  return emit('/ui/present');
}

export function tickMirror(): string {
  return emit('/tick/loop');
}

export function storageMirror(): string {
  return emit('/ecs/storage/read');
}

export function probe(): string {
  return emit('/shared/probe');
}

function emit(p: string): string {
  return p;
}
