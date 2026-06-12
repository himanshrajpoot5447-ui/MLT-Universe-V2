// api/admin.js — /api/analytics, /api/leaderboard — direct Supabase REST
import { supaRest, requireAuth, isAdmin, ok, err, handler } from './lib/_api.js';

export default handler(async (req, res) => {
  const user = await requireAuth(req);
  const subpath = (req.url || '').split('?')[0].replace(/\/$/, '');

  // ── GET /api/leaderboard ──────────────────────────────────────────────────
  if (subpath.endsWith('/leaderboard')) {
    const rows = await supaRest('GET', "users?role=eq.student&status=eq.active&order=total_xp.desc&limit=50&select=id,name,avatar,total_xp,rank");
    return ok(res, rows.map((u, i) => ({
      id: u.id, name: u.name, avatar: u.avatar,
      totalXp: u.total_xp || 0, rank: u.rank || (i + 1),
    })));
  }

  // ── GET /api/analytics — admin only ──────────────────────────────────────
  if (subpath.endsWith('/analytics')) {
    if (!isAdmin(user)) return err(res, 'Forbidden', 403);

    const [users, tests, attempts] = await Promise.all([
      supaRest('GET', 'users?select=id,role,status,created_at').catch(() => []),
      supaRest('GET', 'tests?select=id,status,created_at').catch(() => []),
      supaRest('GET', 'attempts?select=id,score,completed_at,user_id&order=completed_at.desc&limit=1000').catch(() => []),
    ]);

    const students = users.filter(u => u.role === 'student');
    const active   = students.filter(u => u.status === 'active');
    const avgScore = attempts.length
      ? Math.round(attempts.reduce((s, a) => s + (a.score || 0), 0) / attempts.length)
      : 0;

    return ok(res, {
      totalStudents: students.length,
      activeStudents: active.length,
      totalTests: tests.length,
      publishedTests: tests.filter(t => t.status === 'published').length,
      totalAttempts: attempts.length,
      avgScore,
    });
  }

  return err(res, 'Not found', 404);
});
