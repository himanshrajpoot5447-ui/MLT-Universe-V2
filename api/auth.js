// api/auth.js — handles /api/auth/login and /api/auth/me
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { queryOne } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { handler, ok, err, safeUser } from '../lib/helpers.js';

export default handler(async (req, res) => {
  const subpath = req.url?.split('?')[0].replace(/\/$/, '') || '';

  // ── POST /api/auth/login ──────────────────────────────────────────────────
  if (subpath.endsWith('/login')) {
    if (req.method !== 'POST') return err(res, 'Method not allowed', 405);

    const { email, password } = req.body || {};
    if (!email || !password) return err(res, 'Email/phone and password required', 400);

    const identifier = email.trim();
    // Support login with email OR phone number
    const user = await queryOne(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR phone = $2',
      [identifier, identifier]
    );
    if (!user) return err(res, 'Invalid credentials', 401);
    if (user.status === 'inactive') return err(res, 'Account is inactive. Contact your administrator.', 403);

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return err(res, 'Invalid credentials', 401);

    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET environment variable is not set!');
      return err(res, 'Server configuration error', 500);
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return ok(res, { token, user: safeUser(user) });
  }

  // ── GET /api/auth/me ──────────────────────────────────────────────────────
  if (subpath.endsWith('/me')) {
    if (req.method !== 'GET') return err(res, 'Method not allowed', 405);
    const user = await requireAuth(req);
    // Re-fetch fresh user data from DB (credits/xp may have changed)
    const fresh = await queryOne('SELECT * FROM users WHERE id = $1', [user.id]);
    if (!fresh) return err(res, 'User not found', 404);
    return ok(res, safeUser(fresh));
  }

  return err(res, 'Not found', 404);
});
