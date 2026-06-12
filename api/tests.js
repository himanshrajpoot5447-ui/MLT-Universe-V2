// api/tests.js — direct Supabase REST, no pg_query double-trip
import { supaRest, requireAuth, isAdmin, ok, err, handler, normaliseTest } from './lib/_api.js';

const isMaster = u => u?.role === 'master';

export default handler(async (req, res) => {
  const user = await requireAuth(req);
  const segments = (req.url || '').split('?')[0].split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  const id   = (last && last !== 'tests') ? last : (req.query?.id || null);

  // ── /api/tests/:id ────────────────────────────────────────────────────────
  if (id) {
    const rows = await supaRest('GET', `tests?id=eq.${id}&limit=1`);
    const test = rows[0];
    if (!test) return err(res, 'Test not found', 404);
    if (user.role === 'student' && test.status !== 'published') return err(res, 'Test not found', 404);

    if (req.method === 'GET') return ok(res, normaliseTest(test));

    if (req.method === 'PUT') {
      if (!isAdmin(user)) return err(res, 'Forbidden', 403);
      if (!isMaster(user) && test.created_by !== user.id) return err(res, 'You can only edit your own tests', 403);
      const b = req.body || {};
      const patch = {};
      if (b.title               !== undefined) patch.title                 = b.title;
      if (b.description         !== undefined) patch.description           = b.description;
      if (b.status              !== undefined) patch.status                = b.status;
      if (b.timeLimit           !== undefined) patch.time_limit            = parseInt(b.timeLimit);
      if (b.credits             !== undefined) patch.credits               = parseInt(b.credits);
      if (b.positiveMarks       !== undefined) patch.positive_marks        = parseFloat(b.positiveMarks);
      if (b.negativeMarks       !== undefined) patch.negative_marks        = parseFloat(b.negativeMarks);
      if (b.totalQuestions      !== undefined) patch.total_questions       = parseInt(b.totalQuestions);
      if (b.section             !== undefined) patch.section               = b.section;
      if (b.topic               !== undefined) patch.topic                 = b.topic;
      if (b.topics              !== undefined) patch.topics                = JSON.stringify(b.topics);
      if (b.topicDistribution   !== undefined) patch.topic_distribution    = JSON.stringify(b.topicDistribution);
      if (b.sections            !== undefined) patch.sections              = JSON.stringify(b.sections);
      if (b.sectionDistribution !== undefined) patch.section_distribution  = JSON.stringify(b.sectionDistribution);
      if (b.questionIds         !== undefined) patch.question_ids          = JSON.stringify(b.questionIds);
      if (b.assignedQuestionIds !== undefined) patch.assigned_question_ids = JSON.stringify(b.assignedQuestionIds);
      if (!Object.keys(patch).length) return err(res, 'Nothing to update');
      const updated = await supaRest('PATCH', `tests?id=eq.${id}`, patch);
      return ok(res, normaliseTest(updated[0] || { ...test, ...patch }));
    }

    if (req.method === 'DELETE') {
      if (!isAdmin(user)) return err(res, 'Forbidden', 403);
      if (!isMaster(user) && test.created_by !== user.id) return err(res, 'You can only delete your own tests', 403);
      // Get attempts for XP reversal
      const attempts = await supaRest('GET', `attempts?test_id=eq.${id}&select=user_id,xp_earned`).catch(() => []);
      // Delete test (attempts cascade)
      await supaRest('DELETE', `tests?id=eq.${id}`);
      // Reverse XP
      for (const a of attempts) {
        const xp = Math.max(0, a.xp_earned || 0);
        if (xp > 0) {
          const uRows = await supaRest('GET', `users?id=eq.${a.user_id}&select=total_xp&limit=1`).catch(() => []);
          if (uRows[0]) {
            await supaRest('PATCH', `users?id=eq.${a.user_id}`, { total_xp: Math.max(0, (uRows[0].total_xp || 0) - xp) }).catch(() => {});
          }
        }
      }
      return ok(res, { deleted: true });
    }

    return err(res, 'Method not allowed', 405);
  }

  // ── /api/tests ────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
    let path = 'tests?order=created_at.desc';
    if (user.role === 'student') path += '&status=eq.published';
    else if (qs.get('status'))   path += `&status=eq.${qs.get('status')}`;
    if (qs.get('type')) path += `&type=eq.${qs.get('type')}`;
    const rows = await supaRest('GET', path);
    return ok(res, rows.map(normaliseTest));
  }

  if (req.method === 'POST') {
    if (!isAdmin(user)) return err(res, 'Forbidden', 403);
    const b = req.body || {};
    if (!b.title || !b.type) return err(res, 'title and type are required');
    const row = {
      title: b.title, description: b.description || '',
      type: b.type, status: b.status || 'draft',
      total_questions:       parseInt(b.totalQuestions)  || 0,
      time_limit:            parseInt(b.timeLimit)        || 30,
      credits:               parseInt(b.credits)          || 0,
      positive_marks:        parseFloat(b.positiveMarks)  || 1,
      negative_marks:        parseFloat(b.negativeMarks)  || 0,
      section:               b.section  || null,
      topic:                 b.topic    || null,
      topics:                JSON.stringify(b.topics              || []),
      topic_distribution:    JSON.stringify(b.topicDistribution   || {}),
      sections:              JSON.stringify(b.sections            || []),
      section_distribution:  JSON.stringify(b.sectionDistribution || {}),
      question_ids:          JSON.stringify(b.questionIds         || []),
      assigned_question_ids: JSON.stringify(b.assignedQuestionIds || []),
      attempts_count: 0, avg_score: 0, created_by: user.id,
    };
    const created = await supaRest('POST', 'tests', row);
    return ok(res, normaliseTest(created[0]), 201);
  }

  return err(res, 'Method not allowed', 405);
});
