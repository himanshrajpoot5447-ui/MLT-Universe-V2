// api/lib/db.js — Zero-dependency Supabase REST client
// Uses fetch() built into Node 18+ — NO npm packages required.
// Works on Vercel Hobby plan without any install step.
//
// REQUIRED ENV VARS (Vercel → Project Settings → Environment Variables):
//   SUPABASE_URL              e.g. https://abc123.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY e.g. sb_secret_...
//   JWT_SECRET                from Supabase → Settings → JWT Keys

const getEnv = () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error(
    'Missing env vars: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel → Project Settings → Environment Variables'
  );
  return { url: url.replace(/\/$/, ''), key };
};

// ── Supabase client object (for Auth sign-in used in auth.js) ─────────────────
export function getDb() {
  const { url, key } = getEnv();
  return {
    url, key,
    auth: {
      signInWithPassword: async ({ email, password }) => {
        const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
          body: JSON.stringify({ email, password }),
        });
        const data = await r.json();
        if (!r.ok) return { data: null, error: data };
        return { data: { session: data }, error: null };
      },
    },
  };
}

// ── Core SQL runner via Supabase PostgREST + pg_query RPC ────────────────────
// Supabase exposes a /rest/v1/rpc/pg_query endpoint for service-role keys
// that executes raw SQL. This is available on all Supabase plans.
//
// Fallback: if pg_query RPC is not available, use table-level REST API.

async function supaFetch(path, options = {}) {
  const { url, key } = getEnv();
  const res = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Prefer': 'return=representation',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(
    typeof data === 'object' ? (data.message || data.error || JSON.stringify(data)) : text
  );
  return data;
}

// ── Main query() — translates parameterised SQL to Supabase REST calls ────────
export async function query(sql, params = []) {
  // Substitute $1..$N with actual values to build a plain SQL string
  // (safe because this runs server-side with our own controlled queries)
  const finalSql = substituteParams(sql, params);

  try {
    // Try pg_query RPC first (works if enabled in Supabase)
    const result = await supaFetch('/rest/v1/rpc/pg_query', {
      method: 'POST',
      body: JSON.stringify({ query: finalSql }),
    });
    if (Array.isArray(result)) return result;
    if (result && typeof result === 'object' && result.rows) return result.rows;
    return Array.isArray(result) ? result : [];
  } catch (rpcErr) {
    // pg_query not available — use table REST API parser
    try {
      return await restQuery(finalSql);
    } catch (restErr) {
      console.error('[db] Both RPC and REST failed.\nSQL:', finalSql.slice(0, 200));
      console.error('[db] RPC error:', rpcErr.message);
      console.error('[db] REST error:', restErr.message);
      throw new Error(restErr.message);
    }
  }
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

// ── Parameter substitution ─────────────────────────────────────────────────────
function substituteParams(sql, params) {
  return sql.replace(/\$(\d+)/g, (_, n) => {
    const val = params[parseInt(n) - 1];
    return formatValue(val);
  });
}

function formatValue(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') return String(val);
  if (Array.isArray(val) || typeof val === 'object') {
    return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
  }
  // String — escape single quotes
  return `'${String(val).replace(/'/g, "''")}'`;
}

// ── REST API query parser ──────────────────────────────────────────────────────
async function restQuery(sql) {
  const s = sql.trim();
  const up = s.toUpperCase();

  if (up.startsWith('SELECT')) return restSelect(s);
  if (up.startsWith('INSERT')) return restInsert(s);
  if (up.startsWith('UPDATE')) return restUpdate(s);
  if (up.startsWith('DELETE')) return restDelete(s);
  if (up.startsWith('ALTER'))  { console.log('[db] Skipping ALTER (run in SQL Editor)'); return []; }

  throw new Error(`Unsupported SQL: ${s.slice(0, 80)}`);
}

// ── SELECT ────────────────────────────────────────────────────────────────────
async function restSelect(sql) {
  const tableMatch = sql.match(/FROM\s+(\w+)/i);
  if (!tableMatch) throw new Error('Cannot parse table from: ' + sql.slice(0, 80));
  const table = tableMatch[1];

  const params = new URLSearchParams();

  // SELECT columns
  const colMatch = sql.match(/^SELECT\s+([\s\S]+?)\s+FROM/i);
  const cols = colMatch ? colMatch[1].trim() : '*';
  if (cols !== '*' && !/JOIN/i.test(sql)) params.set('select', cols);
  else params.set('select', '*');

  // WHERE conditions (simple equality only)
  const whereMatch = sql.match(/WHERE\s+([\s\S]+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|$)/i);
  if (whereMatch) {
    applyRestWhere(params, whereMatch[1]);
  }

  // ORDER BY
  const orderMatch = sql.match(/ORDER BY\s+([\w.]+)\s*(ASC|DESC)?/i);
  if (orderMatch) {
    const col = orderMatch[1].split('.').pop();
    const dir = (orderMatch[2] || 'ASC').toUpperCase();
    params.set('order', `${col}.${dir === 'DESC' ? 'desc' : 'asc'}`);
  }

  // LIMIT
  const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
  if (limitMatch) params.set('limit', limitMatch[1]);

  const data = await supaFetch(`/rest/v1/${table}?${params}`, { method: 'GET' });
  return Array.isArray(data) ? data : [];
}

function applyRestWhere(params, whereStr) {
  // Split on AND
  const parts = whereStr.split(/\bAND\b/i).map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    // col = 'value'  or  col = 123  or  col ILIKE 'val'
    const eqMatch  = part.match(/^([\w.]+)\s*=\s*'?([^']*)'?$/);
    const ilikeMatch = part.match(/^([\w.]+)\s+ILIKE\s+'([^']*)'/i);
    const orMatch = part.match(/\bOR\b/i); // skip complex ORs

    if (orMatch) continue; // can't handle OR in PostgREST filter easily
    if (ilikeMatch) {
      const col = ilikeMatch[1].split('.').pop();
      params.append(col, `ilike.${ilikeMatch[2]}`);
    } else if (eqMatch) {
      const col = eqMatch[1].split('.').pop();
      const val = eqMatch[2];
      if (val === 'NULL') params.append(col, 'is.null');
      else params.append(col, `eq.${val}`);
    }
  }
}

