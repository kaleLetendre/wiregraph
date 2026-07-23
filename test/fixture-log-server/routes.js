// log-server-like server repo: defines the route edge-app uploads to. The distinctive
// route literal (role: in — this side DEFINES the route via app.post) lives inside
// registerRoutes, not in this comment, so the seam attributes to that function.
function ingestLogs(req, res) {
  store(req.body);
  res.end();
}

function registerRoutes(app) {
  app.post('/api/logs', ingestLogs);
}

function store(body) {
  return body;
}

export { registerRoutes, ingestLogs, store };
