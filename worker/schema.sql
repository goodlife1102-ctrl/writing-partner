-- 스피치라이터의 5분 완성 글쓰기 — 데이터베이스 구조
-- Cloudflare D1 에서 한 번만 실행한다.

CREATE TABLE IF NOT EXISTS users (
  sub        TEXT PRIMARY KEY,   -- 구글 계정 고유번호
  email      TEXT,
  name       TEXT,
  created_at TEXT,
  last_seen  TEXT,
  blocked    INTEGER DEFAULT 0,  -- 1이면 이용 정지
  bonus      INTEGER DEFAULT 0   -- 관리자가 더 준 하루 횟수
);

CREATE TABLE IF NOT EXISTS usage (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  sub   TEXT,
  email TEXT,
  kind  TEXT,      -- draft / linkedin / brunch / facebook / threads / fix ...
  at    TEXT,      -- UTC 시각 (기록 정리용)
  day   TEXT,      -- 한국 날짜 YYYY-MM-DD (한도 계산용)
  chars INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_day  ON usage(day);
CREATE INDEX IF NOT EXISTS idx_usage_sub  ON usage(sub, day);
CREATE INDEX IF NOT EXISTS idx_usage_at   ON usage(at);

-- 초기 설정값
INSERT INTO settings (k,v) VALUES ('daily_total_cap','100') ON CONFLICT(k) DO NOTHING;
INSERT INTO settings (k,v) VALUES ('per_user_daily','2')    ON CONFLICT(k) DO NOTHING;
INSERT INTO settings (k,v) VALUES ('provider','gemini')     ON CONFLICT(k) DO NOTHING;
INSERT INTO settings (k,v) VALUES ('model','')              ON CONFLICT(k) DO NOTHING;
INSERT INTO settings (k,v) VALUES ('notice','')             ON CONFLICT(k) DO NOTHING;
INSERT INTO settings (k,v) VALUES ('open','1')              ON CONFLICT(k) DO NOTHING;
