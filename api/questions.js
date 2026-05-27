// api/questions.js — handles GET/POST /api/questions and GET/PUT/DELETE /api/questions/:id
import { query, queryOne } from './lib/db.js';
import { requireAuth, isAdmin } from './lib/auth.js';
import { handler, ok, err, normaliseQuestion } from './lib/helpers.js';

export default handler(async (req, res) => {
  const user = await requireAuth(req);
  // On Vercel, req.url is relative to the function — id comes via req.query or URL path
  const rawUrl = req.url || '';
  const urlPath = rawUrl.split('?')[0].replace(/\/$/, '');
  const qsRaw = rawUrl.includes('?') ? rawUrl.split('?')[1] : '';
  const qs = Object.fromEntries(new URLSearchParams(qsRaw));
  
  // Detect :id — Vercel puts it in req.query.id OR it's the last path segment
  let id = req.query?.id || null;
  if (!id) {
    const segments = urlPath.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last !== 'questions' && last !== 'api') id = last;
  }

  // ── /api/questions/:id ────────────────────────────────────────────────────
  if (id) {
    if (req.method === 'GET') {
      const q = await queryOne('SELECT * FROM questions WHERE id=$1', [id]);
      if (!q) return err(res, 'Question not found', 404);
      return ok(res, normaliseQuestion(q));
    }

    if (req.method === 'PUT') {
      if (!isAdmin(user)) return err(res, 'Admin access required', 403);
      const q = await queryOne('SELECT * FROM questions WHERE id=$1', [id]);
      if (!q) return err(res, 'Question not found', 404);
      const { text, options, correct, difficulty, idealTime, image, section, topic } = req.body || {};
      const sets=[]; const params=[]; let i=1;
      if (text)      { sets.push(`text=$${i++}`);        params.push(text); }
      if (options)   { sets.push(`options=$${i++}`);     params.push(JSON.stringify(options)); }
      if (correct!==undefined) { sets.push(`correct=$${i++}`); params.push(correct); }
      if (difficulty){ sets.push(`difficulty=$${i++}`);  params.push(difficulty); }
      if (idealTime!==undefined) { sets.push(`ideal_time=$${i++}`); params.push(idealTime); }
      if (image!==undefined)     { sets.push(`image=$${i++}`);      params.push(image); }
      if (section)   { sets.push(`section=$${i++}`);     params.push(section); }
      if (topic)     { sets.push(`topic=$${i++}`);       params.push(topic); }
      if (!sets.length) return err(res, 'Nothing to update');
      params.push(id);
      const [updated] = await query(`UPDATE questions SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, params);
      return ok(res, normaliseQuestion(updated));
    }

    if (req.method === 'DELETE') {
      if (!isAdmin(user)) return err(res, 'Admin access required', 403);
      const q = await queryOne('SELECT id FROM questions WHERE id=$1', [id]);
      if (!q) return err(res, 'Question not found', 404);
      await query('DELETE FROM questions WHERE id=$1', [id]);
      return ok(res, { message: 'Deleted' });
    }

    return err(res, 'Method not allowed', 405);
  }

  // ── /api/questions ────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { section, topic } = qs;
    let sql = 'SELECT * FROM questions WHERE 1=1';
    const params=[]; let i=1;
    if (section) { sql += ` AND section=$${i++}`; params.push(section); }
    if (topic)   { sql += ` AND topic=$${i++}`;   params.push(topic); }
    sql += ' ORDER BY section, topic, created_at';
    const rows = await query(sql, params);
    return ok(res, rows.map(normaliseQuestion));
  }

  if (req.method === 'POST') {
    if (!isAdmin(user)) return err(res, 'Admin access required', 403);
    const body = req.body;
    const list = Array.isArray(body) ? body : [body];
    if (!list.length) return err(res, 'No questions provided');
    const created = [];
    for (const q of list) {
      const {
        section, topic, text, options, correct,
        difficulty = 'medium', idealTime = null, image = null,
        usedInTopicTest = false, usedInMockIds = []
      } = q;
      if (!section || !topic || !text || !options || correct === undefined) {
        console.warn('Skipping invalid question — missing required fields:', { section, topic, text: !!text, options: !!options, correct });
        continue;
      }
      let row;
      try {
        [row] = await query(
          `INSERT INTO questions (section,topic,text,options,correct,difficulty,ideal_time,image,used_in_topic_test,used_in_mock_ids,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [section, topic, text, JSON.stringify(options), correct, difficulty, idealTime, image, usedInTopicTest, JSON.stringify(usedInMockIds), user.id]
        );
      } catch (dbErr) {
        // If used_in_mock_ids column doesn't exist, retry without it
        if (dbErr.message?.includes('used_in_mock_ids')) {
          [row] = await query(
            `INSERT INTO questions (section,topic,text,options,correct,difficulty,ideal_time,image,used_in_topic_test,created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [section, topic, text, JSON.stringify(options), correct, difficulty, idealTime, image, usedInTopicTest, user.id]
          );
        } else {
          throw dbErr;
        }
      }
      if (row) created.push(normaliseQuestion(row));
    }
    if (created.length === 0) return err(res, 'No valid questions were saved — check that all questions have text, options, and a correct answer selected');
    return ok(res, created, 201);
  }

  err(res, 'Method not allowed', 405);
});
