// api/tests.js — handles all /api/tests and /api/tests/:id routes
import { query, queryOne } from './lib/db.js';
import { requireAuth, isAdmin, isMaster } from './lib/auth.js';
import { handler, ok, err, normaliseTest } from './lib/helpers.js';

export default handler(async (req, res) => {
  const user = await requireAuth(req);

  const rawUrl  = req.url || '';
  const urlPath = rawUrl.split('?')[0].replace(/\/$/, '');

  // Detect :id from req.query (Vercel rewrites) or last URL segment
  let id = req.query?.id || null;
  if (!id) {
    const segments = urlPath.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last !== 'tests' && last !== 'api') id = last;
  }

  // ── /api/tests/:id ────────────────────────────────────────────────────────
  if (id) {
    const test = await queryOne('SELECT * FROM tests WHERE id=$1', [id]);
    if (!test) return err(res, 'Test not found', 404);
    if (user.role === 'student' && test.status !== 'published') return err(res, 'Test not found', 404);

    if (req.method === 'GET') return ok(res, normaliseTest(test));

    if (req.method === 'PUT') {
      if (!isAdmin(user)) return err(res, 'Admin access required', 403);
      if (!isMaster(user) && test.created_by !== user.id) return err(res, 'You can only edit your own tests', 403);

      const {
        title, description, status, timeLimit, credits,
        positiveMarks, negativeMarks, totalQuestions,
        section, topic, topics, topicDistribution,
        sections, sectionDistribution, questionIds, assignedQuestionIds
      } = req.body || {};

      const sets = [], params = []; let i = 1;
      const setField = (col, val, transform) => {
        if (val !== undefined && val !== null) {
          sets.push(`${col}=$${i++}`);
          params.push(transform ? transform(val) : val);
        }
      };
      setField('title',                 title);
      setField('description',           description);
      setField('status',                status);
      setField('time_limit',            timeLimit,           v => parseInt(v));
      setField('credits',               credits,             v => parseInt(v));
      setField('positive_marks',        positiveMarks,       v => parseFloat(v));
      setField('negative_marks',        negativeMarks,       v => parseFloat(v));
      setField('total_questions',       totalQuestions,      v => parseInt(v));
      setField('section',               section);
      setField('topic',                 topic);
      setField('topics',                topics,              JSON.stringify);
      setField('topic_distribution',    topicDistribution,   JSON.stringify);
      setField('sections',              sections,            JSON.stringify);
      setField('section_distribution',  sectionDistribution, JSON.stringify);
      setField('question_ids',          questionIds,         JSON.stringify);
      setField('assigned_question_ids', assignedQuestionIds, JSON.stringify);

      if (!sets.length) return err(res, 'Nothing to update');
      params.push(id);
      const [updated] = await query(
        `UPDATE tests SET ${sets.join(',')} WHERE id=$${i} RETURNING *`,
        params
      );
      return ok(res, normaliseTest(updated));
    }

    if (req.method === 'DELETE') {
      if (!isAdmin(user)) return err(res, 'Admin access required', 403);
      if (!isMaster(user) && test.created_by !== user.id) return err(res, 'You can only delete your own tests', 403);

      // Read XP earned from all attempts on this test so we can reverse it
      const testAttempts = await query(
        'SELECT user_id, xp_earned FROM attempts WHERE test_id=$1',
        [id]
      );

      // ON DELETE CASCADE in DB removes attempts automatically
      await query('DELETE FROM tests WHERE id=$1', [id]);

      // Reverse XP for affected students and recalculate ranks
      if (testAttempts.length > 0) {
        for (const att of testAttempts) {
          await query(
            'UPDATE users SET total_xp = GREATEST(0, total_xp - $1) WHERE id=$2',
            [att.xp_earned || 0, att.user_id]
          );
        }
        const students = await query(
          "SELECT id FROM users WHERE role='student' ORDER BY total_xp DESC"
        );
        for (let j = 0; j < students.length; j++) {
          await query('UPDATE users SET rank=$1 WHERE id=$2', [j + 1, students[j].id]);
        }
      }

      return ok(res, { message: 'Test and all associated attempts deleted' });
    }

    return err(res, 'Method not allowed', 405);
  }

  // ── /api/tests ────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const qsRaw = rawUrl.includes('?') ? rawUrl.split('?')[1] : '';
    const qs    = Object.fromEntries(new URLSearchParams(qsRaw));

    let sql = 'SELECT * FROM tests WHERE 1=1';
    const params = []; let i = 1;

    if (user.role === 'student') {
      sql += ` AND status='published'`;
    } else {
      if (qs.status) { sql += ` AND status=$${i++}`; params.push(qs.status); }
    }
    if (qs.type) { sql += ` AND type=$${i++}`; params.push(qs.type); }
    sql += ' ORDER BY created_at DESC';

    const rows = await query(sql, params);
    return ok(res, rows.map(normaliseTest));
  }

  if (req.method === 'POST') {
    if (!isAdmin(user)) return err(res, 'Admin access required', 403);

    const {
      title, description = '', type, status = 'draft',
      timeLimit = 30, credits = 0, positiveMarks = 1, negativeMarks = 0,
      section = null, topic = null,
      topics = [], topicDistribution = {},
      sections = [], sectionDistribution = {},
      questionIds = [], assignedQuestionIds = [],
      totalQuestions = 0,
    } = req.body || {};

    if (!title || !type) return err(res, 'Title and type are required');

    const [t] = await query(
      `INSERT INTO tests (
         title, description, type, status, total_questions, time_limit, credits,
         positive_marks, negative_marks,
         section, topic, topics, topic_distribution,
         sections, section_distribution,
         question_ids, assigned_question_ids,
         attempts_count, avg_score, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,0,0,$18
       ) RETURNING *`,
      [
        title, description, type, status, totalQuestions, timeLimit, credits,
        positiveMarks, negativeMarks,
        section, topic,
        JSON.stringify(topics), JSON.stringify(topicDistribution),
        JSON.stringify(sections), JSON.stringify(sectionDistribution),
        JSON.stringify(questionIds), JSON.stringify(assignedQuestionIds),
        user.id,
      ]
    );
    return ok(res, normaliseTest(t), 201);
  }

  return err(res, 'Method not allowed', 405);
});
