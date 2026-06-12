// api/questions.js — direct Supabase REST API (no pg_query RPC, no options column)
import { supaRest, requireAuth, isAdmin, ok, err, handler, normaliseQuestion } from './lib/_api.js';

export default handler(async (req, res) => {
  const user = await requireAuth(req);

  // Extract optional :id from URL
  const segments = (req.url || '').split('?')[0].split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  const id = (last && last !== 'questions') ? last : (req.query?.id || null);

  // ── /api/questions/:id ────────────────────────────────────────────────────
  if (id) {
    if (req.method === 'GET') {
      const rows = await supaRest('GET', `questions?id=eq.${id}&limit=1`);
      if (!rows.length) return err(res, 'Question not found', 404);
      return ok(res, normaliseQuestion(rows[0]));
    }

    if (req.method === 'PUT') {
      if (!isAdmin(user)) return err(res, 'Forbidden', 403);
      const { text, options, correct, difficulty, idealTime, image, section, topic } = req.body || {};
      const patch = {};
      if (text       !== undefined) patch.text        = text;
      if (correct    !== undefined) patch.correct      = correct;
      if (difficulty !== undefined) patch.difficulty   = difficulty;
      if (idealTime  !== undefined) patch.ideal_time   = idealTime;
      if (image      !== undefined) patch.image        = image;
      if (section    !== undefined) patch.section      = section;
      if (topic      !== undefined) patch.topic        = topic;
      if (options    !== undefined) {
        const o = Array.isArray(options) ? options : [];
        patch.option_a = String(o[0] ?? '');
        patch.option_b = String(o[1] ?? '');
        patch.option_c = String(o[2] ?? '');
        patch.option_d = String(o[3] ?? '');
      }
      if (!Object.keys(patch).length) return err(res, 'Nothing to update');
      const rows = await supaRest('PATCH', `questions?id=eq.${id}`, patch);
      return ok(res, normaliseQuestion(rows[0] || { id, ...patch }));
    }

    if (req.method === 'DELETE') {
      if (!isAdmin(user)) return err(res, 'Forbidden', 403);
      await supaRest('DELETE', `questions?id=eq.${id}`);
      return ok(res, { deleted: true });
    }

    return err(res, 'Method not allowed', 405);
  }

  // ── /api/questions ────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
    let path = 'questions?order=section.asc,topic.asc,created_at.asc';
    if (qs.get('section')) path += `&section=eq.${encodeURIComponent(qs.get('section'))}`;
    if (qs.get('topic'))   path += `&topic=eq.${encodeURIComponent(qs.get('topic'))}`;
    const rows = await supaRest('GET', path);
    return ok(res, rows.map(normaliseQuestion));
  }

  if (req.method === 'POST') {
    if (!isAdmin(user)) return err(res, 'Forbidden', 403);
    const list = Array.isArray(req.body) ? req.body : [req.body];
    if (!list.length) return err(res, 'No questions provided');

    const toInsert = [];
    for (const q of list) {
      const { section, topic, text, options, correct,
              difficulty = 'medium', idealTime = null, image = null,
              usedInTopicTest = false, usedInMockIds = [] } = q || {};
      if (!section || !topic || !text || correct === undefined) {
        console.warn('[questions] Skipping invalid:', { section, topic, hasText: !!text, correct });
        continue;
      }
      const o = Array.isArray(options) ? options : [];
      toInsert.push({
        section, topic, text,
        option_a: String(o[0] ?? ''),
        option_b: String(o[1] ?? ''),
        option_c: String(o[2] ?? ''),
        option_d: String(o[3] ?? ''),
        correct: Number(correct),
        difficulty,
        ideal_time: idealTime,
        image,
        used_in_topic_test: usedInTopicTest,
        used_in_mock_ids: JSON.stringify(usedInMockIds),
        created_by: user.id,
      });
    }

    if (!toInsert.length) return err(res, 'No valid questions to save');

    // Insert all at once — single round-trip
    const created = await supaRest('POST', 'questions', toInsert);
    return ok(res, (Array.isArray(created) ? created : [created]).map(normaliseQuestion), 201);
  }

  return err(res, 'Method not allowed', 405);
});
