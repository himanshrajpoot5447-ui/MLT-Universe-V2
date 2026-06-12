// api/credits/index.js — /api/credits/add, /api/credits/transactions
import { supaRest, requireAuth, isAdmin, ok, err, handler } from '../lib/_api.js';

export default handler(async (req, res) => {
  const user = await requireAuth(req);
  const subpath = (req.url || '').split('?')[0].replace(/\/$/, '');

  // ── POST /api/credits/add ─────────────────────────────────────────────────
  if (subpath.endsWith('/add') && req.method === 'POST') {
    if (!isAdmin(user)) return err(res, 'Forbidden', 403);
    const { userId, amount, note = '', description = '', paymentMode = 'Cash', paidAmount = 0 } = req.body || {};
    if (!userId || amount === undefined) return err(res, 'userId and amount required');

    const rows = await supaRest('GET', `users?id=eq.${userId}&limit=1`);
    const target = rows[0];
    if (!target) return err(res, 'User not found', 404);

    const newCredits = Math.max(0, (target.credits || 0) + parseInt(amount));
    await supaRest('PATCH', `users?id=eq.${userId}`, { credits: newCredits });

    await supaRest('POST', 'credit_transactions', {
      user_id: userId, amount: parseInt(amount),
      type: amount > 0 ? 'manual' : 'deduction',
      description: description || (amount > 0 ? 'Credits added' : 'Credits deducted'),
      note, payment_mode: paymentMode,
      paid_amount: parseFloat(paidAmount) || 0,
      date: new Date().toISOString().split('T')[0],
      by_user_id: user.id,
    }).catch(() => {});

    return ok(res, { user: { id: userId, credits: newCredits } });
  }

  // ── GET /api/credits/transactions ─────────────────────────────────────────
  if (subpath.endsWith('/transactions') && req.method === 'GET') {
    if (!isAdmin(user)) return err(res, 'Forbidden', 403);
    const rows = await supaRest('GET', 'credit_transactions?order=created_at.desc&limit=500');
    return ok(res, rows);
  }

  // ── GET /api/credits/my-transactions ─────────────────────────────────────
  if (subpath.endsWith('/my-transactions') && req.method === 'GET') {
    const rows = await supaRest('GET', `credit_transactions?user_id=eq.${user.id}&order=created_at.desc`);
    return ok(res, rows);
  }

  return err(res, 'Not found', 404);
});
