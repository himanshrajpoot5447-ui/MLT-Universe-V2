// api/users.js — direct Supabase REST
import bcrypt from 'bcryptjs';
import { supaRest, requireAuth, isAdmin, ok, err, handler, normaliseUser } from './lib/_api.js';
const isMaster = u => u?.role === 'master';

export default handler(async (req, res) => {
  const user = await requireAuth(req);
  const segments = (req.url || '').split('?')[0].split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  const id   = (last && last !== 'users') ? last : (req.query?.id || null);

  // ── /api/users/:id ────────────────────────────────────────────────────────
  if (id) {
    if (req.method === 'GET') {
      if (!isAdmin(user) && user.id !== id) return err(res, 'Forbidden', 403);
      const rows = await supaRest('GET', `users?id=eq.${id}&limit=1`);
      if (!rows[0]) return err(res, 'User not found', 404);
      return ok(res, normaliseUser(rows[0]));
    }

    if (req.method === 'PUT') {
      if (!isAdmin(user) && user.id !== id) return err(res, 'Forbidden', 403);
      const b = req.body || {};
      const patch = {};
      if (b.name   !== undefined) patch.name   = b.name;
      if (b.email  !== undefined) patch.email  = b.email;
      if (b.phone  !== undefined) patch.phone  = b.phone;
      if (b.avatar !== undefined) patch.avatar = b.avatar;
      if (b.status !== undefined && isAdmin(user)) patch.status = b.status;
      if (b.role   !== undefined && isMaster(user)) patch.role  = b.role;
      if (b.password) patch.password = await bcrypt.hash(b.password, 10);
      if (!Object.keys(patch).length) return err(res, 'Nothing to update');
      const rows = await supaRest('PATCH', `users?id=eq.${id}`, patch);
      return ok(res, normaliseUser(rows[0] || { id, ...patch }));
    }

    if (req.method === 'DELETE') {
      if (!isMaster(user)) return err(res, 'Master access required', 403);
      await supaRest('DELETE', `users?id=eq.${id}`);
      return ok(res, { deleted: true });
    }

    return err(res, 'Method not allowed', 405);
  }

  // ── /api/users ────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (!isAdmin(user)) return err(res, 'Forbidden', 403);
    const rows = await supaRest('GET', 'users?order=created_at.desc');
    return ok(res, rows.map(normaliseUser));
  }

  if (req.method === 'POST') {
    if (!isAdmin(user)) return err(res, 'Forbidden', 403);
    const { name, email, phone = '', password, role = 'student', credits = 0 } = req.body || {};
    if (!name || !email || !password) return err(res, 'name, email and password required');
    const exists = await supaRest('GET', `users?email=ilike.${encodeURIComponent(email.trim())}&limit=1`).catch(() => []);
    if (exists[0]) return err(res, 'Email already registered', 409);
    const hashed = await bcrypt.hash(password, 10);
    const created = await supaRest('POST', 'users', {
      name, email: email.trim().toLowerCase(), phone, password: hashed,
      role, credits, avatar: name.charAt(0).toUpperCase(), status: 'active',
    });
    return ok(res, normaliseUser(created[0]), 201);
  }

  return err(res, 'Method not allowed', 405);
});
