// lib/helpers.js — Response helpers for Vercel API routes

export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

export function ok(res, data, status = 200) {
  res.status(status).json(data);
}

export function err(res, message, status = 400) {
  res.status(status).json({ error: message });
}

export function handleError(res, e) {
  console.error('API Error:', e);
  if (e && e.status) return err(res, e.message, e.status);
  err(res, 'Internal server error', 500);
}

// Wrap a handler with CORS + error handling
export function handler(fn) {
  return async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    try {
      await fn(req, res);
    } catch (e) {
      handleError(res, e);
    }
  };
}

export function safeUser(user) {
  if (!user) return null;
  const {
    password,           // strip this
    password_hash,      // strip this too if present
    ...rest
  } = user;

  return {
    // Raw DB fields (snake_case) - frontend reads these directly in doLogin
    id:           rest.id,
    name:         rest.name,
    email:        rest.email,
    phone:        rest.phone         ?? '',
    role:         rest.role,
    credits:      rest.credits       ?? 0,
    avatar:       rest.avatar        ?? rest.name?.slice(0,2)?.toUpperCase() ?? 'U',
    status:       rest.status        ?? 'active',
    total_xp:     rest.total_xp      ?? 0,
    rank:         rest.rank          ?? null,
    join_date:    rest.join_date     ?? rest.created_at?.split('T')[0] ?? new Date().toISOString().split('T')[0],
    created_at:   rest.created_at,
    updated_at:   rest.updated_at,
    // Also expose camelCase aliases so any future direct reads work
    totalXP:      rest.total_xp      ?? 0,
    joinDate:     rest.join_date     ?? rest.created_at?.split('T')[0] ?? new Date().toISOString().split('T')[0],
  };
}


// Map test DB row to frontend format
export function normaliseTest(t) {
  if (!t) return null;
  return {
    id: t.id,
    title: t.title,
    description: t.description || '',
    type: t.type,
    status: t.status,
    totalQuestions: t.total_questions,
    timeLimit: t.time_limit,
    credits: t.credits,
    positiveMarks: parseFloat(t.positive_marks) || 1,
    negativeMarks: parseFloat(t.negative_marks) || 0,
    section: t.section,
    topic: t.topic,
    topics: t.topics || [],
    topicDistribution: t.topic_distribution || {},
    sections: t.sections || [],
    sectionDistribution: t.section_distribution || {},
    questionIds: t.question_ids || [],
    assignedQuestionIds: t.assigned_question_ids || [],
    attempts: t.attempts_count || 0,
    avgScore: t.avg_score || 0,
    createdBy: t.created_by,
    createdAt: t.created_at,
  };
}

// Map question DB row to frontend format
export function normaliseQuestion(q) {
  if (!q) return null;
  // Supabase may return JSONB fields as strings or objects depending on driver
  const parseJ = (v, fallback) => {
    if (v === null || v === undefined) return fallback;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
    return v;
  };
  return {
    id:              q.id,
    section:         q.section,
    topic:           q.topic,
    text:            q.text,
    options:         parseJ(q.options, []),
    correct:         q.correct,
    difficulty:      q.difficulty   || 'medium',
    idealTime:       q.ideal_time   ?? null,
    image:           q.image        ?? null,
    usedInTopicTest: q.used_in_topic_test || false,
    usedInMockIds:   parseJ(q.used_in_mock_ids, []),
    createdBy:       q.created_by   || null,
  };
}
