// api/misc.js — /api/health, /api/sections, /api/settings/public
import { supaRest, requireAuth, isAdmin, ok, err, handler } from './lib/_api.js';

export default handler(async (req, res) => {
  const subpath = req.url?.split('?')[0].replace(/\/$/, '') || '';

  // ── GET /api/settings/public ──────────────────────────────────────────────
  if (subpath.endsWith('/settings/public')) {
    try {
      const rows = await supaRest('GET', "settings?key=eq.app_settings&limit=1");
      const data = rows[0] ? (typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value) : {};
      let masterPhone = '';
      if (!data.whatsappNumber) {
        const mRows = await supaRest('GET', "users?role=eq.master&select=phone&limit=1").catch(() => []);
        masterPhone = mRows[0]?.phone || '';
      }
      return ok(res, { whatsappNumber: data.whatsappNumber || '', masterPhone });
    } catch { return ok(res, { whatsappNumber: '', masterPhone: '' }); }
  }

  // ── GET /api/health ───────────────────────────────────────────────────────
  if (subpath.endsWith('/health')) {
    const checks = {
      SUPABASE_URL:              !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      JWT_SECRET:                !!process.env.JWT_SECRET,
    };
    const missing = Object.entries(checks).filter(([,v]) => !v).map(([k]) => k);
    if (missing.length) return res.status(503).json({ status: 'misconfigured', missing_env_vars: missing });
    try {
      await supaRest('GET', 'users?select=id&limit=1');
      return ok(res, { status: 'ok', db: 'connected', timestamp: new Date().toISOString(), version: '2.6.0' });
    } catch (e) {
      return res.status(503).json({ status: 'db_error', error: e.message });
    }
  }

  // ── /api/sections ─────────────────────────────────────────────────────────
  if (subpath.endsWith('/sections') || subpath.includes('/sections/')) {
    // DELETE /api/sections/:name
    const delMatch = subpath.match(/\/sections\/(.+)$/);
    if (delMatch && req.method === 'DELETE') {
      const user = await requireAuth(req);
      if (!isAdmin(user)) return err(res, 'Forbidden', 403);
      const name = decodeURIComponent(delMatch[1]);
      const rows = await supaRest('GET', `sections?name=ilike.${encodeURIComponent(name)}&limit=1`);
      if (!rows[0]) return err(res, 'Section not found', 404);
      if (rows[0].is_builtin) return err(res, 'Cannot delete built-in sections', 403);
      await supaRest('DELETE', `sections?id=eq.${rows[0].id}`);
      return ok(res, { deleted: true, name: rows[0].name });
    }

    const user = await requireAuth(req);

    if (req.method === 'GET') {
      const rows = await supaRest('GET', 'sections?order=is_builtin.desc,name.asc');
      return ok(res, rows);
    }

    if (req.method === 'POST') {
      if (!isAdmin(user)) return err(res, 'Forbidden', 403);
      const { name } = req.body || {};
      if (!name?.trim()) return err(res, 'Section name required', 400);
      const exists = await supaRest('GET', `sections?name=ilike.${encodeURIComponent(name.trim())}&limit=1`);
      if (exists[0]) return err(res, 'Section already exists', 409);
      const created = await supaRest('POST', 'sections', { name: name.trim(), is_builtin: false, created_by: user.id });
      return ok(res, created[0], 201);
    }

    return err(res, 'Method not allowed', 405);
  }

  return err(res, 'Not found', 404);
});
