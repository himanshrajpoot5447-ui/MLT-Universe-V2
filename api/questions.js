// api/questions.js — handles GET/POST/PUT/DELETE for questions
// Options are stored in separate columns (option_a, option_b, option_c, option_d)
// and also kept in sync with the legacy JSONB `options` column via a DB trigger.
import { query, queryOne } from './lib/db.js';
import { requireAuth, isAdmin } from './lib/auth.js';
import { handler, ok, err, normaliseQuestion } from './lib/helpers.js';

// Build option columns object from an array of 4 options
function optionCols(opts) {
  const o = Array.isArray(opts) ? opts : [];
  return {
    option_a: (o[0] ?? '').toString(),
    option_b: (o[1] ?? '').toString(),
    option_c: (o[2] ?? '').toString(),
    option_d: (o[3] ?? '').toString(),
  };
}

export default handler(async (req, res) => {
  const user = await requireAuth(req);
  const rawUrl  = req.url || '';
  const urlPath = rawUrl.split('?')[0].replace(/\/$/, '');
  const qsRaw   = rawUrl.includes('?') ? rawUrl.split('?')[1] : '';
  const qs      = Object.fromEntries(new URLSearchParams(qsRaw));

  // Detect :id from req.query or last URL segment
  let id = req.query?.id || null;
  if (!id) {
    const segments = urlPath.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last !== 'questions' && last !== 'api') id = last;
  }

  // ── /api/questions/:id ──────────────────────────────────────────────────────
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

      const sets = []; const params = []; let i = 1;
      if (text      !== undefined) { sets.push(`text=$${i++}`);        params.push(text); }
      if (correct   !== undefined) { sets.push(`correct=$${i++}`);     params.push(correct); }
      if (difficulty !== undefined) { sets.push(`difficulty=$${i++}`); params.push(difficulty); }
      if (idealTime !== undefined) { sets.push(`ideal_time=$${i++}`);  params.push(idealTime); }
      if (image     !== undefined) { sets.push(`image=$${i++}`);       params.push(image); }
      if (section   !== undefined) { sets.push(`section=$${i++}`);     params.push(section); }
      if (topic     !== undefined) { sets.push(`topic=$${i++}`);       params.push(topic); }

      // Handle options — write to both separate columns AND legacy JSONB
      if (options !== undefined) {
        const cols = optionCols(options);
        sets.push(`option_a=$${i++}`); params.push(cols.option_a);
        sets.push(`option_b=$${i++}`); params.push(cols.option_b);
        sets.push(`option_c=$${i++}`); params.push(cols.option_c);
        sets.push(`option_d=$${i++}`); params.push(cols.option_d);
        sets.push(`options=$${i++}`);  params.push(JSON.stringify(options));
      }

      sets.push(`updated_at=NOW()`);
      if (!sets.length || (sets.length === 1 && sets[0] === 'updated_at=NOW()')) {
        return err(res, 'Nothing to update');
      }
      params.push(id);
      const [updated] = await query(
        `UPDATE questions SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, params
      );
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

  // ── /api/questions ──────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { section, topic } = qs;
    let sql = 'SELECT * FROM questions WHERE 1=1';
    const params = []; let i = 1;
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
        usedInTopicTest = false, usedInMockIds = [],
      } = q;
      if (!section || !topic || !text || !options || correct === undefined) {
        console.warn('Skipping invalid question:', { section, topic, hasText: !!text, correct });
        continue;
      }
      const cols = optionCols(options);
      let row;
      try {
        [row] = await query(
          `INSERT INTO questions
             (section, topic, text, option_a, option_b, option_c, option_d, options,
              correct, difficulty, ideal_time, image, used_in_topic_test, used_in_mock_ids, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [
            section, topic, text,
            cols.option_a, cols.option_b, cols.option_c, cols.option_d,
            JSON.stringify(options),
            correct, difficulty, idealTime, image,
            usedInTopicTest, JSON.stringify(usedInMockIds),
            user.id,
          ]
        );
      } catch (dbErr) {
        // Fallback if option_a…d columns don't exist yet (pre-migration)
        if (dbErr.message?.includes('option_a') || dbErr.message?.includes('column')) {
          try {
            [row] = await query(
              `INSERT INTO questions
                 (section, topic, text, options, correct, difficulty, ideal_time, image,
                  used_in_topic_test, used_in_mock_ids, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
              [section, topic, text, JSON.stringify(options), correct, difficulty,
               idealTime, image, usedInTopicTest, JSON.stringify(usedInMockIds), user.id]
            );
          } catch(e2) { console.error('Question insert failed:', e2.message); continue; }
        } else {
          console.error('Question insert failed:', dbErr.message); continue;
        }
      }
      if (row) created.push(normaliseQuestion(row));
    }

    if (!created.length) {
      return err(res, 'No valid questions were saved — check all questions have text, options, and a correct answer');
    }
    return ok(res, created, 201);
  }

  return err(res, 'Method not allowed', 405);
});
