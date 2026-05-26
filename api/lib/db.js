// api/lib/db.js — Supabase via @neondatabase/serverless driver
// @neondatabase/serverless works with ANY PostgreSQL URL including Supabase.
//
// REQUIRED ENV VARS (Vercel → Project Settings → Environment Variables):
//
//  SUPABASE_DB_URL  ← Supabase → Settings → Database
//                     → Connection string → "Transaction pooler" tab
//                     → copy full URI, replace [YOUR-PASSWORD]
//                     e.g. postgresql://postgres.abc123:MyPass@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
//
//  SUPABASE_URL     ← Supabase → Settings → API → Project URL
//  SUPABASE_SERVICE_ROLE_KEY ← Supabase → Settings → API Keys → Secret key
//  JWT_SECRET       ← Supabase → Settings → JWT Keys → JWT Secret

import { neon } from '@neondatabase/serverless';
import { createClient } from '@supabase/supabase-js';

// ── Supabase JS client (used only for Auth sign-in) ───────────────────────────
let _supabase = null;
export function getDb() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error(
      'Missing: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Vercel'
    );
    _supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _supabase;
}

// ── Neon serverless driver → Supabase Transaction Pooler ──────────────────────
let _sql = null;
function getSql() {
  if (_sql) return _sql;
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!url) throw new Error(
    '❌ SUPABASE_DB_URL is not set in Vercel Environment Variables.\n' +
    'Get it from: Supabase → Settings → Database → Connection string → Transaction pooler\n' +
    'Replace [YOUR-PASSWORD] with your actual DB password, then redeploy.'
  );
  _sql = neon(url);
  return _sql;
}

// ── query() — main helper used by all API routes ──────────────────────────────
// The @neondatabase/serverless neon() function is called as:
//   sql`SELECT * FROM t WHERE id = ${val}`   ← tagged template (safe)
//   sql(text, params)                         ← parameterised string
//
// We use the parameterised form: neon(url)(sqlText, paramsArray)
// This is the correct way per the Neon docs for dynamic queries.

export async function query(text, params = []) {
  const sql = getSql();
  try {
    // neon() called as a function with (string, array) executes parameterised SQL.
    // Each element of params must be a scalar (string, number, boolean, null).
    // Stringify any objects/arrays so PostgreSQL receives them as text/jsonb.
    const safeParams = params.map(p => {
      if (p === null || p === undefined) return null;
      if (typeof p === 'object') return JSON.stringify(p);
      return p;
    });
    const rows = await sql(text, safeParams);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.error('[db] Error:', e.message, '\nSQL:', text.slice(0, 150), '\nParams:', JSON.stringify(params).slice(0, 100));
    throw e;
  }
}

export async function queryOne(text, params = []) {
  const rows = await query(text, params);
  return rows[0] ?? null;
}
