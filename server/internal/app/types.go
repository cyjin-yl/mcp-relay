package app

import (
	"encoding/json"
	"time"
)

const (
	scopeRead    = "relay.read"
	scopeWrite   = "relay.write"
	scopeOffline = "offline_access"

	accessTokenTTL  = time.Hour
	refreshTokenTTL = 30 * 24 * time.Hour
	authCodeTTL     = 10 * time.Minute
	pendingTTL      = 10 * time.Minute

	defaultScope = "relay.read relay.write"
)

var supportedScopes = []string{scopeRead, scopeWrite, scopeOffline}

type User struct {
	ID          string
	GitHubID    string
	Login       string
	Email       string
	Status      string
	IsAdmin     bool
	CreatedAt   int64
	LastLoginAt int64
}

type SessionCtx struct {
	IDHash    string
	CSRFToken string
	ExpiresAt int64
	User      User
}

type OAuthClient struct {
	ID           string
	Name         string
	RedirectURIs []string
	Source       string
	AuthMethod   string
	SecretHash   string
}

type Annotations struct {
	Title       string `json:"title,omitempty"`
	ReadOnly    *bool  `json:"readOnlyHint,omitempty"`
	Destructive *bool  `json:"destructiveHint,omitempty"`
	Idempotent  *bool  `json:"idempotentHint,omitempty"`
	OpenWorld   *bool  `json:"openWorldHint,omitempty"`
}

type Tool struct {
	Name        string          `json:"name"`
	Title       string          `json:"title,omitempty"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Annotations *Annotations    `json:"annotations,omitempty"`
}

func (t Tool) readOnly() bool {
	if isComputerWriteTool(t.Name) {
		return false
	}
	return t.Annotations != nil && t.Annotations.ReadOnly != nil && *t.Annotations.ReadOnly
}

type ContentBlock map[string]any

type CallToolResult struct {
	Content           []ContentBlock `json:"content"`
	StructuredContent any            `json:"structuredContent,omitempty"`
	IsError           bool           `json:"isError,omitempty"`
	Meta              map[string]any `json:"_meta,omitempty"`
}

func jsonResult(value any) CallToolResult {
	b, _ := json.MarshalIndent(value, "", "  ")
	return CallToolResult{
		Content:           []ContentBlock{{"type": "text", "text": string(b)}},
		StructuredContent: value,
	}
}

func textResult(text string, isError bool) CallToolResult {
	r := CallToolResult{Content: []ContentBlock{{"type": "text", "text": text}}}
	r.IsError = isError
	return r
}

type Device struct {
	ID         string
	UserID     string
	Slug       string
	Name       string
	Platform   string
	Arch       string
	Packs      []string
	TokenHash  string
	CreatedAt  int64
	LastSeenAt int64
	RevokedAt  int64
}

type VerifiedToken struct {
	UserID   string
	ClientID string
	Scopes   []string
	Audience string
}
