// api/attempts/index.js — POST submit / GET list — direct Supabase REST
import { supaRest, requireAuth, isAdmin, ok, err, handler, normaliseQuestion, normaliseAttempt } from '../lib/_api.js';

export default handler(async (req, res) => {
  const user = await requireAuth(req);

  const urlPath  = (req.url || '').split('?')[0].replace(/\/+$/, '');
  const segments = urlPath.split('/').filter(Boolean);
  const last     = segments[segments.length - 1];
  const attemptId = req.query?.id || (last && last !== 'attempts' && last !== 'api' ? last : null);

  // ── GET /api/attempts/:id ─────────────────────────────────────────────────
  if (req.method === 'GET' && attemptId && !urlPath.endsWith('/start')) {
    const rows = await supaRest('GET', `attempts?id=eq.${attemptId}&limit=1`);
    const att  = rows[0];
    if (!att) return err(res, 'Attempt not found', 404);
    if (user.role === 'student' && att.user_id !== user.id) return err(res, 'Forbidden', 403);

    // Get test info
    const tests = await supaRest('GET', `tests?id=eq.${att.test_id}&select=title,type,section,topic&limit=1`).catch(() => []);
    const test  = tests[0] || {};

    const qIds = typeof att.question_ids === 'string' ? JSON.parse(att.question_ids) : (att.question_ids || []);
    let questions = [];
    if (qIds.length > 0) {
      questions = await supaRest('GET', `questions?id=in.(${qIds.join(',')})`).catch(() => []);
    }
    const answers = typeof att.answers === 'string' ? JSON.parse(att.answers) : (att.answers || {});
    return ok(res, {
      ...att, answers, question_ids: qIds,
      test_title: test.title || '', test_type: test.type || '',
      questions: questions.map(q => ({
        ...normaliseQuestion(q),
        yourAnswer: answers[q.id] !== undefined ? parseInt(answers[q.id]) : null,
      })),
    });
  }

  // ── GET /api/attempts ─────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (isAdmin(user)) {
      const rows = await supaRest('GET', 'attempts?order=completed_at.desc&limit=500');
      // Enrich with test titles via a second call
      const testIds = [...new Set(rows.map(r => r.test_id).filter(Boolean))];
      let testMap = {};
      if (testIds.length) {
        const tests = await supaRest('GET', `tests?id=in.(${testIds.join(',')})&select=id,title,type`).catch(() => []);
        tests.forEach(t => { testMap[t.id] = t; });
      }
      return ok(res, rows.map(r => ({
        ...r, test_title: testMap[r.test_id]?.title || '', test_type: testMap[r.test_id]?.type || ''
      })));
    }
    // Student — own attempts only
    const rows = await supaRest('GET', `attempts?user_id=eq.${user.id}&order=completed_at.desc`);
    const testIds = [...new Set(rows.map(r => r.test_id).filter(Boolean))];
    let testMap = {};
    if (testIds.length) {
      const tests = await supaRest('GET', `tests?id=in.(${testIds.join(',')})&select=id,title,type,section,topic`).catch(() => []);
      tests.forEach(t => { testMap[t.id] = t; });
    }
    return ok(res, rows.map(r => ({
      ...r, test_title: testMap[r.test_id]?.title || '', test_type: testMap[r.test_id]?.type || '',
      section: testMap[r.test_id]?.section || '', topic: testMap[r.test_id]?.topic || ''
    })));
  }

  // ── POST /api/attempts/start — deduct credits when test begins ────────────
  if (req.method === 'POST' && urlPath.endsWith('/start')) {
    const { testId, attemptToken } = req.body || {};
    if (!testId) return err(res, 'testId required');

    const tests = await supaRest('GET', `tests?id=eq.${testId}&limit=1`);
    const test  = tests[0];
    if (!test)                        return err(res, 'Test not found', 404);
    if (test.status !== 'published')  return err(res, 'Test not published');

    const users = await supaRest('GET', `users?id=eq.${user.id}&limit=1`);
    const cu    = users[0];

    // Check for existing token (resume — already deducted)
    if (attemptToken) {
      const existing = await supaRest('GET',
        `active_attempts?token=eq.${attemptToken}&user_id=eq.${user.id}&test_id=eq.${testId}&limit=1`
      ).catch(() => []);
      if (existing[0]) return ok(res, { resumed: true, credits: cu.credits });
    }

    if (cu.role === 'student' && cu.credits < test.credits) {
      return err(res, `Insufficient credits. Need ${test.credits}, have ${cu.credits}`);
    }

    const today    = new Date().toISOString().split('T')[0];
    const newToken = 'tok_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    // Record active attempt (upsert)
    await supaRest('POST', 'active_attempts',
      { token: newToken, user_id: user.id, test_id: testId }
    ).catch(() => {});

    let newCredits = cu.credits;
    if (cu.role === 'student' && test.credits > 0) {
      newCredits = Math.max(0, cu.credits - test.credits);
      await supaRest('PATCH', `users?id=eq.${user.id}`, { credits: newCredits });
      await supaRest('POST', 'credit_transactions', {
        user_id: user.id, amount: -test.credits, type: 'deduction',
        description: `Test Started: ${test.title}`, date: today,
      }).catch(() => {});
    }

    return ok(res, { token: newToken, credits: newCredits });
  }

  // ── POST /api/attempts — submit test ─────────────────────────────────────
  if (req.method === 'POST') {
    const { testId, answers = {}, timeTaken = 0, questionTimes = {}, attemptToken } = req.body || {};
    if (!testId) return err(res, 'testId required');

    const tests = await supaRest('GET', `tests?id=eq.${testId}&limit=1`);
    const test  = tests[0];
    if (!test)                       return err(res, 'Test not found', 404);
    if (test.status !== 'published') return err(res, 'Test not published');

    const users = await supaRest('GET', `users?id=eq.${user.id}&limit=1`);
    const cu    = users[0];

    // Check if credits already deducted at /start
    let creditAlreadyDeducted = false;
    if (attemptToken) {
      const active = await supaRest('GET',
        `active_attempts?token=eq.${attemptToken}&user_id=eq.${user.id}&test_id=eq.${testId}&limit=1`
      ).catch(() => []);
      if (active[0]) creditAlreadyDeducted = true;
    }

    if (!creditAlreadyDeducted && cu.role === 'student' && cu.credits < test.credits) {
      return err(res, `Insufficient credits. Need ${test.credits}, have ${cu.credits}`);
    }

    // Fetch questions
    const qIds = [
      ...(typeof test.question_ids         === 'string' ? JSON.parse(test.question_ids)         : (test.question_ids         || [])),
      ...(typeof test.assigned_question_ids === 'string' ? JSON.parse(test.assigned_question_ids) : (test.assigned_question_ids || [])),
    ].filter(Boolean);

    let questions = [];
    if (qIds.length > 0) {
      questions = await supaRest('GET', `questions?id=in.(${qIds.join(',')})`).catch(() => []);
    }

    // Score
    const posMarks = parseFloat(test.positive_marks) || 1;
    const negMarks = parseFloat(test.negative_marks) || 0;
    let correct = 0, wrong = 0;
    questions.forEach(q => {
      const ans = answers[q.id];
      if (ans !== undefined) {
        if (parseInt(ans) === q.correct) correct++; else wrong++;
      }
    });
    const total    = questions.length;
    const rawMarks = (correct * posMarks) - (wrong * negMarks);
    const maxMarks = total * posMarks;
    const score    = maxMarks > 0 ? Math.max(0, Math.round((rawMarks / maxMarks) * 100)) : 0;
    const xp       = Math.max(0, Math.round(rawMarks)) * 10;
    const today    = new Date().toISOString().split('T')[0];
    const skipped  = total - correct - wrong;

    // Save attempt
    const saved = await supaRest('POST', 'attempts', {
      user_id: user.id, test_id: testId, score, total_questions: total,
      correct, wrong, skipped, time_taken: timeTaken,
      answers:        JSON.stringify(answers),
      question_times: JSON.stringify(questionTimes),
      question_ids:   JSON.stringify(questions.map(q => q.id)),
      xp_earned: xp, completed_at: today,
    });
    const attId = saved[0]?.id;

    // Deduct credits (only if not done at /start)
    if (!creditAlreadyDeducted && cu.role === 'student' && test.credits > 0) {
      const newCr = Math.max(0, cu.credits - test.credits);
      await supaRest('PATCH', `users?id=eq.${user.id}`, { credits: newCr });
      await supaRest('POST', 'credit_transactions', {
        user_id: user.id, amount: -test.credits, type: 'deduction',
        description: `Test: ${test.title}`, date: today,
      }).catch(() => {});
    }

    // Clean up active attempt token
    if (attemptToken) {
      await supaRest('DELETE', `active_attempts?token=eq.${attemptToken}`).catch(() => {});
    }

    // XP update
    const newXP = (cu.total_xp || 0) + xp;
    await supaRest('PATCH', `users?id=eq.${user.id}`, { total_xp: newXP }).catch(() => {});

    // Update test stats (non-blocking)
    supaRest('GET', `attempts?test_id=eq.${testId}&select=score`).then(rows => {
      if (rows.length) {
        const avg = Math.round(rows.reduce((s, a) => s + a.score, 0) / rows.length);
        supaRest('PATCH', `tests?id=eq.${testId}`, { attempts_count: rows.length, avg_score: avg }).catch(() => {});
      }
    }).catch(() => {});

    return ok(res, {
      id: attId, score, correct, wrong, skipped, totalQuestions: total,
      positiveMarks: posMarks, negativeMarks: negMarks,
      rawMarks: Math.max(0, rawMarks), maxMarks, xpEarned: xp,
      timeTaken, completedAt: today, questionTimes,
      questions: questions.map(q => ({
        ...normaliseQuestion(q),
        yourAnswer: answers[q.id] !== undefined ? parseInt(answers[q.id]) : null,
      })),
    }, 201);
  }

  return err(res, 'Method not allowed', 405);
});
