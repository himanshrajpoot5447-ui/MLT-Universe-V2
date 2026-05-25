// api/admin.js — handles /api/analytics and /api/leaderboard
import { query, queryOne } from '../lib/db.js';
import { requireAuth, isAdmin } from '../lib/auth.js';
import { handler, ok, err } from '../lib/helpers.js';

export default handler(async (req, res) => {
  const subpath = req.url?.split('?')[0].replace(/\/$/, '') || '';
  const qs = Object.fromEntries(new URL(req.url, 'http://x').searchParams);

  // ── GET /api/analytics ────────────────────────────────────────────────────
  if (subpath.endsWith('/analytics')) {
    const user = await requireAuth(req);
    if (!isAdmin(user)) return err(res, 'Admin access required', 403);
    if (req.method !== 'GET') return err(res, 'Method not allowed', 405);

    const [
      studentStats, testStats, attemptStats, recentAttempts, topStudents, sectionPerf, totalQuestions
    ] = await Promise.all([
      query("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='active') as active FROM users WHERE role='student'"),
      query("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='published') as published FROM tests"),
      query("SELECT COUNT(*) as total, COALESCE(ROUND(AVG(score)),0) as avg_score FROM attempts"),
      query(`
        SELECT a.id, a.score, a.correct, a.total_questions, a.created_at,
               u.name as user_name, t.title as test_title
        FROM attempts a
        JOIN users u ON u.id = a.user_id
        JOIN tests t ON t.id = a.test_id
        ORDER BY a.created_at DESC LIMIT 10
      `),
      query(`
        SELECT u.id, u.name, u.avatar, u.total_xp, u.rank,
               COUNT(a.id) as tests_completed,
               COALESCE(ROUND(AVG(a.score)),0) as avg_score
        FROM users u
        LEFT JOIN attempts a ON a.user_id = u.id
        WHERE u.role = 'student'
        GROUP BY u.id, u.name, u.avatar, u.total_xp, u.rank
        ORDER BY u.total_xp DESC LIMIT 10
      `),
      query(`
        SELECT t.section,
               COUNT(a.id) as attempts,
               COALESCE(ROUND(AVG(a.score)),0) as avg_score
        FROM attempts a
        JOIN tests t ON t.id = a.test_id
        WHERE t.section IS NOT NULL
        GROUP BY t.section ORDER BY avg_score DESC
      `),
      queryOne('SELECT COUNT(*) as n FROM questions'),
    ]);

    return ok(res, {
      totalStudents:  parseInt(studentStats[0].total),
      activeStudents: parseInt(studentStats[0].active),
      totalTests:     parseInt(testStats[0].published),
      totalAttempts:  parseInt(attemptStats[0].total),
      avgScore:       parseInt(attemptStats[0].avg_score),
      totalQuestions: parseInt(totalQuestions.n),
      recentAttempts,
      topStudents,
      sectionPerf,
    });
  }

  // ── GET /api/leaderboard ──────────────────────────────────────────────────
  // Supports ?period=weekly|monthly|alltime (default: alltime)
  if (subpath.endsWith('/leaderboard')) {
    await requireAuth(req);
    if (req.method !== 'GET') return err(res, 'Method not allowed', 405);

    const period = qs.period || 'alltime';
    let dateFilter = '';
    const params = [];

    if (period === 'weekly') {
      dateFilter = "AND a.created_at >= NOW() - INTERVAL '7 days'";
    } else if (period === 'monthly') {
      dateFilter = "AND a.created_at >= NOW() - INTERVAL '30 days'";
    }

    // For period-based: sum XP earned from attempts in that window
    // For alltime: use stored total_xp
    let rows;
    if (period === 'alltime') {
      rows = await query(`
        SELECT u.id, u.name, u.avatar, u.total_xp as period_xp, u.rank,
               COUNT(a.id) as tests_completed,
               COALESCE(ROUND(AVG(a.score)),0) as avg_score
        FROM users u
        LEFT JOIN attempts a ON a.user_id = u.id
        WHERE u.role = 'student' AND u.status = 'active'
        GROUP BY u.id, u.name, u.avatar, u.total_xp, u.rank
        ORDER BY u.total_xp DESC
        LIMIT 100
      `);
    } else {
      rows = await query(`
        SELECT u.id, u.name, u.avatar, u.rank,
               COALESCE(SUM(a.xp_earned), 0) as period_xp,
               COUNT(a.id) as tests_completed,
               COALESCE(ROUND(AVG(a.score)),0) as avg_score
        FROM users u
        LEFT JOIN attempts a ON a.user_id = u.id ${dateFilter}
        WHERE u.role = 'student' AND u.status = 'active'
        GROUP BY u.id, u.name, u.avatar, u.rank
        ORDER BY period_xp DESC
        LIMIT 100
      `);
    }

    // Add sequential rank for this period
    const ranked = rows.map((r, i) => ({ ...r, rank: i + 1, periodXP: parseInt(r.period_xp) || 0 }));
    return ok(res, ranked);
  }

  return err(res, 'Not found', 404);
});
