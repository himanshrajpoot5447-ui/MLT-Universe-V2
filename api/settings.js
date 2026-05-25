// api/settings.js — GET /api/settings, PUT /api/settings
// Stores app-wide settings (credit plans, whatsapp number) in Neon
import { query, queryOne } from './lib/db.js';
import { requireAuth, isMaster } from './lib/auth.js';
import { handler, ok, err } from './lib/helpers.js';

export default handler(async (req, res) => {
  const subpath = req.url?.split('?')[0].replace(/\/$/, '') || '';

  // ── GET /api/settings/public — no auth, returns only whatsappNumber ──────
  if (subpath.endsWith('/settings/public')) {
    const row = await queryOne("SELECT value FROM settings WHERE key='app_settings'");
    if (!row) return ok(res, { whatsappNumber: '' });
    try {
      const data = JSON.parse(row.value);
      return ok(res, { whatsappNumber: data.whatsappNumber || '' });
    } catch {
      return ok(res, { whatsappNumber: '' });
    }
  }

  const user = await requireAuth(req);

  // ── GET /api/settings ─────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const row = await queryOne("SELECT value FROM settings WHERE key='app_settings'");
    if (!row) return ok(res, { creditPlans: [], whatsappNumber: '' });
    try {
      return ok(res, JSON.parse(row.value));
    } catch {
      return ok(res, { creditPlans: [], whatsappNumber: '' });
    }
  }

  // ── PUT /api/settings ─────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    if (!isMaster(user)) return err(res, 'Master access required', 403);
    const { creditPlans, whatsappNumber } = req.body || {};
    const value = JSON.stringify({ creditPlans: creditPlans || [], whatsappNumber: whatsappNumber || '' });
    await query(`
      INSERT INTO settings (key, value) VALUES ('app_settings', $1)
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [value]);
    return ok(res, { creditPlans: creditPlans || [], whatsappNumber: whatsappNumber || '' });
  }

  return err(res, 'Method not allowed', 405);
});
