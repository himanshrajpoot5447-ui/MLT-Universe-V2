// api/lib/db.js — Supabase via direct postgres driver
// Requires: SUPABASE_DB_URL  (Transaction Pooler URI from Supabase dashboard)
//           SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (for Supabase Auth + client)
//
// HOW TO GET SUPABASE_DB_URL:
//   Supabase Dashboard → Project Settings → Database
//   → Connection string → "Transaction pooler" tab
//   → copy URI  (postgresql://postgres.[ref]:[password]@[host]:6543/postgres)

import postgres   from 'postgres';
import { createClient } from '@supabase/supabase-js';

// ── Supabase JS client (for Auth sign-in) ────────────────────────────────────
let _supabase = null;
export function getDb() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set'
    );
    _supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _supabase;
}

// ── Direct Postgres driver (Transaction Pooler) ───────────────────────────────
let _pg = null;
function getPg() {
  if (_pg) return _pg;
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!url) throw new Error(
    '❌ SUPABASE_DB_URL is not set.\n' +
    'Go to: Supabase → Project Settings → Database → Connection string → Transaction pooler\n' +
    'Copy the URI and add it as SUPABASE_DB_URL in Vercel Environment Variables, then redeploy.'
  );
  _pg = postgres(url, {
    max:             1,     // serverless — one connection per function instance
    idle_timeout:    20,
    connect_timeout: 10,
    ssl:             'require',
    prepare:         false, // Transaction Pooler doesn't support prepared statements
  });
  return _pg;
}

// ── Public helpers ─────────────────────────────────────────────────────────────
export async function query(text, params = []) {
  const sql = getPg();
  try {
    // postgres.js uses tagged template, but unsafe() accepts string + array
    const rows = await sql.unsafe(text, params);
    // postgres.js returns a Result object — spread to plain array
    return Array.isArray(rows) ? [...rows] : [];
  } catch (e) {
    // Re-throw with context so Vercel logs are readable
    const msg = e.message || String(e);
    console.error('[db] Query error:', msg, '\nSQL:', text.slice(0, 120));
    throw Object.assign(new Error(msg), { code: e.code });
  }
}

export async function queryOne(text, params = []) {
  const rows = await query(text, params);
  return rows[0] ?? null;
}
