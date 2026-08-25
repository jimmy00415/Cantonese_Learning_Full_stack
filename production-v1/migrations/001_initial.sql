BEGIN;

CREATE TABLE schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  token_hash char(64) NOT NULL UNIQUE,
  client_scope_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  event_high_water bigint NOT NULL DEFAULT 0 CHECK (event_high_water >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- Circular message/turn and message/media references are added after all owner
-- tables exist. They remain nullable while a single transaction creates or
-- revokes the related records.
CREATE TABLE messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id uuid,
  client_message_id uuid,
  sequence bigint NOT NULL CHECK (sequence > 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'voice')),
  status text NOT NULL,
  failure_code text,
  text text NOT NULL,
  reply_language text NOT NULL CHECK (reply_language IN ('en', 'yue-Hant-HK', 'cmn-Hans-CN')),
  reply_mode text NOT NULL CHECK (reply_mode IN ('text', 'voice')),
  voice_draft_id uuid,
  media_id uuid,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  cards jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested_replies jsonb NOT NULL DEFAULT '[]'::jsonb,
  needs_clarification boolean NOT NULL DEFAULT false,
  grounding_status text,
  provider text,
  provider_latency_ms integer CHECK (provider_latency_ms IS NULL OR provider_latency_ms >= 0),
  created_at timestamptz NOT NULL,
  UNIQUE (conversation_id, sequence),
  UNIQUE (conversation_id, client_message_id)
);

CREATE TABLE turns (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message_id uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  request_hash char(64) NOT NULL,
  reply_language text NOT NULL CHECK (reply_language IN ('en', 'yue-Hant-HK', 'cmn-Hans-CN')),
  reply_mode text NOT NULL CHECK (reply_mode IN ('text', 'voice')),
  state text NOT NULL CHECK (state IN ('accepted', 'retrieving', 'generating', 'delivered', 'failed')),
  failure_code text,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  worker_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE messages
  ADD CONSTRAINT messages_turn_id_fkey
  FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX uq_messages_assistant_turn
  ON messages (turn_id)
  WHERE role = 'assistant';

CREATE TABLE events (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  cursor bigint NOT NULL CHECK (cursor > 0),
  type text NOT NULL,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES turns(id) ON DELETE CASCADE,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  UNIQUE (conversation_id, cursor)
);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  owner_message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('user_voice', 'assistant_voice')),
  storage_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  sha256 char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'attached')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE messages
  ADD CONSTRAINT messages_voice_draft_id_fkey
  FOREIGN KEY (voice_draft_id) REFERENCES media_assets(id) ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT messages_media_id_fkey
  FOREIGN KEY (media_id) REFERENCES media_assets(id) ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE voice_uploads (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  client_upload_id uuid NOT NULL,
  request_sha256 char(64) NOT NULL,
  mime_type text NOT NULL,
  state text NOT NULL CHECK (state IN ('uploading', 'transcribing', 'ready', 'failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_storage_key text UNIQUE,
  attempt_started_at timestamptz,
  attempt_deadline_at timestamptz,
  media_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  transcript text,
  failure_code text,
  failure_http_status integer,
  retryable boolean,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (session_id, client_upload_id)
);

CREATE TABLE media_generations (
  id uuid PRIMARY KEY,
  owner_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind = 'assistant_voice'),
  state text NOT NULL CHECK (state IN ('generating', 'attached', 'failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_storage_key text UNIQUE,
  attempt_started_at timestamptz,
  attempt_deadline_at timestamptz,
  media_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  failure_code text,
  failure_http_status integer,
  retryable boolean,
  config_version text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (owner_message_id, kind)
);

-- Deliberately no owner foreign key: these durable deletion records must
-- survive session/message cascades and process crashes.
CREATE TABLE media_deletion_jobs (
  id uuid PRIMARY KEY,
  storage_key text NOT NULL UNIQUE,
  reason text NOT NULL,
  not_before timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'deleting', 'completed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  worker_id text,
  last_error_code text,
  sweep_observation char(64),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE rate_limit_buckets (
  id uuid PRIMARY KEY,
  subject_hash char(64) NOT NULL,
  quota text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  expires_at timestamptz NOT NULL,
  UNIQUE (subject_hash, quota, window_start)
);

CREATE TABLE service_state (
  name text PRIMARY KEY,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  heartbeat_at timestamptz,
  last_success_at timestamptz,
  updated_at timestamptz NOT NULL
);

CREATE INDEX idx_messages_conversation_sequence
  ON messages (conversation_id, sequence);

CREATE INDEX idx_turns_claim
  ON turns (lease_expires_at, created_at, conversation_id)
  WHERE state NOT IN ('delivered', 'failed');

CREATE INDEX idx_turns_conversation_unfinished
  ON turns (conversation_id, state, user_message_id)
  WHERE state NOT IN ('delivered', 'failed');

CREATE INDEX idx_events_conversation_cursor
  ON events (conversation_id, cursor);

CREATE INDEX idx_voice_uploads_claim
  ON voice_uploads (state, lease_expires_at, attempt_deadline_at, created_at)
  WHERE state IN ('uploading', 'transcribing');

CREATE INDEX idx_voice_uploads_attempt_key
  ON voice_uploads (attempt_storage_key)
  WHERE attempt_storage_key IS NOT NULL;

CREATE INDEX idx_media_generations_claim
  ON media_generations (state, lease_expires_at, attempt_deadline_at, created_at)
  WHERE state = 'generating';

CREATE INDEX idx_media_generations_attempt_key
  ON media_generations (attempt_storage_key)
  WHERE attempt_storage_key IS NOT NULL;

CREATE INDEX idx_media_assets_session_status
  ON media_assets (session_id, status, expires_at);

CREATE INDEX idx_media_deletion_jobs_claim
  ON media_deletion_jobs (state, not_before, lease_expires_at);

CREATE INDEX idx_rate_limit_buckets_expiry
  ON rate_limit_buckets (expires_at);

INSERT INTO schema_migrations (version) VALUES (1);

COMMIT;
