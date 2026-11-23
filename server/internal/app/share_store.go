package app

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

var (
	errShareUnavailable = errors.New("share_unavailable")
	errShareDevices     = errors.New("invalid_devices")
	errShareLimit       = errors.New("share_limit")
)

type ShareDevice struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type DeviceShare struct {
	ID        string        `json:"id"`
	UserID    string        `json:"-"`
	Label     string        `json:"label"`
	Devices   []ShareDevice `json:"devices"`
	Scopes    []string      `json:"scopes"`
	CreatedAt int64         `json:"createdAt"`
	ExpiresAt int64         `json:"expiresAt"`
	ClaimedAt int64         `json:"claimedAt"`
	RevokedAt int64         `json:"revokedAt"`
	Status    string        `json:"status"`
}

type shareQuerier interface {
	Query(string, ...any) (*sql.Rows, error)
	QueryRow(string, ...any) *sql.Row
}

func shareStatus(s *DeviceShare, now int64) string {
	if s.RevokedAt != 0 {
		return "revoked"
	}
	if s.ExpiresAt <= now {
		return "expired"
	}
	if s.ClaimedAt != 0 {
		return "active"
	}
	return "pending"
}

func readShare(q shareQuerier, id, userID string, activeDevicesOnly bool) (*DeviceShare, error) {
	var s DeviceShare
	var scope string
	err := q.QueryRow(`SELECT id, label, scope, created_at, expires_at, COALESCE(claimed_at, 0), COALESCE(revoked_at, 0)
		FROM device_shares WHERE id = ? AND user_id = ?`, id, userID).
		Scan(&s.ID, &s.Label, &scope, &s.CreatedAt, &s.ExpiresAt, &s.ClaimedAt, &s.RevokedAt)
	if err != nil {
		return nil, err
	}
	s.Scopes = strings.Fields(scope)
	s.UserID = userID
	s.Status = shareStatus(&s, nowUnix())
	s.Devices = []ShareDevice{}
	query := `SELECT d.id, d.slug, d.name FROM device_share_devices sd JOIN devices d ON d.id = sd.device_id
		WHERE sd.share_id = ? AND d.user_id = ?`
	if activeDevicesOnly {
		query += ` AND d.revoked_at IS NULL`
	}
	rows, err := q.Query(query+` ORDER BY d.name, d.id`, id, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var d ShareDevice
		if err := rows.Scan(&d.ID, &d.Slug, &d.Name); err != nil {
			return nil, err
		}
		s.Devices = append(s.Devices, d)
	}
	return &s, rows.Err()
}

