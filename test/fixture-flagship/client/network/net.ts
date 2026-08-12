// client/network — connection, decoding bytes into messages (§04). The OTHER half of the
// `network` basename collision. Its inferred compartment name is `client/network`.
//
// EVERY token below is one a server-side contract also declares, and this file names each
// of them for a real reason: it is the peer of server/network. That is exactly what makes
// it the trap. If server/contracts/ were not scoped to server/, a role naming the bare
// basename `network` would resolve here and mint a WIRE edge straight across the
// server/client wall — a seam that does not exist and that no contract declares.

export function openSession(): string {
  return send('/ws/session');
}

export function decodeDelta(): string {
  return send('/snapshot/delta');
}

export function decodeFrame(): string {
  return send('/snapshot/frame');
}

export function probe(): string {
  return send('/shared/probe');
}

// Vendored copies of the two server-side resource ids. Same NAMES, so the resource
// matcher would join them to server/network's writers were it not for the scope.
const REPLAY_LOG_PATH = '/var/run/flagship/replay.log';
const SNAPSHOT_SHM_PATH = '/dev/shm/flagship-snapshot';

export function replayHint(): number {
  return REPLAY_LOG_PATH.length;
}

export function shmHint(): number {
  return SNAPSHOT_SHM_PATH.length;
}

function send(p: string): string {
  return p;
}
