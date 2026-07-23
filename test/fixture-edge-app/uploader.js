// edge-app-like terminal repo: a client that HTTP-uploads log batches to log-server.
// The distinctive route literal (role: out — this side CALLS a route it does not
// define) lives inside uploadLogs, not in this comment, so the seam attributes to
// the enclosing function.
async function uploadLogs(batch) {
  const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(batch) });
  return res.ok;
}

function flush(buffer) {
  return uploadLogs(buffer.drain());
}

export { uploadLogs, flush };
