// Fixture "server" repo: defines HTTP routes. The /api/register route is also
// called by the mobile-app fixture repo, so it's a cross-repo wire seam; the
// /api/users/:id route is server-only, so it must NOT become a contract.
import express from 'express';

const app = express();

app.post('/api/register', (req, res) => {
  const { device_token } = req.body;
  res.json({ ok: true, device_token });
});

app.get('/api/users/:id', (req, res) => {
  res.json({ id: req.params.id });
});