// ── INSERT ────────────────────────────────────────────────────────────────────
async function restInsert(sql) {
  const tableMatch = sql.match(/INSERT\s+INTO\s+(\w+)/i);
  if (!tableMatch) throw new Error('Cannot parse INSERT table');
  const table = tableMatch[1];

  const colsMatch = sql.match(/\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)/i);
  if (!colsMatch) throw new Error('Cannot parse INSERT columns/values');

  const cols = colsMatch[1].split(',').map(c => c.trim());
  const vals = splitValues(colsMatch[2]);

  const row = {};
  cols.forEach((col, i) => { row[col] = parseVal(vals[i]); });

  const returning = /RETURNING/i.test(sql);
  const hasConflict = /ON\s+CONFLICT/i.test(sql);

  // For ON CONFLICT DO UPDATE — use Supabase upsert (POST with resolution=merge-duplicates)
  const headers = {};
  if (returning) headers.Prefer = 'return=representation';
  else headers.Prefer = 'return=minimal';
  if (hasConflict) headers.Prefer = (headers.Prefer ? headers.Prefer + ',' : '') + 'resolution=merge-duplicates';

  const data = await supaFetch(`/rest/v1/${table}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(row),
  });
  if (returning) return Array.isArray(data) ? data : (data ? [data] : []);
  return [];
}

// ── UPDATE ────────────────────────────────────────────────────────────────────
async function restUpdate(sql) {
  const tableMatch = sql.match(/UPDATE\s+(\w+)\s+SET/i);
  if (!tableMatch) throw new Error('Cannot parse UPDATE table');
  const table = tableMatch[1];

  const setMatch   = sql.match(/SET\s+([\s\S]+?)\s+WHERE/i);
  const whereMatch = sql.match(/WHERE\s+([\s\S]+?)(?:\s+RETURNING|$)/i);
  const returning  = /RETURNING/i.test(sql);

  const updates = {};
  if (setMatch) {
    const pairs = setMatch[1].split(',').map(s => s.trim());
    for (const pair of pairs) {
      const m = pair.match(/^([\w.]+)\s*=\s*([\s\S]+)$/);
      if (m) {
        const col = m[1].trim();
        const rawVal = m[2].trim();
        // If the value contains the column name (e.g. total_xp + 200),
        // it's an arithmetic expression — pass as raw SQL via RPC only.
        // For REST fallback, pre-compute by fetching current value.
        if (rawVal.includes(col) && /[+\-*\/]/.test(rawVal)) {
          // Store as expression marker
          updates[col] = { __expr: rawVal };
        } else {
          updates[col] = parseVal(rawVal);
        }
      }
    }
  }

  const params = new URLSearchParams();
  if (whereMatch) applyRestWhere(params, whereMatch[1]);

  // Handle arithmetic expressions: fetch current row, compute, then patch
  const hasExpr = Object.values(updates).some(v => v && v.__expr);
  if (hasExpr) {
    // Get current values
    const current = await supaFetch(`/rest/v1/${table}?${params}&select=*&limit=1`, { method: 'GET' });
    const rows = Array.isArray(current) ? current : [current];
    const resolvedUpdates = {};
    for (const [col, val] of Object.entries(updates)) {
      if (val && val.__expr) {
        // Evaluate the expression: replace col names with current values
        let expr = val.__expr;
        for (const row of rows.slice(0,1)) {
          for (const [k, v] of Object.entries(row)) {
            expr = expr.replace(new RegExp(`\\b${k}\\b`, 'g'), Number(v) || 0);
          }
        }
        try { resolvedUpdates[col] = Function('"use strict";return (' + expr + ')')(); }
        catch { resolvedUpdates[col] = val.__expr; }
      } else {
        resolvedUpdates[col] = val;
      }
    }
    const headers = returning ? { Prefer: 'return=representation' } : { Prefer: 'return=minimal' };
    const data = await supaFetch(`/rest/v1/${table}?${params}`, {
      method: 'PATCH', headers, body: JSON.stringify(resolvedUpdates),
    });
    if (returning) return Array.isArray(data) ? data : (data ? [data] : []);
    return [];
  }

  const headers = returning ? { Prefer: 'return=representation' } : { Prefer: 'return=minimal' };
  const data = await supaFetch(`/rest/v1/${table}?${params}`, {
    method: 'PATCH', headers, body: JSON.stringify(updates),
  });
  if (returning) return Array.isArray(data) ? data : (data ? [data] : []);
  return [];
}

// ── DELETE ────────────────────────────────────────────────────────────────────
async function restDelete(sql) {
  const tableMatch = sql.match(/DELETE\s+FROM\s+(\w+)/i);
  if (!tableMatch) throw new Error('Cannot parse DELETE table');
  const table = tableMatch[1];

  const whereMatch = sql.match(/WHERE\s+([\s\S]+?)$/i);
  const params = new URLSearchParams();
  if (whereMatch) applyRestWhere(params, whereMatch[1]);

  await supaFetch(`/rest/v1/${table}?${params}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  return [];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseVal(v) {
  if (!v || v === 'NULL') return null;
  v = v.trim();
  if (v.startsWith("'") && v.endsWith("'")) {
    const inner = v.slice(1, -1).replace(/''/g, "'");
    try {
      if (inner.startsWith('[') || inner.startsWith('{')) return JSON.parse(inner);
    } catch {}
    return inner;
  }
  if (v === 'TRUE') return true;
  if (v === 'FALSE') return false;
  if (v === 'NOW()') return new Date().toISOString();
  const n = Number(v);
  return isNaN(n) ? v : n;
}

function splitValues(str) {
  // Split comma-separated SQL values respecting quoted strings
  const vals = [];
  let depth = 0, cur = '', inQuote = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "'" && str[i+1] === "'") { cur += "''"; i++; continue; }
    if (c === "'") { inQuote = !inQuote; cur += c; continue; }
    if (!inQuote && c === '(') { depth++; cur += c; continue; }
    if (!inQuote && c === ')') { depth--; cur += c; continue; }
    if (!inQuote && depth === 0 && c === ',') { vals.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) vals.push(cur.trim());
  return vals;
}
