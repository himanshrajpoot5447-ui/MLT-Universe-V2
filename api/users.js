// api/users.js — direct Supabase REST
import bcrypt from 'bcryptjs';
import jwt    from 'jsonwebtoken';
import { supaRest, requireAuth, isAdmin, ok, err, handler, normaliseUser } from './lib/_api.js';
const isMaster = u => u?.role === 'master';

export default handler(async (req, res) => {
  const subpath = (req.url || '').split('?')[0].replace(/\/$/, '');
  const segments = subpath.split('/').filter(Boolean);
  const last = segments[segments.length - 1];

  // ── POST /api/users/register — PUBLIC, no auth token needed ──────────────
  if (subpath.endsWith('/register') && req.method === 'POST') {
    const { name, email, phone = '', password, credits = 0 } = req.body || {};
    if (!name || !email || !password) return err(res, 'name, email and password are required');
    if (password.length < 6) return err(res, 'Password must be at least 6 characters');

    // Check duplicate email
    const exists = await supaRest('GET',
      `users?email=ilike.${encodeURIComponent(email.trim())}&limit=1`
    ).catch(() => []);
    if (exists[0]) return err(res, 'This email is already registered', 409);

    const hashed  = await bcrypt.hash(password, 10);
    const initials = name.trim().split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'U';
    const created = await supaRest('POST', 'users', {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      phone: phone ? (phone.startsWith('91') ? phone : '91' + phone.replace(/\D/g, '')) : '',
      password: hashed,
      role: 'student',
      credits: parseInt(credits) || 0,
      avatar: initials,
      status: 'active',
      total_xp: 0,
    });

    const newUser = created[0];
    if (!newUser) return err(res, 'Registration failed — please try again', 500);

    // Auto-sign them in by returning a token too
    if (!process.env.JWT_SECRET) return err(res, 'JWT_SECRET not configured', 500);
    const token = jwt.sign(
      { id: newUser.id, role: newUser.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return ok(res, { token, user: normaliseUser(newUser) }, 201);
  }

  // All routes below require authentication
  const user = await requireAuth(req);
  const id = (last && last !== 'users' && last !== 'register') ? last : (req.query?.id || null);

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
