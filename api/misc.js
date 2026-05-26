// api/misc.js — handles /api/health and /api/sections
import { query, queryOne } from '../lib/db.js';
import { requireAuth, isAdmin } from '../lib/auth.js';
import { handler, ok, err } from '../lib/helpers.js';

export default handler(async (req, res) => {
  const subpath = req.url?.split('?')[0].replace(/\/$/, '') || '';

  // ── GET /api/settings/public — no auth required (for register button on login page) ──
  if (subpath.endsWith('/settings/public')) {
    try {
      const row = await queryOne("SELECT value FROM settings WHERE key='app_settings'");
      let whatsappNumber = '';
      if (row) {
        const data = JSON.parse(row.value);
        whatsappNumber = data.whatsappNumber || '';
      }
      // Fallback: master admin phone from users table
      let masterPhone = '';
      if (!whatsappNumber) {
        const master = await queryOne("SELECT phone FROM users WHERE role='master' LIMIT 1");
        masterPhone = master?.phone || '';
      }
      return ok(res, { whatsappNumber, masterPhone });
    } catch {
      return ok(res, { whatsappNumber: '', masterPhone: '' });
    }
  }

  // ── GET /api/health ───────────────────────────────────────────────────────
  if (subpath.endsWith('/health')) {
    const checks = {
      SUPABASE_URL:              !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_DB_URL:           !!process.env.SUPABASE_DB_URL,
      JWT_SECRET:                !!process.env.JWT_SECRET,
    };
    const missing = Object.entries(checks).filter(([,v]) => !v).map(([k]) => k);
    if (missing.length) {
      return res.status(503).json({
        status: 'misconfigured',
        missing_env_vars: missing,
        fix: `Add these to Vercel → Project Settings → Environment Variables, then redeploy: ${missing.join(', ')}`,
      });
    }
    try {
      await queryOne('SELECT 1 as ping');
      return ok(res, {
        status: 'ok', db: 'connected',
        timestamp: new Date().toISOString(), version: '2.1.0',
      });
    } catch (e) {
      return res.status(503).json({
        status: 'db_error',
        error: e.message,
        fix: 'Check SUPABASE_DB_URL — get it from Supabase → Settings → Database → Transaction pooler',
      });
    }
  }

  // ── GET|POST /api/sections ────────────────────────────────────────────────
  if (subpath.endsWith('/sections')) {
    const user = await requireAuth(req);

    if (req.method === 'GET') {
      const rows = await query('SELECT * FROM sections ORDER BY is_builtin DESC, name ASC');
      return ok(res, rows);
    }

    if (req.method === 'POST') {
      if (!isAdmin(user)) return err(res, 'Admin access required', 403);
      const { name } = req.body || {};
      if (!name?.trim()) return err(res, 'Section name required', 400);

      const exists = await queryOne(
        'SELECT id FROM sections WHERE LOWER(name) = LOWER($1)',
        [name.trim()]
      );
      if (exists) return err(res, 'Section already exists', 409);

      const rows = await query(
        `INSERT INTO sections (name, is_builtin, created_by, created_at)
         VALUES ($1, FALSE, $2, NOW())
         RETURNING *`,
        [name.trim(), user.id]
      );
      return ok(res, rows[0], 201);
    }

    return err(res, 'Method not allowed', 405);
  }

  // ── DELETE /api/sections/:name ────────────────────────────────────────────
  const sectionDeleteMatch = subpath.match(/\/sections\/(.+)$/);
  if (sectionDeleteMatch) {
    const user = await requireAuth(req);
    if (!isAdmin(user)) return err(res, 'Admin access required', 403);

    if (req.method === 'DELETE') {
      const sectionName = decodeURIComponent(sectionDeleteMatch[1]);

      const row = await queryOne(
        'SELECT * FROM sections WHERE LOWER(name) = LOWER($1)',
        [sectionName]
      );
      if (!row) return err(res, 'Section not found', 404);
      if (row.is_builtin) return err(res, 'Cannot delete built-in sections', 403);

      await query('DELETE FROM sections WHERE id = $1', [row.id]);
      return ok(res, { deleted: true, name: row.name });
    }

    return err(res, 'Method not allowed', 405);
  }

  return err(res, 'Not found', 404);
});
