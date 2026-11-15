CREATE TABLE IF NOT EXISTS slated_key_value (
  namespace TEXT NOT NULL CHECK (namespace IN ('users', 'vault', 'sessions')),
  item_key TEXT NOT NULL,
  value JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (namespace, item_key)
);

CREATE INDEX IF NOT EXISTS slated_key_value_expiry_idx
  ON slated_key_value (expires_at)
  WHERE expires_at IS NOT NULL;
