package app

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
)

func randomToken(prefix string) string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func marshalJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func splitJSONArray(raw string) []string {
	var out []string
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	return out
}

const pairingAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

func randomPairingCode() string {
	out := make([]byte, 8)
	for i := range out {
		b := make([]byte, 1)
		if _, err := rand.Read(b); err != nil {
			panic(err)
		}
		out[i] = pairingAlphabet[int(b[0])%len(pairingAlphabet)]
	}
	return string(out)
}

func normalizePairingCode(input string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(input) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func displayPairingCode(code string) string {
	if len(code) <= 4 {
		return code
	}
	return code[:4] + "-" + code[4:]
}

func slugifyDeviceName(name string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
		} else if !lastDash && b.Len() > 0 {
			b.WriteByte('-')
			lastDash = true
		}
		if b.Len() >= 12 {
			break
		}
	}
	slug := strings.Trim(b.String(), "-")
	if slug == "" {
		return "device"
	}
	return slug
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
