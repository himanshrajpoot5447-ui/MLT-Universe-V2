// api/users.js — handles all /api/users and /api/users/:id routes
import bcrypt from 'bcryptjs';
import { query, queryOne } from './lib/db.js';
import { requireAuth, isAdmin, isMaster } from './lib/auth.js';
import { handler, ok, err, safeUser } from './lib/helpers.js';

export default handler(async (req, res) => {
  const user = await requireAuth(req);
  // On Vercel, req.url is relative to the function — id comes via req.query or URL path
  const rawUrl = req.url || '';
  const urlPath = rawUrl.split('?')[0].replace(/\/$/, '');
  const qsRaw = rawUrl.includes('?') ? rawUrl.split('?')[1] : '';
  const qs = Object.fromEntries(new URLSearchParams(qsRaw));

  // ── POST /api/users/register — public self-registration ──────────────────
  if (urlPath.endsWith('/register') && req.method === 'POST') {
    const { name, email, phone = '', password } = req.body || {};
    if (!name || !email || !password) return err(res, 'Name, email and password required', 400);
    if (password.length < 6) return err(res, 'Password must be at least 6 characters', 400);
    const exists = await queryOne('SELECT id FROM users WHERE email ILIKE $1', [email.trim()]);
    if (exists) return err(res, 'Email already registered', 409);
    const hashed = await bcrypt.hash(password, 10);
    const avatar = name.trim().split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    const today  = new Date().toISOString().split('T')[0];
    const uid    = 'usr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const [newUser] = await query(
      `INSERT INTO users (id,name,email,password,role,credits,avatar,join_date,status,total_xp,phone)
       VALUES ($1,$2,$3,$4,'student',0,$5,$6,'active',0,$7) RETURNING *`,
      [uid, name.trim(), email.trim().toLowerCase(), hashed, avatar, today, phone || '']
    );
    return ok(res, safeUser(newUser), 201);
  }
  
  // Detect :id — Vercel puts it in req.query.id OR it's the last path segment
  // req.query.id is set when the rewrite uses /:id pattern
  let id = req.query?.id || null;
  if (!id) {
    // Fallback: last path segment if it doesn't look like the resource name
    const segments = urlPath.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last !== 'users' && last !== 'api') id = last;
  }

  // ── /api/users/:id ────────────────────────────────────────────────────────
  if (id) {
    if (req.method === 'GET') {
      if (user.role === 'student' && user.id !== id) return err(res, 'Access denied', 403);
      const target = await queryOne(
        'SELECT id,name,email,phone,role,credits,avatar,join_date,status,total_xp,rank FROM users WHERE id=$1', [id]
      );
      if (!target) return err(res, 'User not found', 404);
      return ok(res, safeUser(target));
    }

    if (req.method === 'PUT') {
      const target = await queryOne('SELECT * FROM users WHERE id=$1', [id]);
      if (!target) return err(res, 'User not found', 404);
      const isOwn   = user.id === id;
      const canEdit = isMaster(user) || isAdmin(user) || isOwn;
      if (!canEdit) return err(res, 'Access denied', 403);
      // Students can only edit their own name/email/password/phone
      const { name, email, password, role, credits, status, phone } = req.body || {};
      const sets=[]; const params=[]; let i=1;
      if (name)             { sets.push(`name=$${i++}`);     params.push(name); }
      if (phone !== undefined) { sets.push(`phone=$${i++}`); params.push(phone||''); }
      if (email) {
        const dup = await queryOne('SELECT id FROM users WHERE email ILIKE $1 AND id!=$2',[email,id]);
        if (dup) return err(res, 'Email already in use');
        sets.push(`email=$${i++}`); params.push(email.trim().toLowerCase());
      }
      if (password) { sets.push(`password=$${i++}`); params.push(await bcrypt.hash(password, 10)); }
      if (status && isAdmin(user)) { sets.push(`status=$${i++}`); params.push(status); }
      if (credits !== undefined && isMaster(user)) { sets.push(`credits=$${i++}`); params.push(parseInt(credits)||0); }
      if (role && isMaster(user) && role !== 'master') { sets.push(`role=$${i++}`); params.push(role); }
      if (name) {
        const av = name.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);
        sets.push(`avatar=$${i++}`); params.push(av);
      }
      if (!sets.length) return err(res, 'Nothing to update');
      params.push(id);
      const [updated] = await query(`UPDATE users SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, params);
      return ok(res, safeUser(updated));
    }

    if (req.method === 'DELETE') {
      if (!isMaster(user)) return err(res, 'Master only', 403);
      if (user.id === id)  return err(res, 'Cannot delete your own account');
      const target = await queryOne('SELECT id,role FROM users WHERE id=$1', [id]);
      if (!target) return err(res, 'User not found', 404);
      // CASCADE on DB handles: attempts, credit_transactions automatically
      await query('DELETE FROM users WHERE id=$1', [id]);
      // Recalculate ranks for remaining students
      if (target.role === 'student') {
        const students = await query("SELECT id FROM users WHERE role='student' ORDER BY total_xp DESC");
        for (let i = 0; i < students.length; i++) {
          await query('UPDATE users SET rank=$1 WHERE id=$2', [i + 1, students[i].id]);
        }
      }
      return ok(res, { message: 'User and all associated data deleted' });
    }

    return err(res, 'Method not allowed', 405);
  }

  // ── /api/users ────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (!isAdmin(user)) return err(res, 'Admin access required', 403);
    let sql = 'SELECT id,name,email,phone,role,credits,avatar,join_date,status,total_xp,rank FROM users WHERE 1=1';
    const params=[]; let i=1;
    if (qs.role)   { sql += ` AND role=$${i++}`;   params.push(qs.role); }
    if (qs.status) { sql += ` AND status=$${i++}`; params.push(qs.status); }
    if (qs.search) {
      sql += ` AND (name ILIKE $${i} OR email ILIKE $${i})`;
      params.push('%' + qs.search.toLowerCase() + '%'); i++;
    }
    sql += ' ORDER BY role, name';
    const rows = await query(sql, params);
    return ok(res, rows.map(safeUser));
  }

  if (req.method === 'POST') {
    if (!isAdmin(user)) return err(res, 'Admin access required', 403);
    const { name, email, password, role='student', credits=0 } = req.body || {};
    if (!name || !email || !password) return err(res, 'Name, email and password required');
    if (role === 'master') return err(res, 'Cannot create master accounts', 403);
    if (role === 'admin' && !isMaster(user)) return err(res, 'Only master can create admins', 403);
    const exists = await queryOne('SELECT id FROM users WHERE email ILIKE $1', [email]);
    if (exists) return err(res, 'Email already registered');
    const hashed = await bcrypt.hash(password, 10);
    const avatar = name.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);
    const today  = new Date().toISOString().split('T')[0];
    const [newUser] = await query(
      `INSERT INTO users (name,email,password,role,credits,avatar,join_date,status,total_xp,phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',0,'') RETURNING *`,
      [name, email.trim().toLowerCase(), hashed, role, credits, avatar, today]
    );
    return ok(res, safeUser(newUser), 201);
  }

  err(res, 'Method not allowed', 405);
});
