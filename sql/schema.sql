-- ═══════════════════════════════════════════════════════════════════════════════
-- MLT Universe — Supabase PostgreSQL Schema  (v5 — separate option columns)
-- Run this in Supabase SQL Editor: Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

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
-- Each option gets its own column for clarity & easy editing in Supabase UI.
-- The old JSONB `options` column is kept for backward compatibility during migration.
CREATE TABLE IF NOT EXISTS questions (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  section              TEXT NOT NULL,
  topic                TEXT NOT NULL,
  text                 TEXT NOT NULL,
  -- Separate columns for each option (new — preferred)
  option_a             TEXT NOT NULL DEFAULT '',
  option_b             TEXT NOT NULL DEFAULT '',
  option_c             TEXT NOT NULL DEFAULT '',
  option_d             TEXT NOT NULL DEFAULT '',
  -- Legacy JSONB column kept for migration; code now reads option_a…d first
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

-- Add new columns to existing tables (safe — idempotent)
ALTER TABLE questions ADD COLUMN IF NOT EXISTS option_a TEXT NOT NULL DEFAULT '';
ALTER TABLE questions ADD COLUMN IF NOT EXISTS option_b TEXT NOT NULL DEFAULT '';
ALTER TABLE questions ADD COLUMN IF NOT EXISTS option_c TEXT NOT NULL DEFAULT '';
ALTER TABLE questions ADD COLUMN IF NOT EXISTS option_d TEXT NOT NULL DEFAULT '';

-- One-time migration: populate option_a…d from the JSONB options array
-- Run once after adding columns. Safe to re-run (only updates rows where option_a is blank).
UPDATE questions
SET
  option_a = COALESCE(options->>0, ''),
  option_b = COALESCE(options->>1, ''),
  option_c = COALESCE(options->>2, ''),
  option_d = COALESCE(options->>3, '')
WHERE option_a = '' AND jsonb_array_length(options) > 0;

-- Trigger: keep option_a…d and options JSONB in sync automatically
CREATE OR REPLACE FUNCTION sync_question_options() RETURNS TRIGGER AS $$
BEGIN
  -- If option columns changed, rebuild the JSONB array
  IF (TG_OP = 'INSERT') OR
     (NEW.option_a IS DISTINCT FROM OLD.option_a) OR
     (NEW.option_b IS DISTINCT FROM OLD.option_b) OR
     (NEW.option_c IS DISTINCT FROM OLD.option_c) OR
     (NEW.option_d IS DISTINCT FROM OLD.option_d) THEN
    NEW.options := jsonb_build_array(NEW.option_a, NEW.option_b, NEW.option_c, NEW.option_d);
  END IF;
  -- If options JSONB changed but columns weren't touched, explode back to columns
  IF (TG_OP = 'UPDATE') AND (NEW.options IS DISTINCT FROM OLD.options) AND
     (NEW.option_a = OLD.option_a) THEN
    NEW.option_a := COALESCE(NEW.options->>0, '');
    NEW.option_b := COALESCE(NEW.options->>1, '');
    NEW.option_c := COALESCE(NEW.options->>2, '');
    NEW.option_d := COALESCE(NEW.options->>3, '');
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_question_options ON questions;
CREATE TRIGGER trg_sync_question_options
  BEFORE INSERT OR UPDATE ON questions
  FOR EACH ROW EXECUTE FUNCTION sync_question_options();

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
  answers         JSONB NOT NULL DEFAULT '{}',
  question_times  JSONB NOT NULL DEFAULT '{}',
  question_ids    JSONB NOT NULL DEFAULT '[]',
  xp_earned       INTEGER NOT NULL DEFAULT 0,
  completed_at    TEXT NOT NULL DEFAULT TO_CHAR(NOW(),'YYYY-MM-DD')
);

-- ─── Settings ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key     TEXT PRIMARY KEY,
  value   JSONB NOT NULL DEFAULT '{}'
);

-- ─── Credit Transactions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_transactions (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount       INTEGER NOT NULL,
  type         TEXT NOT NULL DEFAULT 'manual' CHECK (type IN ('manual','purchase','deduction','refund')),
  description  TEXT DEFAULT '',
  note         TEXT DEFAULT '',
  payment_mode TEXT DEFAULT 'Cash',
  paid_amount  NUMERIC(10,2) DEFAULT 0,
  date         TEXT NOT NULL DEFAULT TO_CHAR(NOW(),'YYYY-MM-DD'),
  by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Active Attempts (credit-deduction guard) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS active_attempts (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  test_id     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, test_id)
);

-- ─── Safe column additions (idempotent) ──────────────────────────────────────
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

-- ─── Sections seed ────────────────────────────────────────────────────────────
INSERT INTO sections (name, is_builtin) VALUES
  ('Haematology',          TRUE),
  ('Microbiology',         TRUE),
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

-- ─── Master admin seed (password: master123) ─────────────────────────────────
INSERT INTO users (id, name, email, password, role, credits, avatar, status)
VALUES (
  'master-admin-001', 'Master Admin', 'master@mlt.com',
  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'master', 9999, 'MA', 'active'
) ON CONFLICT (email) DO NOTHING;

-- ─── App Settings seed ────────────────────────────────────────────────────────
INSERT INTO settings (key, value)
VALUES ('app_settings', '{"creditPlans":[],"whatsappNumber":""}')
ON CONFLICT (key) DO NOTHING;

-- ─── RLS: disable for service-role access (recommended for this app) ─────────
-- The app connects via SUPABASE_DB_URL (Transaction Pooler) using the postgres
-- driver with service role — RLS is not needed.
-- ALTER TABLE users    DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE questions DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE tests    DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE attempts DISABLE ROW LEVEL SECURITY;

