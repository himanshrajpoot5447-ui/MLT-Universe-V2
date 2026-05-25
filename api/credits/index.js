// api/credits.js — handles all /api/credits/* routes
import { query, queryOne } from '../lib/db.js';
import { requireAuth, isAdmin, requireRole } from '../lib/auth.js';
import { handler, ok, err } from '../lib/helpers.js';

export default handler(async (req, res) => {
  const subpath = req.url?.split('?')[0].replace(/\/$/, '') || '';
  const qs = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const user = await requireAuth(req);

  // ── POST /api/credits/add ─────────────────────────────────────────────────
  if (subpath.endsWith('/credits/add') || subpath.endsWith('/add')) {
    if (req.method !== 'POST') return err(res, 'Method not allowed', 405);
    if (!isAdmin(user)) return err(res, 'Admin access required', 403);

    const { userId, amount, note = '', paymentMode = 'Cash', paidAmount = 0, description = 'Credit allocation' } = req.body || {};
    if (!userId || !amount || Number(amount) <= 0) {
      return err(res, 'userId and a positive amount are required', 400);
    }

    const target = await queryOne('SELECT * FROM users WHERE id = $1', [userId]);
    if (!target) return err(res, 'User not found', 404);

    if (user.role === 'admin' && target.role === 'admin') {
      return err(res, 'Admins cannot add credits to other admins', 403);
    }

    // Update user balance
    await query(
      'UPDATE users SET credits = credits + $1, updated_at = NOW() WHERE id = $2',
      [Number(amount), userId]
    );

    // Record transaction
    const txId = 'ct' + Date.now();
    const today = new Date().toISOString().split('T')[0];
    await query(
      `INSERT INTO credit_transactions
        (id, user_id, amount, type, description, note, payment_mode, paid_amount, date, by_user_id)
       VALUES ($1, $2, $3, 'credit', $4, $5, $6, $7, $8, $9)`,
      [txId, userId, Number(amount), description, note, paymentMode, Number(paidAmount), today, user.id]
    );

    const updated = await queryOne('SELECT id, name, credits FROM users WHERE id = $1', [userId]);
    return ok(res, { user: updated, transactionId: txId });
  }

  // ── POST /api/credits/deduct ──────────────────────────────────────────────
  if (subpath.endsWith('/credits/deduct') || subpath.endsWith('/deduct')) {
    if (req.method !== 'POST') return err(res, 'Method not allowed', 405);
    if (!isAdmin(user)) return err(res, 'Admin access required', 403);

    const { userId, amount, reason = 'Manual deduction' } = req.body || {};
    if (!userId || !amount || Number(amount) <= 0) {
      return err(res, 'userId and a positive amount are required', 400);
    }

    const target = await queryOne('SELECT * FROM users WHERE id = $1', [userId]);
    if (!target) return err(res, 'User not found', 404);
    if (target.credits < Number(amount)) {
      return err(res, 'User does not have enough credits', 400);
    }

    await query(
      'UPDATE users SET credits = credits - $1, updated_at = NOW() WHERE id = $2',
      [Number(amount), userId]
    );

    const txId = 'ct' + Date.now();
    const today = new Date().toISOString().split('T')[0];
    await query(
      `INSERT INTO credit_transactions
        (id, user_id, amount, type, description, payment_mode, paid_amount, date, by_user_id)
       VALUES ($1, $2, $3, 'debit', $4, 'manual', 0, $5, $6)`,
      [txId, userId, -Number(amount), reason, today, user.id]
    );

    const updated = await queryOne('SELECT id, name, credits FROM users WHERE id = $1', [userId]);
    return ok(res, { user: updated, transactionId: txId });
  }

  // ── GET /api/credits/transactions ── All transactions (admin/master) ───────
  if (subpath.endsWith('/credits/transactions') || subpath.endsWith('/transactions')) {
    if (req.method !== 'GET') return err(res, 'Method not allowed', 405);
    if (!isAdmin(user)) return err(res, 'Admin access required', 403);

    let sql = `
      SELECT ct.*, u.name as user_name, u.email as user_email, b.name as by_name
      FROM credit_transactions ct
      LEFT JOIN users u ON u.id = ct.user_id
      LEFT JOIN users b ON b.id = ct.by_user_id
      WHERE 1=1
    `;
    const params = [];
    if (qs.userId) { params.push(qs.userId); sql += ` AND ct.user_id = $${params.length}`; }
    if (qs.type)   { params.push(qs.type);   sql += ` AND ct.type = $${params.length}`; }
    sql += ' ORDER BY ct.created_at DESC LIMIT 1000';

    const rows = await query(sql, params);
    return ok(res, rows);
  }

  // ── GET /api/credits/my-transactions ── Student's own transactions ─────────
  if (subpath.endsWith('/my-transactions')) {
    if (req.method !== 'GET') return err(res, 'Method not allowed', 405);

    const txs = await query(
      `SELECT ct.*, b.name as by_name
       FROM credit_transactions ct
       LEFT JOIN users b ON b.id = ct.by_user_id
       WHERE ct.user_id = $1
       ORDER BY ct.created_at DESC LIMIT 100`,
      [user.id]
    );
    return ok(res, txs);
  }

  // ── GET /api/credits/summary ── Overview stats (master only) ──────────────
  if (subpath.endsWith('/credits/summary') || subpath.endsWith('/summary')) {
    if (req.method !== 'GET') return err(res, 'Method not allowed', 405);
    if (user.role !== 'master') return err(res, 'Master access required', 403);

    const thisMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

    const [totalIssued, monthIssued, totalRevenue, studentBalances] = await Promise.all([
      queryOne("SELECT COALESCE(SUM(amount),0) as total FROM credit_transactions WHERE type='credit' AND amount > 0"),
      queryOne("SELECT COALESCE(SUM(amount),0) as total FROM credit_transactions WHERE type='credit' AND amount > 0 AND date LIKE $1", [thisMonth + '%']),
      queryOne("SELECT COALESCE(SUM(paid_amount),0) as total FROM credit_transactions WHERE type='credit' AND amount > 0"),
      query("SELECT id, name, email, credits FROM users WHERE role='student' ORDER BY credits DESC"),
    ]);

    return ok(res, {
      totalCreditsIssued: Number(totalIssued.total),
      thisMonthCredits:   Number(monthIssued.total),
      totalRevenue:       Number(totalRevenue.total),
      studentBalances,
    });
  }

  // ── GET /api/credits ── base route (return user's own balance) ─────────────
  if (req.method === 'GET') {
    const fresh = await queryOne('SELECT id, name, credits FROM users WHERE id = $1', [user.id]);
    return ok(res, fresh);
  }

  return err(res, 'Not found', 404);
});
