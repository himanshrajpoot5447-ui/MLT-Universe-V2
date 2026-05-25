-- ═══════════════════════════════════════════════════════════════════════════════
-- MLT Universe — Supabase PostgreSQL Schema
-- Run this in Supabase SQL Editor: Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Helper: exec_sql RPC (used by Supabase JS client for raw queries) ────────
-- This function lets the service-role key run parameterised SQL via supabase.rpc()
CREATE OR REPLACE FUNCTION exec_sql(sql text, params text[] DEFAULT '{}')
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result json;
BEGIN
  EXECUTE sql INTO result USING params;
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$;

-- A more robust version that returns SETOF json for SELECT queries
CREATE OR REPLACE FUNCTION exec_sql_rows(sql text, params text[] DEFAULT '{}')
RETURNS SETOF json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY EXECUTE sql USING params;
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$;

-- ─── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT NOT NULL DEFAULT '',
  password      TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('master','admin','student')),
  credits       INTEGER NOT NULL DEFAULT 0,
  avatar        TEXT NOT NULL DEFAULT 'U',
  join_date     TEXT NOT NULL DEFAULT TO_CHAR(NOW(),'YYYY-MM-DD'),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  total_xp      INTEGER NOT NULL DEFAULT 0,
  rank          INTEGER DEFAULT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';

