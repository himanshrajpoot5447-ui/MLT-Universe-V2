// api/attempts/index.js — POST submit attempt / GET list
import { query, queryOne } from '../lib/db.js';
import { requireAuth, isAdmin } from '../lib/auth.js';
import { handler, ok, err, normaliseQuestion } from '../lib/helpers.js';

export default handler(async (req, res) => {
  const user = await requireAuth(req);

  // ── GET /api/attempts/:id — fetch single attempt with questions ──────────────
  const rawUrl2 = req.url || '';
  const urlPath2 = rawUrl2.split('?')[0].replace(/\/+$/, '');
  const segments2 = urlPath2.split('/').filter(Boolean);
  const lastSeg = segments2[segments2.length - 1];
  const attemptId = req.query?.id || (lastSeg && lastSeg !== 'attempts' && lastSeg !== 'api' ? lastSeg : null);

  if (req.method === 'GET' && attemptId) {
    const att = await queryOne(
      `SELECT a.*, t.title as test_title, t.type as test_type, t.section, t.topic
       FROM attempts a LEFT JOIN tests t ON t.id = a.test_id
       WHERE a.id = $1`, [attemptId]
    );
    if (!att) return err(res, 'Attempt not found', 404);
    if (user.role === 'student' && att.user_id !== user.id) return err(res, 'Forbidden', 403);
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
    const rows = await query(
      `SELECT a.*, t.title as test_title, t.type as test_type, t.section, t.topic
       FROM attempts a
       LEFT JOIN tests t ON t.id = a.test_id
       WHERE a.user_id = $1 ORDER BY a.created_at DESC`,
      [user.id]
    );
    return ok(res, rows);
  }

  // ── POST /api/attempts/start — deduct credits when test STARTS ──────────────
  // Called when user clicks "Begin Exam" / "Reattempt Exam"
  const urlPathStr = (req.url || '').split('?')[0].replace(/\/+$/, '');
  if (req.method === 'POST' && urlPathStr.endsWith('/start')) {
    const { testId, attemptToken } = req.body || {};
    if (!testId) return err(res, 'testId required');

    const test = await queryOne('SELECT * FROM tests WHERE id=$1', [testId]);
    if (!test) return err(res, 'Test not found', 404);
    if (test.status !== 'published') return err(res, 'Test is not published');

    const currentUser = await queryOne('SELECT * FROM users WHERE id=$1', [user.id]);

    // Check if this is a resume (token already exists in active_attempts) — no double deduction
    if (attemptToken) {
      const existing = await queryOne(
        `SELECT id FROM active_attempts WHERE token=$1 AND user_id=$2 AND test_id=$3`,
        [attemptToken, user.id, testId]
      ).catch(() => null);
      if (existing) {
        // Resume — credits already deducted, just return ok
        return ok(res, { resumed: true, credits: currentUser.credits });
      }
    }

    // Fresh start — deduct credits now
    if (currentUser.role === 'student' && currentUser.credits < test.credits) {
      return err(res, `Insufficient credits. Need ${test.credits}, have ${currentUser.credits}`);
    }

    const today = new Date().toISOString().split('T')[0];
    const newToken = 'tok_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    // Store active attempt token to prevent double deduction on resume/refresh
    // Use a simple upsert via insert-on-conflict (table created in schema.sql below)
    try {
      await query(
        `INSERT INTO active_attempts (token, user_id, test_id, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, test_id) DO UPDATE SET token=EXCLUDED.token, created_at=NOW()`,
        [newToken, user.id, testId]
      );
    } catch {
      // Table may not exist yet — fall through, deduct at submit
    }

    let newCredits = currentUser.credits;
    if (currentUser.role === 'student' && test.credits > 0) {
      newCredits = Math.max(0, currentUser.credits - test.credits);
      await query('UPDATE users SET credits=$1 WHERE id=$2', [newCredits, user.id]);
      const txId = 'ct' + Date.now() + '_start';
      await query(
        `INSERT INTO credit_transactions (id,user_id,amount,type,description,date)
         VALUES ($1,$2,$3,'debit',$4,$5)`,
        [txId, user.id, -test.credits, `Test Started: ${test.title}`, today]
      );
    }

    return ok(res, { token: newToken, credits: newCredits });
  }

  // ── POST /api/attempts ── submit a test ───────────────────────────────────
  if (req.method === 'POST') {
    const { testId, answers = {}, timeTaken = 0, questionTimes = {}, attemptToken } = req.body || {};
    if (!testId) return err(res, 'testId required');

    const test = await queryOne('SELECT * FROM tests WHERE id=$1', [testId]);
    if (!test) return err(res, 'Test not found', 404);
    if (test.status !== 'published') return err(res, 'Test is not published');

    const currentUser = await queryOne('SELECT * FROM users WHERE id=$1', [user.id]);

    // Check if credits were already deducted at start (via active_attempts token)
    let creditAlreadyDeducted = false;
    if (attemptToken) {
      const activeAtt = await queryOne(
        `SELECT id FROM active_attempts WHERE token=$1 AND user_id=$2 AND test_id=$3`,
        [attemptToken, user.id, testId]
      ).catch(() => null);
      if (activeAtt) creditAlreadyDeducted = true;
    }

    // If no token (legacy flow or /start not called), do credits check & deduct now
    if (!creditAlreadyDeducted) {
      if (currentUser.role === 'student' && currentUser.credits < test.credits) {
        return err(res, `Insufficient credits. Need ${test.credits}, have ${currentUser.credits}`);
      }
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

    const skipped = total - correct - wrong;
    const savedQuestionIds = questions.map(q => q.id);
    await query(
      `INSERT INTO attempts
         (id,user_id,test_id,score,total_questions,correct,wrong,skipped,time_taken,answers,question_times,question_ids,completed_at,xp_earned)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [attId, user.id, testId, score, total, correct, wrong, skipped, timeTaken,
       JSON.stringify(answers), JSON.stringify(questionTimes), JSON.stringify(savedQuestionIds), today, xp]
    );

    // Deduct credits only if not already deducted at start
    const freshUser = await queryOne('SELECT credits, total_xp FROM users WHERE id=$1', [user.id]);
    if (!creditAlreadyDeducted && currentUser.role === 'student' && test.credits > 0) {
      const newCredits = Math.max(0, (freshUser?.credits || 0) - test.credits);
      await query('UPDATE users SET credits=$1 WHERE id=$2', [newCredits, user.id]);
      const txId2 = 'ct' + Date.now() + '_test';
      await query(
        `INSERT INTO credit_transactions (id,user_id,amount,type,description,date)
         VALUES ($1,$2,$3,'debit',$4,$5)`,
        [txId2, user.id, -test.credits, `Test: ${test.title}`, today]
      );
    }

    // Clean up active attempt token
    if (attemptToken) {
      await query(`DELETE FROM active_attempts WHERE token=$1`, [attemptToken]).catch(() => {});
    }

    // Add XP
    const newXP = (freshUser?.total_xp || 0) + xp;
    await query('UPDATE users SET total_xp=$1 WHERE id=$2', [newXP, user.id]);

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
