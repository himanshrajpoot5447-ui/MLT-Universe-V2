// api/auth.js — /api/auth/login and /api/auth/me
import bcrypt from 'bcryptjs';
import jwt    from 'jsonwebtoken';
import { getDb, queryOne } from './lib/db.js';
import { requireAuth }     from './lib/auth.js';
import { handler, ok, err, safeUser } from './lib/helpers.js';

export default handler(async (req, res) => {
  const subpath = req.url?.split('?')[0].replace(/\/$/, '') || '';

  // ── POST /api/auth/login ──────────────────────────────────────────────────
  if (subpath.endsWith('/login')) {
    if (req.method !== 'POST') return err(res, 'Method not allowed', 405);

    const { email, password } = req.body || {};
    if (!email || !password) return err(res, 'Email/phone and password required', 400);

    const identifier = String(email).trim();

    // Look up user by email (ILIKE = case-insensitive) OR phone
    let user = null;
    try {
      user = await queryOne(
        `SELECT * FROM users WHERE (email ILIKE $1 OR phone = $2) LIMIT 1`,
        [identifier, identifier]
      );
    } catch (dbErr) {
      console.error('[auth/login] DB error:', dbErr.message);
      return err(res, 'Database connection failed — check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel', 500);
    }

    if (!user) return err(res, 'Invalid credentials', 401);
    if (user.status === 'inactive') return err(res, 'Account is inactive. Contact your administrator.', 403);

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return err(res, 'Invalid credentials', 401);

    if (!process.env.JWT_SECRET) {
      console.error('[auth/login] JWT_SECRET not set!');
      return err(res, 'Server configuration error: JWT_SECRET missing in Vercel env vars', 500);
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Optional: also sign in via Supabase Auth (best-effort, won't break login)
    try {
      const db = getDb();
      await db.auth.signInWithPassword({ email: user.email, password });
    } catch { /* ignore — our JWT is what matters */ }

    return ok(res, { token, user: safeUser(user) });
  }

  // ── GET /api/auth/me ──────────────────────────────────────────────────────
  if (subpath.endsWith('/me')) {
    if (req.method !== 'GET') return err(res, 'Method not allowed', 405);
    const authUser = await requireAuth(req);
    const fresh = await queryOne('SELECT * FROM users WHERE id = $1', [authUser.id]);
    if (!fresh) return err(res, 'User not found', 404);
    return ok(res, safeUser(fresh));
  }

  return err(res, 'Not found', 404);
});
