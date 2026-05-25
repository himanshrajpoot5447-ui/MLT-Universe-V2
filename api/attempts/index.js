// api/attempts/index.js — POST submit attempt / GET list
import { query, queryOne } from '../../lib/db.js';
import { requireAuth, isAdmin } from '../../lib/auth.js';
import { handler, ok, err, normaliseQuestion } from '../../lib/helpers.js';

export default handler(async (req, res) => {
  const user = await requireAuth(req);

  // ── GET /api/attempts/:id — fetch single attempt with questions ──────────────
  const rawUrl2 = req.url || '';
  const urlPath2 = rawUrl2.split('?')[0].replace(/\/+$/, '');
  const segments2 = urlPath2.split('/').filter(Boolean);
  const lastSeg = segments2[segments2.length - 1];
  const attemptId = req.query?.id || (lastSeg && lastSeg !== 'attempts' && lastSeg !== 'api' ? lastSeg : null);

  if (req.method === 'GET' && attemptId) {
    // Fetch the specific attempt
    const att = await queryOne(
      `SELECT a.*, t.title as test_title, t.type as test_type, t.section, t.topic
       FROM attempts a LEFT JOIN tests t ON t.id = a.test_id
       WHERE a.id = $1`, [attemptId]
    );
    if (!att) return err(res, 'Attempt not found', 404);
    // Students can only view their own
    if (user.role === 'student' && att.user_id !== user.id) return err(res, 'Forbidden', 403);

    // Fetch the actual questions that were in this attempt
    const qIds = typeof att.question_ids === 'string' ? JSON.parse(att.question_ids) : (att.question_ids || []);
    let questions = [];
    if (qIds.length > 0) {
      const placeholders = qIds.map((_, i) => `$${i + 1}`).join(',');
      questions = await query(`SELECT * FROM questions WHERE id IN (${placeholders})`, qIds);
    }
    const answers = typeof att.answers === 'string' ? JSON.parse(att.answers) : (att.answers || {});
    return ok(res, {
      ...att,
      answers,
      question_ids: qIds,
      questions: questions.map(q => ({
        ...normaliseQuestion(q),
        yourAnswer: answers[q.id] !== undefined ? parseInt(answers[q.id]) : null,
      })),
    });
  }

  // ── GET /api/attempts ── admin sees all, student sees own ─────────────────
  if (req.method === 'GET') {
    if (isAdmin(user)) {
      const rows = await query(
        `SELECT a.*, u.name as user_name, u.email as user_email,
                t.title as test_title, t.type as test_type
         FROM attempts a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN tests t ON t.id = a.test_id
         ORDER BY a.created_at DESC LIMIT 500`
      );
      return ok(res, rows);
    }
    // Student: own attempts only
    const rows = await query(
      `SELECT a.*, t.title as test_title, t.type as test_type, t.section, t.topic
       FROM attempts a
       LEFT JOIN tests t ON t.id = a.test_id
       WHERE a.user_id = $1 ORDER BY a.created_at DESC`,
      [user.id]
    );
    return ok(res, rows);
  }

  // ── POST /api/attempts ── submit a test ───────────────────────────────────
  if (req.method === 'POST') {
    const { testId, answers = {}, timeTaken = 0, questionTimes = {} } = req.body || {};
    if (!testId) return err(res, 'testId required');

    const test = await queryOne('SELECT * FROM tests WHERE id=$1', [testId]);
    if (!test) return err(res, 'Test not found', 404);
    if (test.status !== 'published') return err(res, 'Test is not published');

    // Credits check
    const currentUser = await queryOne('SELECT * FROM users WHERE id=$1', [user.id]);
    if (currentUser.role === 'student' && currentUser.credits < test.credits) {
      return err(res, `Insufficient credits. Need ${test.credits}, have ${currentUser.credits}`);
    }

    // Get questions for this test
    const qIds = [
      ...(test.question_ids || []),
      ...(test.assigned_question_ids || [])
    ].filter(Boolean);

    let questions = [];
    if (qIds.length > 0) {
      const placeholders = qIds.map((_,i) => `$${i+1}`).join(',');
      questions = await query(`SELECT * FROM questions WHERE id IN (${placeholders})`, qIds);
    }

    // Score calculation with positive/negative marking
    let correct = 0, wrong = 0;
    questions.forEach(q => {
      const ans = answers[q.id];
      if (ans !== undefined) {
        if (parseInt(ans) === q.correct) correct++;
        else wrong++;
      }
    });

    const posMarks = parseFloat(test.positive_marks) || 1;
    const negMarks = parseFloat(test.negative_marks) || 0;
    const total    = questions.length;
    const rawMarks = (correct * posMarks) - (wrong * negMarks);
    const maxMarks = total * posMarks;
    const score    = maxMarks > 0 ? Math.max(0, Math.round((rawMarks / maxMarks) * 100)) : 0;
    const xp       = Math.max(0, Math.round(rawMarks)) * 10;
    const today    = new Date().toISOString().split('T')[0];
    const attId    = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);

    // Save attempt — question_times stored for per-question emoji analysis
    const skipped = total - correct - wrong;
    const savedQuestionIds = questions.map(q => q.id);
    await query(
      `INSERT INTO attempts
         (id,user_id,test_id,score,total_questions,correct,wrong,skipped,time_taken,answers,question_times,question_ids,completed_at,xp_earned)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [attId, user.id, testId, score, total, correct, wrong, skipped, timeTaken,
       JSON.stringify(answers), JSON.stringify(questionTimes), JSON.stringify(savedQuestionIds), today, xp]
    );

    // Deduct credits + log transaction
    if (currentUser.role === 'student' && test.credits > 0) {
      await query('UPDATE users SET credits = credits - $1 WHERE id=$2', [test.credits, user.id]);
      await query(
        `INSERT INTO credit_transactions (user_id,amount,type,description,date)
         VALUES ($1,$2,'debit',$3,$4)`,
        [user.id, -test.credits, `Test: ${test.title}`, today]
      );
    }

    // Add XP
    await query('UPDATE users SET total_xp = total_xp + $1 WHERE id=$2', [xp, user.id]);

    // Update test stats
    const allAttempts = await query('SELECT score FROM attempts WHERE test_id=$1', [testId]);
    const avgScore = allAttempts.length
      ? Math.round(allAttempts.reduce((s,a) => s + a.score, 0) / allAttempts.length)
      : 0;
    await query('UPDATE tests SET attempts_count=$1, avg_score=$2 WHERE id=$3',
      [allAttempts.length, avgScore, testId]);

    // Recalculate student ranks
    const students = await query(
      "SELECT id FROM users WHERE role='student' ORDER BY total_xp DESC"
    );
    for (let i = 0; i < students.length; i++) {
      await query('UPDATE users SET rank=$1 WHERE id=$2', [i + 1, students[i].id]);
    }

    const rawMarksDisplay = (correct * posMarks) - (wrong * negMarks);
    return ok(res, {
      id: attId, score, correct, wrong, skipped, totalQuestions: total,
      positiveMarks: posMarks, negativeMarks: negMarks,
      rawMarks: Math.max(0, rawMarksDisplay), maxMarks: maxMarks,
      xpEarned: xp, timeTaken, completedAt: today,
      questionTimes,
      questions: questions.map(q => ({
        ...normaliseQuestion(q),
        yourAnswer: answers[q.id] !== undefined ? parseInt(answers[q.id]) : null,
      })),
    }, 201);
  }

  err(res, 'Method not allowed', 405);
});
