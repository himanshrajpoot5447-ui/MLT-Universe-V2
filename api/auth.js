// api/auth.js — /api/auth/login and /api/auth/me
// Uses Supabase Auth for sign-in + our own users table for role/credits data.
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

    const identifier = email.trim();

    // 1. Look up user in our custom users table (supports email OR phone)
    let user = null;
    try {
      user = await queryOne(
        'SELECT * FROM users WHERE (email ILIKE $1 OR phone = $2)',
        [identifier, identifier]
      );
    } catch (dbErr) {
      console.error('[auth/login] DB lookup error:', dbErr.message);
      return err(res, 'Database error — check Supabase connection', 500);
    }

    if (!user) return err(res, 'Invalid credentials', 401);
    if (user.status === 'inactive') return err(res, 'Account is inactive. Contact your administrator.', 403);

    // 2. Verify password (bcrypt)
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return err(res, 'Invalid credentials', 401);

    // 3. Optional: also sign in via Supabase Auth so client can use Supabase
    //    realtime / storage if needed in future. This is a best-effort step.
    let supabaseSession = null;
    try {
      const sb = getDb();
      const { data: authData, error: authErr } = await sb.auth.signInWithPassword({
        email: user.email,
        password,
      });
      if (!authErr && authData?.session) {
        supabaseSession = {
          access_token:  authData.session.access_token,
          refresh_token: authData.session.refresh_token,
          expires_at:    authData.session.expires_at,
        };
      }
    } catch {
      // Supabase Auth sign-in is optional — don't fail login if it errors
    }

    // 4. Issue our own JWT (used for all API calls)
    if (!process.env.JWT_SECRET) {
      console.error('[auth/login] JWT_SECRET env var not set!');
      return err(res, 'Server configuration error: JWT_SECRET missing', 500);
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return ok(res, {
      token,
      user: safeUser(user),
      ...(supabaseSession ? { supabaseSession } : {}),
    });
  }

  // ── GET /api/auth/me ──────────────────────────────────────────────────────
  if (subpath.endsWith('/me')) {
    if (req.method !== 'GET') return err(res, 'Method not allowed', 405);
    const user = await requireAuth(req);
    const fresh = await queryOne('SELECT * FROM users WHERE id = $1', [user.id]);
    if (!fresh) return err(res, 'User not found', 404);
    return ok(res, safeUser(fresh));
  }

  return err(res, 'Not found', 404);
});
