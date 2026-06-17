// api/admin.js — /api/analytics, /api/leaderboard — direct Supabase REST
import { supaRest, requireAuth, isAdmin, ok, err, handler } from './lib/_api.js';

export default handler(async (req, res) => {
  const user = await requireAuth(req);
  const subpath = (req.url || '').split('?')[0].replace(/\/$/, '');

  // ── GET /api/leaderboard ──────────────────────────────────────────────────
  if (subpath.endsWith('/leaderboard')) {
    const period = req.query?.period || 'weekly';

    // Compute date cutoff
    let cutoffDate = null;
    if (period === 'weekly') {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      cutoffDate = d.toISOString().split('T')[0];
    } else if (period === 'monthly') {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      cutoffDate = d.toISOString().split('T')[0];
    }

    // Fetch students
    const students = await supaRest('GET', 'users?role=eq.student&status=eq.active&select=id,name,avatar,total_xp');

    if (period === 'alltime') {
      // For alltime, use total_xp directly
      const sorted = students
        .sort((a, b) => (b.total_xp || 0) - (a.total_xp || 0))
        .map((u, i) => ({
          id: u.id, name: u.name, avatar: u.avatar,
          period_xp: u.total_xp || 0,
          total_xp: u.total_xp || 0,
          tests_completed: 0, avg_score: 0,
          rank: i + 1,
        }));
      return ok(res, sorted);
    }

    // For weekly/monthly: sum xp_earned from attempts in the period
    let attemptsQuery = `attempts?select=user_id,xp_earned,score,completed_at`;
    if (cutoffDate) attemptsQuery += `&completed_at=gte.${cutoffDate}`;
    const attempts = await supaRest('GET', attemptsQuery).catch(() => []);

    // Aggregate per student
    const statsMap = {};
    attempts.forEach(a => {
      if (!statsMap[a.user_id]) statsMap[a.user_id] = { xp: 0, tests: 0, totalScore: 0 };
      statsMap[a.user_id].xp += (a.xp_earned || 0);
      statsMap[a.user_id].tests += 1;
      statsMap[a.user_id].totalScore += (a.score || 0);
    });

    const result = students.map(u => {
      const s = statsMap[u.id] || { xp: 0, tests: 0, totalScore: 0 };
      return {
        id: u.id, name: u.name, avatar: u.avatar,
        period_xp: s.xp,
        total_xp: u.total_xp || 0,
        tests_completed: s.tests,
        avg_score: s.tests > 0 ? Math.round(s.totalScore / s.tests) : 0,
      };
    })
    .filter(u => u.period_xp > 0 || u.tests_completed > 0)
    .sort((a, b) => b.period_xp - a.period_xp || b.tests_completed - a.tests_completed)
    .map((u, i) => ({ ...u, rank: i + 1 }));

    return ok(res, result);
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
