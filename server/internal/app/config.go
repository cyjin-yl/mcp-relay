package app

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	BaseURL        string
	Issuer         string
	Resource       string
	Addr           string
	DataDir        string
	DBPath         string
	Env            string
	SecureCookies  bool
	TrustProxy     bool
	GitHubClientID string
	GitHubSecret   string
	GitHubRedirect string
	AdminLogin     string
	InviteRequired bool
	SessionTTL     time.Duration
}

func LoadConfig() (Config, error) {
	base := strings.TrimRight(envOr("BASE_URL", "http://localhost:8080"), "/")
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return Config{}, fmt.Errorf("invalid BASE_URL %q", base)
	}
	if u.Scheme != "https" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" {
		return Config{}, errors.New("BASE_URL must use https outside localhost")
	}
	env := envOr("ENV", "development")
	addr := os.Getenv("ADDR")
	if addr == "" {
		host := envOr("HOST", "0.0.0.0")
		port := envOr("PORT", "8080")
		addr = host + ":" + port
	}
	dataDir, err := filepath.Abs(envOr("DATA_DIR", "./data"))
	if err != nil {
		return Config{}, err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return Config{}, err
	}
	ttlDays, err := strconv.Atoi(envOr("SESSION_TTL_DAYS", "30"))
	if err != nil || ttlDays <= 0 {
		ttlDays = 30
	}
	return Config{
		BaseURL:        base,
		Issuer:         base,
		Resource:       base + "/mcp",
		Addr:           addr,
		DataDir:        dataDir,
		DBPath:         filepath.Join(dataDir, "relay.sqlite"),
		Env:            env,
		SecureCookies:  u.Scheme == "https",
		TrustProxy:     envBool("TRUST_PROXY", false),
		GitHubClientID: os.Getenv("GITHUB_CLIENT_ID"),
		GitHubSecret:   os.Getenv("GITHUB_CLIENT_SECRET"),
		GitHubRedirect: base + "/auth/github/callback",
		AdminLogin:     strings.ToLower(os.Getenv("ADMIN_GITHUB_LOGIN")),
		InviteRequired: envBool("INVITE_REQUIRED", true),
		SessionTTL:     time.Duration(ttlDays) * 24 * time.Hour,
	}, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if v == "" {
		return fallback
	}
	return v == "1" || v == "true" || v == "yes" || v == "on"
}