// CreateShare obtains the SQLite write lock before checking device ownership.
// Device revocation and concurrent share creation therefore cannot interleave
// with the ownership check or the per-owner active-share limit.
func (s *Store) CreateShare(userID, audience, label string, deviceIDs, scopes []string, ttlSeconds int64) (*DeviceShare, string, error) {
	now := nowUnix()
	id, claimToken := "shr_"+randomID(), randomToken("mrclaim_")
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback()
	result, err := tx.Exec(`INSERT INTO device_shares
		(id, user_id, label, scope, audience, claim_hash, created_at, expires_at)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?
		WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')
		AND (SELECT COUNT(*) FROM device_shares WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?) < 100`,
		id, userID, label, strings.Join(scopes, " "), audience, hashToken(claimToken), now, now+ttlSeconds, userID, userID, now)
	if err != nil {
		return nil, "", err
	}
	if n, err := result.RowsAffected(); err != nil || n != 1 {
		if err != nil {
			return nil, "", err
		}
		return nil, "", errShareLimit
	}
	for _, deviceID := range deviceIDs {
		result, err := tx.Exec(`INSERT INTO device_share_devices (share_id, device_id)
			SELECT ?, id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, id, deviceID, userID)
		if err != nil {
			return nil, "", err
		}
		if n, err := result.RowsAffected(); err != nil || n != 1 {
			if err != nil {
				return nil, "", err
			}
			return nil, "", errShareDevices
		}
	}
	share, err := readShare(tx, id, userID, true)
	if err != nil {
		return nil, "", err
	}
	if err := tx.Commit(); err != nil {
		return nil, "", err
	}
	return share, claimToken, nil
}

func (s *Store) ListShares(userID string) ([]DeviceShare, error) {
	// Always include every usable share (creation caps these at 100), even if
	// a user has accumulated more than 200 recent expired/revoked entries.
	rows, err := s.DB.Query(`SELECT id FROM device_shares WHERE user_id = ?
		ORDER BY (revoked_at IS NULL AND expires_at > ?) DESC, created_at DESC, id DESC LIMIT 200`, userID, nowUnix())
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	out := make([]DeviceShare, 0, len(ids))
	for _, id := range ids {
		share, err := readShare(s.DB, id, userID, false)
		if errors.Is(err, sql.ErrNoRows) {
			continue // A concurrent retention sweep may remove expired history.
		}
		if err != nil {
			return nil, err
		}
		out = append(out, *share)
	}
	return out, nil
}

// ClaimShare atomically burns a claim credential and installs a token hash.
// The first statement is a write, so concurrent requests serialize without a
// read-to-write transaction upgrade. Rollback leaves the claim unconsumed.
func (s *Store) ClaimShare(claimHash, audience string) (*DeviceShare, string, error) {
	accessToken := randomToken("mrshare_")
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback()
	var id, userID string
	err = tx.QueryRow(`UPDATE device_shares SET claim_hash = NULL, access_hash = ?, claimed_at = unixepoch()
		WHERE claim_hash = ? AND audience = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > unixepoch()
		AND EXISTS (SELECT 1 FROM users u WHERE u.id = device_shares.user_id AND u.status = 'active')
		AND EXISTS (SELECT 1 FROM device_share_devices sd JOIN devices d ON d.id = sd.device_id
			WHERE sd.share_id = device_shares.id AND d.user_id = device_shares.user_id AND d.revoked_at IS NULL)
		RETURNING id, user_id`, hashToken(accessToken), claimHash, audience).Scan(&id, &userID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", errShareUnavailable
	}
	if err != nil {
		return nil, "", err
	}
	share, err := readShare(tx, id, userID, true)
	if err != nil {
		return nil, "", err
	}
	if err := tx.Commit(); err != nil {
		return nil, "", err
	}
	return share, accessToken, nil
}

func (s *Store) RevokeShare(id, userID string) error {
	result, err := s.DB.Exec(`UPDATE device_shares SET revoked_at = COALESCE(revoked_at, ?), claim_hash = NULL, access_hash = NULL
		WHERE id = ? AND user_id = ?`, nowUnix(), id, userID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errShareUnavailable
	}
	return nil
}

func (s *Store) VerifyShareToken(tokenHash, audience string) (*VerifiedToken, error) {
	var token VerifiedToken
	var scope string
	err := s.DB.QueryRow(`SELECT s.id, s.user_id, s.scope, s.audience, s.expires_at FROM device_shares s
		JOIN users u ON u.id = s.user_id WHERE s.access_hash = ? AND s.audience = ?
		AND s.claimed_at IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'`, tokenHash, audience, nowUnix()).
		Scan(&token.ShareID, &token.UserID, &scope, &token.Audience, &token.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	token.ClientID = "share:" + token.ShareID
	token.Scopes = strings.Fields(scope)
	token.AllowedDeviceIDs = make(map[string]bool)
	rows, err := s.DB.Query(`SELECT d.id FROM device_share_devices sd JOIN devices d ON d.id = sd.device_id
		WHERE sd.share_id = ? AND d.user_id = ? AND d.revoked_at IS NULL`, token.ShareID, token.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		token.AllowedDeviceIDs[id] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(token.AllowedDeviceIDs) == 0 {
		return nil, nil
	}
	return &token, nil
}

func (s *Store) ShareActive(shareID, userID, audience string) (bool, error) {
	var active bool
	err := s.DB.QueryRow(`SELECT EXISTS(SELECT 1 FROM device_shares s JOIN users u ON u.id = s.user_id
		WHERE s.id = ? AND s.user_id = ? AND s.audience = ? AND u.status = 'active'
		AND s.claimed_at IS NOT NULL AND s.access_hash IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at > ?)`,
		shareID, userID, audience, nowUnix()).Scan(&active)
	return active, err
}

func (s *Store) ShareAllowsDevice(ctx context.Context, shareID, userID, audience, deviceID string) (bool, error) {
	var allowed bool
	err := s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM device_shares s JOIN users u ON u.id = s.user_id
		JOIN device_share_devices sd ON sd.share_id = s.id JOIN devices d ON d.id = sd.device_id
		WHERE s.id = ? AND s.user_id = ? AND s.audience = ? AND u.status = 'active'
		AND s.claimed_at IS NOT NULL AND s.access_hash IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at > ?
		AND d.id = ? AND d.user_id = s.user_id AND d.revoked_at IS NULL)`,
		shareID, userID, audience, nowUnix(), deviceID).Scan(&allowed)
	return allowed, err
}
