// lib/db.js — Supabase PostgreSQL connection (shared root lib)
import { createClient } from '@supabase/supabase-js';

let _supabase = null;

export function getDb() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables must be set');
    }
    _supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'public' },
    });
  }
  return _supabase;
}

// Helper: run a raw SQL query and return rows
export async function query(text, params = []) {
  const db = getDb();
  const { data, error } = await db.rpc('exec_sql', { sql: text, params });
  if (error) throw new Error(`Query error: ${error.message}\nSQL: ${text}`);
  return Array.isArray(data) ? data : (data ? [data] : []);
}

// Helper: run query and return first row or null
export async function queryOne(text, params = []) {
  const rows = await query(text, params);
  return rows[0] || null;
}
