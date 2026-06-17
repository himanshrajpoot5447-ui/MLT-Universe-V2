// api/credits/index.js — /api/credits/add, /api/credits/transactions
import { supaRest, requireAuth, isAdmin, ok, err, handler } from '../lib/_api.js';

// Enrich transactions with user names
async function enrichTxs(rows) {
  if (!rows.length) return rows;
  // Collect all unique user IDs (students + by_user_id admins)
  const ids = [...new Set([
    ...rows.map(r => r.user_id),
    ...rows.map(r => r.by_user_id).filter(Boolean),
  ])];
  let nameMap = {};
  try {
    const users = await supaRest('GET', `users?id=in.(${ids.join(',')})&select=id,name`);
    users.forEach(u => { nameMap[u.id] = u.name; });
  } catch {}
  return rows.map(r => ({
    ...r,
    by_name: nameMap[r.by_user_id] || r.by_user_id || '',
    student_name: nameMap[r.user_id] || '',
  }));
}

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

    try {
      await supaRest('POST', 'credit_transactions', {
        user_id: userId, amount: parseInt(amount),
        type: amount > 0 ? 'credit' : 'debit',
        description: description || (amount > 0 ? 'Credits added' : 'Credits deducted'),
        note, payment_mode: paymentMode,
        paid_amount: parseFloat(paidAmount) || 0,
        date: new Date().toISOString().split('T')[0],
        by_user_id: user.id,
      });
    } catch (e) {
      console.error('[credits/add] failed to insert credit_transactions:', e.message);
      // Credits were already updated on the user; still let the caller know the ledger entry failed
      return ok(res, { user: { id: userId, credits: newCredits }, warning: 'Credit balance updated but transaction log failed: ' + e.message });
    }

    return ok(res, { user: { id: userId, credits: newCredits } });
  }

  // ── GET /api/credits/transactions ─────────────────────────────────────────
  if (subpath.endsWith('/transactions') && req.method === 'GET') {
    if (!isAdmin(user)) return err(res, 'Forbidden', 403);
    let rows;
    try {
      rows = await supaRest('GET', 'credit_transactions?order=created_at.desc&limit=500');
    } catch (e) {
      console.error('[credits/transactions] read failed:', e.message);
      return err(res, 'Failed to load credit transactions: ' + e.message, 500);
    }

    // If no transaction rows exist yet, synthesize opening-balance entries from users.credits
    // so the ledger is never blank when balances already exist in the DB
    if (!rows.length) {
      const students = await supaRest('GET', 'users?role=eq.student&credits=gt.0').catch(() => []);
      rows = students.map(s => ({
        id: 'synthetic-' + s.id,
        user_id: s.id,
        amount: s.credits,
        type: 'manual',
        description: 'Opening balance (pre-existing)',
        note: '',
        payment_mode: 'Cash',
        paid_amount: 0,
        date: new Date().toISOString().split('T')[0],
        by_user_id: null,
        by_name: 'System',
        student_name: s.name || '',
        created_at: new Date().toISOString(),
      }));
      return ok(res, rows);
    }

    return ok(res, await enrichTxs(rows));
  }

  // ── GET /api/credits/my-transactions ─────────────────────────────────────
  if (subpath.endsWith('/my-transactions') && req.method === 'GET') {
    let rows;
    try {
      rows = await supaRest('GET', `credit_transactions?user_id=eq.${user.id}&order=created_at.desc`);
    } catch (e) {
      console.error('[credits/my-transactions] read failed:', e.message);
      return err(res, 'Failed to load transactions: ' + e.message, 500);
    }

    // If no transactions exist yet but student has a credit balance, synthesize an opening entry
    if (!rows.length) {
      const users = await supaRest('GET', `users?id=eq.${user.id}&select=id,name,credits&limit=1`).catch(() => []);
      const u = users[0];
      if (u && u.credits > 0) {
        return ok(res, [{
          id: 'synthetic-' + u.id,
          user_id: u.id,
          amount: u.credits,
          type: 'manual',
          description: 'Opening balance',
          note: '',
          payment_mode: 'Cash',
          paid_amount: 0,
          date: new Date().toISOString().split('T')[0],
          by_user_id: null,
          by_name: 'System',
          student_name: u.name || '',
          created_at: new Date().toISOString(),
        }]);
      }
      return ok(res, []);
    }

    return ok(res, await enrichTxs(rows));
  }

  return err(res, 'Not found', 404);
});
