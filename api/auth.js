// api/auth.js — /api/auth/login and /api/auth/me
import bcrypt from 'bcryptjs';
import jwt    from 'jsonwebtoken';
import { supaRest, requireAuth, ok, err, handler, normaliseUser } from './lib/_api.js';

export default handler(async (req, res) => {
  const subpath = req.url?.split('?')[0].replace(/\/$/, '') || '';

  // ── POST /api/auth/login ──────────────────────────────────────────────────
  if (subpath.endsWith('/login')) {
    if (req.method !== 'POST') return err(res, 'Method not allowed', 405);
    const { email, password } = req.body || {};
    if (!email || !password) return err(res, 'Email and password required', 400);

    const identifier = String(email).trim().toLowerCase();

    // Fetch user by email or phone — single REST call
    let rows;
    try {
      rows = await supaRest('GET', `users?or=(email.ilike.${encodeURIComponent(identifier)},phone.eq.${encodeURIComponent(identifier)})&limit=1`);
    } catch (e) {
      console.error('[auth/login] DB error:', e.message);
      return err(res, 'Database error — check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY', 500);
    }

    const user = rows[0];
    if (!user) return err(res, 'Invalid credentials', 401);
    if (user.status === 'inactive') return err(res, 'Account is inactive. Contact your administrator.', 403);

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return err(res, 'Invalid credentials', 401);

    if (!process.env.JWT_SECRET) return err(res, 'JWT_SECRET not configured', 500);

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return ok(res, { token, user: normaliseUser(user) });
  }

  // ── GET /api/auth/me ──────────────────────────────────────────────────────
  if (subpath.endsWith('/me')) {
    if (req.method !== 'GET') return err(res, 'Method not allowed', 405);
    const authUser = await requireAuth(req);
    const rows = await supaRest('GET', `users?id=eq.${authUser.id}&limit=1`);
    if (!rows[0]) return err(res, 'User not found', 404);
    return ok(res, normaliseUser(rows[0]));
  }

  return err(res, 'Not found', 404);
});
