// api/lib/_api.js — unified Supabase REST helper for all API routes
// Single fetch per call, no pg_query RPC fallback, no double round-trips.

const ENV = () => {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  return { url, key };
};

// ── Core Supabase REST call ───────────────────────────────────────────────────
export async function supaRest(method, path, body = null) {
  const { url, key } = ENV();
  const isWrite = method === 'POST' || method === 'PATCH' || method === 'PUT';
  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST'  ? 'return=representation' :
              method === 'PATCH' ? 'return=representation' :
              method === 'DELETE' ? 'return=minimal' : '',
  };

  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });

  if (method === 'DELETE' && res.status === 204) return [];
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === 'object'
      ? (data.message || data.error || data.hint || JSON.stringify(data))
      : text;
    throw new Error(msg);
  }
  return Array.isArray(data) ? data : (data ? [data] : []);
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
import jwt from 'jsonwebtoken';

export async function requireAuth(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) throw Object.assign(new Error('No token'), { status: 401 });
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET not set');
    const payload = jwt.verify(token, secret);
    return payload;
  } catch (e) {
    throw Object.assign(new Error('Invalid token: ' + e.message), { status: 401 });
  }
}

export function isAdmin(user) {
  return user?.role === 'master' || user?.role === 'admin';
}

// ── Response helpers ──────────────────────────────────────────────────────────
export function ok(res, data, status = 200) {
  res.status(status).json(data);
}

export function err(res, msg, status = 400) {
  res.status(status).json({ error: msg });
}

// ── Route wrapper — catches errors, sets CORS ─────────────────────────────────
export function handler(fn) {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    try {
      await fn(req, res);
    } catch (e) {
      console.error('[api error]', req.url, e.message);
      const status = e.status || 500;
      if (!res.headersSent) res.status(status).json({ error: e.message });
    }
  };
}

// ── Normalise DB rows to frontend shapes ──────────────────────────────────────
const parseJ = (v, fb) => {
  if (v == null) return fb;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fb; } }
  return v;
};

export function normaliseQuestion(q) {
  if (!q) return null;
  // Read from separate columns first; fall back to JSONB options array
  const options = (q.option_a !== undefined)
    ? [q.option_a ?? '', q.option_b ?? '', q.option_c ?? '', q.option_d ?? '']
    : parseJ(q.options, ['', '', '', '']);
  return {
    id: q.id, section: q.section, topic: q.topic, text: q.text,
    options,
    correct:         q.correct,
    difficulty:      q.difficulty   || 'medium',
    idealTime:       q.ideal_time   ?? null,
    image:           q.image        ?? null,
    usedInTopicTest: q.used_in_topic_test || false,
    usedInMockIds:   parseJ(q.used_in_mock_ids, []),
    createdBy:       q.created_by   || null,
  };
}

export function normaliseTest(t) {
  if (!t) return null;
  return {
    id: t.id, title: t.title, description: t.description || '',
    type: t.type, status: t.status || 'published',
    totalQuestions: t.total_questions || 0,
    timeLimit:      t.time_limit      || 30,
    credits:        t.credits         || 0,
    positiveMarks:  parseFloat(t.positive_marks) || 1,
    negativeMarks:  parseFloat(t.negative_marks) || 0,
    section:        t.section  || null,
    topic:          t.topic    || null,
    topics:         parseJ(t.topics, []),
    topicDistribution:   parseJ(t.topic_distribution, {}),
    sections:       parseJ(t.sections, []),
    sectionDistribution: parseJ(t.section_distribution, {}),
    questionIds:         parseJ(t.question_ids, []),
    assignedQuestionIds: parseJ(t.assigned_question_ids, []),
    attempts:       t.attempts_count || 0,
    avgScore:       t.avg_score      || 0,
    createdBy:      t.created_by     || null,
    createdAt:      t.created_at     ? t.created_at.split('T')[0] : '',
  };
}

export function normaliseUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, email: u.email,
    phone:    u.phone    || '',
    role:     u.role     || 'student',
    credits:  u.credits  || 0,
    avatar:   u.avatar   || u.name?.charAt(0).toUpperCase() || 'U',
    joinDate: u.join_date || u.created_at?.split('T')[0] || '',
    status:   u.status   || 'active',
    totalXp:  u.total_xp || 0,
    rank:     u.rank     ?? null,
  };
}

export function normaliseAttempt(a) {
  if (!a) return null;
  return {
    id: a.id, userId: a.user_id, testId: a.test_id,
    testTitle:      a.test_title      || '',
    testType:       a.test_type       || '',
    score:          a.score           || 0,
    totalQuestions: a.total_questions || 0,
    correct:        a.correct         || 0,
    wrong:          a.wrong           ?? null,
    skipped:        a.skipped         ?? null,
    timeTaken:      a.time_taken      || 0,
    answers:        parseJ(a.answers, {}),
    questionTimes:  parseJ(a.question_times, {}),
    questionIds:    parseJ(a.question_ids, []),
    xpEarned:       a.xp_earned       || 0,
    completedAt:    a.completed_at    || '',
  };
}
