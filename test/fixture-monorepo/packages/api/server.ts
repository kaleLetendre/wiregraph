// Monorepo package "api": defines an internal HTTP route. The worker package (a
// SEPARATE compartment in the SAME git repo) calls it — a cross-compartment seam
// with no code-level call between them. This must produce a contract even though
// there is only one .git at the monorepo root.
import express from 'express';

const app = express();

app.post('/internal/sync', (req, res) => {
  const { batch_id } = req.body;
  res.json({ ok: true, batch_id });
});