-- ─── Sections ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sections (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name          TEXT NOT NULL UNIQUE,
  is_builtin    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Questions ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS questions (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  section              TEXT NOT NULL,
  topic                TEXT NOT NULL,
  text                 TEXT NOT NULL,
  options              JSONB NOT NULL DEFAULT '[]',
  correct              INTEGER NOT NULL CHECK (correct BETWEEN 0 AND 3),
  difficulty           TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  ideal_time           INTEGER DEFAULT NULL,
  image                TEXT DEFAULT NULL,
  used_in_topic_test   BOOLEAN NOT NULL DEFAULT FALSE,
  used_in_mock_ids     JSONB NOT NULL DEFAULT '[]',
  created_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Tests ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tests (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  title                 TEXT NOT NULL,
  description           TEXT DEFAULT '',
  type                  TEXT NOT NULL CHECK (type IN ('topic','section','complete')),
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  total_questions       INTEGER NOT NULL DEFAULT 0,
  time_limit            INTEGER NOT NULL DEFAULT 30,
  credits               INTEGER NOT NULL DEFAULT 0,
  positive_marks        NUMERIC(5,2) NOT NULL DEFAULT 1,
  negative_marks        NUMERIC(5,2) NOT NULL DEFAULT 0,
  section               TEXT DEFAULT NULL,
  topic                 TEXT DEFAULT NULL,
  topics                JSONB DEFAULT '[]',
  topic_distribution    JSONB DEFAULT '{}',
  sections              JSONB DEFAULT '[]',
  section_distribution  JSONB DEFAULT '{}',
  question_ids          JSONB DEFAULT '[]',
  assigned_question_ids JSONB DEFAULT '[]',
  attempts_count        INTEGER NOT NULL DEFAULT 0,
  avg_score             INTEGER NOT NULL DEFAULT 0,
  created_by            TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Attempts ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attempts (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  test_id         TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  score           INTEGER NOT NULL DEFAULT 0,
  total_questions INTEGER NOT NULL DEFAULT 0,
  correct         INTEGER NOT NULL DEFAULT 0,
  wrong           INTEGER NOT NULL DEFAULT 0,
  skipped         INTEGER NOT NULL DEFAULT 0,
  time_taken      INTEGER NOT NULL DEFAULT 0,
  answers         JSONB DEFAULT '{}',
  question_times  JSONB DEFAULT '{}',
  question_ids    JSONB DEFAULT '[]',
  completed_at    TEXT NOT NULL DEFAULT TO_CHAR(NOW(),'YYYY-MM-DD'),
  xp_earned       INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Credit Transactions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_transactions (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount        INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('credit','debit')),
  description   TEXT NOT NULL DEFAULT '',
  note          TEXT DEFAULT '',
  payment_mode  TEXT DEFAULT 'Cash',
  paid_amount   INTEGER DEFAULT 0,
  date          TEXT NOT NULL DEFAULT TO_CHAR(NOW(),'YYYY-MM-DD'),
  by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── App Settings ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_email          ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role           ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status         ON users(status);
CREATE INDEX IF NOT EXISTS idx_questions_section    ON questions(section);
CREATE INDEX IF NOT EXISTS idx_questions_topic      ON questions(topic);
CREATE INDEX IF NOT EXISTS idx_questions_sec_topic  ON questions(section, topic);
CREATE INDEX IF NOT EXISTS idx_tests_type           ON tests(type);
CREATE INDEX IF NOT EXISTS idx_tests_status         ON tests(status);
CREATE INDEX IF NOT EXISTS idx_attempts_user        ON attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_attempts_test        ON attempts(test_id);
CREATE INDEX IF NOT EXISTS idx_attempts_date        ON attempts(completed_at);
CREATE INDEX IF NOT EXISTS idx_credits_user         ON credit_transactions(user_id);

-- ─── Auto-update updated_at trigger ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_questions_updated_at ON questions;
CREATE TRIGGER trg_questions_updated_at
  BEFORE UPDATE ON questions FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_tests_updated_at ON tests;
CREATE TRIGGER trg_tests_updated_at
  BEFORE UPDATE ON tests FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Row Level Security (RLS) — disable for service-role-key access ───────────
-- Service role key bypasses RLS, but enable the flag for safety
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sections            ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tests               ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings            ENABLE ROW LEVEL SECURITY;

-- Allow service role to do everything (your API uses service role key)
CREATE POLICY "service_role_all_users"    ON users               FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_sections" ON sections            FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_qs"       ON questions           FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_tests"    ON tests               FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_attempts" ON attempts            FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_credits"  ON credit_transactions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_settings" ON settings            FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── Built-in sections ────────────────────────────────────────────────────────
INSERT INTO sections (name, is_builtin) VALUES
  ('Anatomy',              TRUE),
  ('Physiology',           TRUE),
  ('Clinical Biochemistry',TRUE),
  ('Clinical Pathology',   TRUE),
  ('Blood Bank',           TRUE),
  ('Virology',             TRUE),
  ('Bacteriology',         TRUE),
  ('Immunology',           TRUE),
  ('Parasitology',         TRUE),
  ('Mycology',             TRUE)
ON CONFLICT (name) DO NOTHING;

-- ─── Master admin (password: master123) ──────────────────────────────────────
INSERT INTO users (id, name, email, password, role, credits, avatar, status)
VALUES (
  'master-admin-001',
  'Master Admin',
  'master@mlt.com',
  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'master',
  9999,
  'MA',
  'active'
) ON CONFLICT (email) DO NOTHING;

-- ─── App Settings seed ────────────────────────────────────────────────────────
INSERT INTO settings (key, value) VALUES ('app_settings', '{"creditPlans":[],"whatsappNumber":""}')
ON CONFLICT (key) DO NOTHING;

-- ─── Safe column additions ────────────────────────────────────────────────────
ALTER TABLE tests ADD COLUMN IF NOT EXISTS positive_marks        NUMERIC(5,2) NOT NULL DEFAULT 1;
ALTER TABLE tests ADD COLUMN IF NOT EXISTS negative_marks        NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE tests ADD COLUMN IF NOT EXISTS assigned_question_ids JSONB        DEFAULT '[]';
ALTER TABLE tests ADD COLUMN IF NOT EXISTS attempts_count        INTEGER      NOT NULL DEFAULT 0;
ALTER TABLE tests ADD COLUMN IF NOT EXISTS avg_score             INTEGER      NOT NULL DEFAULT 0;
ALTER TABLE tests ADD COLUMN IF NOT EXISTS topic_distribution    JSONB        DEFAULT '{}';
ALTER TABLE tests ADD COLUMN IF NOT EXISTS section_distribution  JSONB        DEFAULT '{}';
ALTER TABLE tests ADD COLUMN IF NOT EXISTS topics                JSONB        DEFAULT '[]';
ALTER TABLE tests ADD COLUMN IF NOT EXISTS sections              JSONB        DEFAULT '[]';
ALTER TABLE tests ADD COLUMN IF NOT EXISTS question_ids          JSONB        DEFAULT '[]';

ALTER TABLE attempts ADD COLUMN IF NOT EXISTS question_times JSONB   DEFAULT '{}';
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS question_ids   JSONB   DEFAULT '[]';
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS wrong          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS skipped        INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
