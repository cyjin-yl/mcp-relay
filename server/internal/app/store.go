package app

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const schemaSQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by TEXT REFERENCES users(id),
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  client_secret_hash TEXT,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_authorizations (
  id_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS auth_codes_expiry ON auth_codes(expires_at);
CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  audience TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS access_tokens_user ON access_tokens(user_id);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  audience TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS refresh_tokens_family ON refresh_tokens(family_id);
CREATE TABLE IF NOT EXISTS consents (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_id)
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT,
  arch TEXT,
  packs TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_user_slug ON devices(user_id, slug);
CREATE TABLE IF NOT EXISTS device_shares (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  scope TEXT NOT NULL,
  audience TEXT NOT NULL,
  claim_hash TEXT UNIQUE,
  access_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS device_shares_user ON device_shares(user_id, created_at);
CREATE TABLE IF NOT EXISTS device_share_devices (
  share_id TEXT NOT NULL REFERENCES device_shares(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  PRIMARY KEY (share_id, device_id)
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  client_id TEXT,
  device_id TEXT,
  tool TEXT NOT NULL,
  args_digest TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_user_time ON audit_log(user_id, created_at);
`

type Store struct {
	DB *sql.DB
}

func OpenStore(path string) (*Store, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	for _, stmt := range strings.Split(schemaSQL, ";") {
		if strings.TrimSpace(stmt) == "" {
			continue
		}
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return nil, fmt.Errorf("schema: %w", err)
		}
	}
	return &Store{DB: db}, nil
}

func (s *Store) Close() error { return s.DB.Close() }

func nowUnix() int64 { return time.Now().Unix() }

func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func (s *Store) UserByID(id string) (*User, error) {
	return s.scanUser(s.DB.QueryRow(
		`SELECT id, github_id, login, COALESCE(email, ''), status, is_admin, created_at, COALESCE(last_login_at, 0)
		   FROM users WHERE id = ?`, id))
}

func (s *Store) UserByGitHubID(githubID string) (*User, error) {
	return s.scanUser(s.DB.QueryRow(
		`SELECT id, github_id, login, COALESCE(email, ''), status, is_admin, created_at, COALESCE(last_login_at, 0)
		   FROM users WHERE github_id = ?`, githubID))
}

func (s *Store) scanUser(row *sql.Row) (*User, error) {
	var u User
	var admin int64
	if err := row.Scan(&u.ID, &u.GitHubID, &u.Login, &u.Email, &u.Status, &admin, &u.CreatedAt, &u.LastLoginAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	u.IsAdmin = admin != 0
	return &u, nil
}

func (s *Store) CreateUser(githubID, login, email, status string, isAdmin bool) (*User, error) {
	u := &User{
		ID:        "usr_" + randomID(),
		GitHubID:  githubID,
		Login:     login,
		Email:     email,
		Status:    status,
		IsAdmin:   isAdmin,
		CreatedAt: nowUnix(),
	}
	admin := 0
	if isAdmin {
		admin = 1
	}
	_, err := s.DB.Exec(
		`INSERT INTO users (id, github_id, login, email, status, is_admin, created_at, last_login_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, u.GitHubID, u.Login, nullString(u.Email), u.Status, admin, u.CreatedAt, u.CreatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (s *Store) UpdateUserLogin(id, login, email string) error {
	_, err := s.DB.Exec(`UPDATE users SET login = ?, email = COALESCE(NULLIF(?, ''), email), last_login_at = ? WHERE id = ?`,
		login, email, nowUnix(), id)
	return err
}

func (s *Store) SetUserStatus(id, status string) error {
	_, err := s.DB.Exec(`UPDATE users SET status = ? WHERE id = ?`, status, id)
	return err
}

func (s *Store) CreateSession(userID string, ttl time.Duration) (token string, csrf string, expiresAt int64, err error) {
	token = randomToken("mrs_")
	csrf = randomToken("mrcsrf_")
	now := nowUnix()
	expiresAt = now + int64(ttl/time.Second)
	_, err = s.DB.Exec(
		`INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		hashToken(token), userID, csrf, now, expiresAt)
	return
}

func (s *Store) Session(hash string) (*SessionCtx, error) {
	row := s.DB.QueryRow(
		`SELECT s.id_hash, s.csrf_token, s.expires_at,
		        u.id, u.github_id, u.login, COALESCE(u.email, ''), u.status, u.is_admin, u.created_at, COALESCE(u.last_login_at, 0)
		   FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`, hash)
	var sc SessionCtx
	var expires int64
	var admin int64
	if err := row.Scan(&sc.IDHash, &sc.CSRFToken, &expires,
		&sc.User.ID, &sc.User.GitHubID, &sc.User.Login, &sc.User.Email, &sc.User.Status, &admin, &sc.User.CreatedAt, &sc.User.LastLoginAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if expires <= nowUnix() {
		_, _ = s.DB.Exec(`DELETE FROM sessions WHERE id_hash = ?`, hash)
		return nil, nil
	}
	sc.ExpiresAt = expires
	sc.User.IsAdmin = admin != 0
	return &sc, nil
}

func (s *Store) DeleteSession(hash string) error {
	_, err := s.DB.Exec(`DELETE FROM sessions WHERE id_hash = ?`, hash)
	return err
}

func (s *Store) Client(id string) (*OAuthClient, error) {
	row := s.DB.QueryRow(
		`SELECT client_id, COALESCE(client_name, ''), redirect_uris, source,
		        token_endpoint_auth_method, COALESCE(client_secret_hash, '')
		   FROM oauth_clients WHERE client_id = ?`, id)
	var c OAuthClient
	var redirects string
	if err := row.Scan(&c.ID, &c.Name, &redirects, &c.Source, &c.AuthMethod, &c.SecretHash); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	c.RedirectURIs = splitJSONArray(redirects)
	return &c, nil
}

func (s *Store) UpsertClient(c OAuthClient) error {
	redirects := marshalJSON(c.RedirectURIs)
	method := c.AuthMethod
	if method == "" {
		method = "none"
	}
	_, err := s.DB.Exec(
		`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash, source, created_at)
		 VALUES (?, ?, ?, ?, NULLIF(?, ''), ?, ?)
		 ON CONFLICT(client_id) DO UPDATE SET client_name = excluded.client_name, redirect_uris = excluded.redirect_uris,
		   token_endpoint_auth_method = excluded.token_endpoint_auth_method, client_secret_hash = excluded.client_secret_hash`,
		c.ID, nullString(c.Name), redirects, method, c.SecretHash, c.Source, nowUnix())
	return err
}

func (s *Store) Audit(userID, clientID, deviceID, tool, argsDigest, status, errorCode string, durationMS int64) {
	_, _ = s.DB.Exec(
		`INSERT INTO audit_log (user_id, client_id, device_id, tool, args_digest, status, error_code, duration_ms, created_at)
		 VALUES (NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, NULLIF(?, ''), ?, NULLIF(?, ''), ?, ?)`,
		userID, clientID, deviceID, tool, argsDigest, status, errorCode, durationMS, nowUnix())
}

func (s *Store) Prune() {
	now := nowUnix()
	for _, q := range []string{
		`DELETE FROM sessions WHERE expires_at < ?`,
		`DELETE FROM pending_authorizations WHERE expires_at < ?`,
		`DELETE FROM auth_codes WHERE expires_at < ?`,
		`DELETE FROM pairing_codes WHERE expires_at < ?`,
		`DELETE FROM access_tokens WHERE expires_at < ? OR revoked_at IS NOT NULL`,
		`DELETE FROM refresh_tokens WHERE expires_at < ? OR revoked_at IS NOT NULL`,
	} {
		_, _ = s.DB.Exec(q, now)
	}
	_, _ = s.DB.Exec(`DELETE FROM audit_log WHERE created_at < ?`, now-30*24*3600)
	// Keep recent share history visible in the console, but destroy expired
	// credentials immediately; authorization does not depend on this sweep.
	_, _ = s.DB.Exec(`UPDATE device_shares SET claim_hash = NULL, access_hash = NULL WHERE expires_at <= ? OR revoked_at IS NOT NULL`, now)
	_, _ = s.DB.Exec(`DELETE FROM device_shares WHERE expires_at < ?`, now-30*24*3600)
}

func nullString(v string) any {
	if v == "" {
		return nil
	}
	return v
}
