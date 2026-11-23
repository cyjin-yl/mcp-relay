package dev.cyjin.mcprelay.input;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;

/** Explicit ordered broadcasts; the manifest requires a signature permission.
 * AOSP root UID is allowed by checkComponentPermission. Ordinary apps are denied.
 * The acknowledgement confirms commitText's return value, not application rendering.
 */
public final class CommitReceiver extends BroadcastReceiver {
    public static final String ACTION = "dev.cyjin.mcprelay.input.COMMIT";
    private static final int MAX_BYTES = 65536;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final Map<String, String> COMPLETED = new LinkedHashMap<String, String>() {
        @Override protected boolean removeEldestEntry(Map.Entry<String, String> eldest) { return size() > 64; }
    };

    @Override public void onReceive(Context context, Intent intent) {
        if (!isOrderedBroadcast()) return;
        final PendingResult result = goAsync();
        final String request = intent.getStringExtra("request_id");
        if (!ACTION.equals(intent.getAction()) || request == null || !request.matches("[a-f0-9]{32}")) {
            reply(result, request == null ? "invalid" : request, 10, "invalid_request");
            return;
        }
        final String payload = intent.getStringExtra("payload_b64");
        final String expectedPackage = intent.getStringExtra("expected_package");
        if (payload == null || payload.length() > 87384 || !payload.matches("[A-Za-z0-9+/]*={0,2}")
                || expectedPackage == null || !expectedPackage.matches("[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)+")) {
            reply(result, request, 11, "invalid_payload");
            return;
        }
        final byte[] bytes;
        final String text;
        final String digest;
        try {
            bytes = Base64.decode(payload, Base64.NO_WRAP);
            if (bytes.length > MAX_BYTES) throw new IllegalArgumentException();
            text = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
            digest = hex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception error) {
            reply(result, request, 12, "invalid_utf8");
            return;
        }
        final String completed = COMPLETED.get(request);
        if (completed != null) {
            reply(result, request, completed.equals(digest) ? -1 : 13,
                    completed.equals(digest) ? "ok" : "request_id_reused");
            return;
        }
        final long deadline = SystemClock.uptimeMillis() + 4500;
        MAIN.post(new Runnable() {
            @Override public void run() {
                RelayInputService service = RelayInputService.active();
                InputConnection connection = service == null ? null : service.getCurrentInputConnection();
                EditorInfo editor = service == null ? null : service.getCurrentInputEditorInfo();
                if (service == null || !service.getCurrentInputStarted() || connection == null || editor == null) {
                    if (SystemClock.uptimeMillis() < deadline) MAIN.postDelayed(this, 50);
                    else reply(result, request, 20, "no_input_connection");
                    return;
                }
                if (!expectedPackage.equals(editor.packageName)) {
                    reply(result, request, 21, "focus_changed");
                    return;
                }
                try {
                    if (!connection.commitText(text, 1)) {
                        reply(result, request, 22, "commit_rejected");
                        return;
                    }
                    COMPLETED.put(request, digest);
                    reply(result, request, -1, "ok");
                } catch (RuntimeException error) {
                    // A failed acknowledgement must never trigger automatic replay.
                    reply(result, request, 23, "commit_exception");
                }
            }
        });
    }

    private static void reply(PendingResult result, String request, int code, String status) {
        result.setResultCode(code);
        result.setResultData("relay-input:" + request + ":" + status);
        result.finish();
    }

    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return out.toString();
    }
}
