package app

import (
	"encoding/base64"
	"errors"
	"io"
	"mime"
	"strings"
)

func isComputerTool(name string) bool {
	switch name {
	case "computer_info", "computer_screenshot", "computer_action", "computer_handoff", "computer_setup":
		return true
	}
	return false
}

func isComputerWriteTool(name string) bool {
	return name == "computer_action" || name == "computer_handoff" || name == "computer_setup"
}

// Validate only native image payloads. Unknown MCP content blocks remain opaque
// and are forwarded unchanged. The websocket separately bounds the whole frame.
func validateNativeImages(result CallToolResult) error {
	var decodedTotal int64
	for _, block := range result.Content {
		if block["type"] != "image" {
			continue
		}
		data, ok := block["data"].(string)
		if !ok || data == "" {
			return errors.New("image data must be nonempty base64")
		}
		mimeType, ok := block["mimeType"].(string)
		if !ok || len(mimeType) > 128 {
			return errors.New("image MIME type is invalid")
		}
		mediaType, _, err := mime.ParseMediaType(mimeType)
		if err != nil || !strings.HasPrefix(mediaType, "image/") {
			return errors.New("image MIME type is invalid")
		}
		if len(data) > base64.StdEncoding.EncodedLen(maxNativeImageBytes) {
			return errors.New("image content exceeds the 12 MiB decoded limit")
		}
		// Stream the validation to avoid allocating another full decoded screenshot.
		reader := base64.NewDecoder(base64.StdEncoding.Strict(), strings.NewReader(data))
		n, err := io.Copy(io.Discard, io.LimitReader(reader, int64(maxNativeImageBytes)+1))
		if err != nil {
			return errors.New("image data is not valid base64")
		}
		decodedTotal += n
		if decodedTotal > int64(maxNativeImageBytes) {
			return errors.New("image content exceeds the 12 MiB decoded limit")
		}
	}
	return nil
}
