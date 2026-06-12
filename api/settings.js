// api/settings.js — GET/PUT /api/settings
import { supaRest, requireAuth, ok, err, handler } from './lib/_api.js';
const isMaster = u => u?.role === 'master';

export default handler(async (req, res) => {
  const user = await requireAuth(req);

  if (req.method === 'GET') {
    const rows = await supaRest('GET', "settings?key=eq.app_settings&limit=1");
    const raw = rows[0]?.value;
    const data = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
    return ok(res, { creditPlans: data.creditPlans || [], whatsappNumber: data.whatsappNumber || '' });
  }

  if (req.method === 'PUT') {
    if (!isMaster(user)) return err(res, 'Master access required', 403);
    const { creditPlans, whatsappNumber } = req.body || {};
    const value = JSON.stringify({ creditPlans: creditPlans || [], whatsappNumber: whatsappNumber || '' });
    // Upsert
    await supaRest('POST', 'settings', { key: 'app_settings', value }).catch(async () => {
      await supaRest('PATCH', "settings?key=eq.app_settings", { value });
    });
    return ok(res, { saved: true });
  }

  return err(res, 'Method not allowed', 405);
});
