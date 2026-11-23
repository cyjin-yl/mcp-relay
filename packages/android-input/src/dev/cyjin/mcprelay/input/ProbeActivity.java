package dev.cyjin.mcprelay.input;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

/** A benign, app-owned surface for real-device acceptance. Never inspects another app. */
public final class ProbeActivity extends Activity {
    private static WeakReference<ProbeActivity> active = new WeakReference<>(null);
    private EditText editor;
    private TextView counterLabel;
    private Button counterButton;
    private ScrollView scroll;
    private View touchPad;
    private int clicks;
    private int touches;
    private int moves;
    private boolean resumed;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(24, 24, 24, 24);
        body.setBackgroundColor(Color.rgb(245, 248, 252));
        TextView heading = new TextView(this);
        heading.setText("MCP Relay — owned input test");
        heading.setTextSize(22);
        body.addView(heading);
        editor = new EditText(this);
        editor.setHint("Unicode test field");
        editor.setSingleLine(false);
        editor.setMinLines(2);
        editor.setShowSoftInputOnFocus(false);
        body.addView(editor, new LinearLayout.LayoutParams(-1, 180));
        Button button = new Button(this);
        counterButton = button;
        button.setText("Increase test counter");
        counterLabel = new TextView(this);
        counterLabel.setText("Counter: 0");
        button.setOnClickListener(view -> { clicks++; counterLabel.setText("Counter: " + clicks); });
        body.addView(button, new LinearLayout.LayoutParams(-1, 120));
        body.addView(counterLabel);
        touchPad = new TextView(this);
        ((TextView) touchPad).setText("Touch and drag test pad");
        touchPad.setBackgroundColor(Color.rgb(190, 220, 250));
        touchPad.setOnTouchListener((view, event) -> {
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN) touches++;
            if (event.getActionMasked() == MotionEvent.ACTION_MOVE) moves++;
            return true;
        });
        body.addView(touchPad, new LinearLayout.LayoutParams(-1, 180));
        scroll = new ScrollView(this);
        LinearLayout rows = new LinearLayout(this);
        rows.setOrientation(LinearLayout.VERTICAL);
        for (int index = 0; index < 60; index++) {
            TextView row = new TextView(this);
            row.setText("Benign scroll test row " + index);
            row.setTextSize(20);
            row.setPadding(0, 24, 0, 24);
            rows.addView(row);
        }
        scroll.addView(rows);
        body.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(body);
        editor.requestFocus();
        active = new WeakReference<>(this);
    }

    @Override protected void onResume() { super.onResume(); resumed = true; }
    @Override protected void onPause() { resumed = false; super.onPause(); }
    @Override protected void onDestroy() {
        if (active.get() == this) active.clear();
        super.onDestroy();
    }

    private static JSONObject rectangle(View view) throws Exception {
        int[] location = new int[2];
        view.getLocationOnScreen(location);
        return new JSONObject().put("x", location[0]).put("y", location[1])
                .put("width", view.getWidth()).put("height", view.getHeight());
    }

    static JSONObject status() throws Exception {
        ProbeActivity activity = active.get();
        if (activity == null || !activity.resumed) throw new IllegalStateException("probe_not_foreground");
        byte[] bytes = activity.editor.getText().toString().getBytes(StandardCharsets.UTF_8);
        return new JSONObject().put("utf8Bytes", bytes.length)
                .put("textSha256", CommitReceiver.hex(MessageDigest.getInstance("SHA-256").digest(bytes)))
                .put("clicks", activity.clicks).put("touches", activity.touches).put("moves", activity.moves)
                .put("scrollY", activity.scroll.getScrollY()).put("editorFocused", activity.editor.hasFocus())
                .put("editor", rectangle(activity.editor)).put("counterButton", rectangle(activity.counterButton))
                .put("touchPad", rectangle(activity.touchPad)).put("scroll", rectangle(activity.scroll));
    }
}
