package dev.cyjin.mcprelay.workspaceprobe;

import android.app.Activity;
import android.content.res.Configuration;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Test-only app: records only its own field and events; never reads clipboard or IME state. */
public final class ProbeActivity extends Activity {
    private EditText field;
    private TextView status;
    private int clicks, keyEvents, moved, lastDisplay = -1;
    private boolean focused;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(24, 20, 24, 20);
        column.setBackgroundColor(0xff183246);
        TextView title = new TextView(this);
        title.setText("RELAY PRIVATE DISPLAY PROBE");
        title.setTextColor(0xffffffff);
        title.setTextSize(20);
        column.addView(title, new LinearLayout.LayoutParams(-1, 70));
        field = new EditText(this);
        field.setId(12345);
        field.setSingleLine(true);
        field.setTextColor(0xff000000);
        field.setBackgroundColor(0xffffffff);
        field.setShowSoftInputOnFocus(false);
        column.addView(field, new LinearLayout.LayoutParams(-1, 100));
        Button button = new Button(this);
        button.setText("PRIVATE TOUCH COUNTER");
        button.setOnClickListener(v -> { clicks++; persist(); });
        column.addView(button, new LinearLayout.LayoutParams(-1, 100));
        status = new TextView(this);
        status.setTextColor(0xffb9e1ff);
        column.addView(status, new LinearLayout.LayoutParams(-1, 120));
        field.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence text, int start, int count, int after) { }
            public void onTextChanged(CharSequence text, int start, int before, int count) { persist(); }
            public void afterTextChanged(Editable text) { }
        });
        setContentView(column);
        field.requestFocus();
        persist();
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        keyEvents++;
        boolean result = super.dispatchKeyEvent(event);
        persist();
        return result;
    }
    @Override public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        focused = focus;
        persist();
    }
    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        int displayId = getDisplay() == null ? -1 : getDisplay().getDisplayId();
        if (displayId != lastDisplay) { moved++; lastDisplay = displayId; }
        persist();
    }
    @Override protected void onResume() { super.onResume(); persist(); }
    private void persist() {
        if (field == null || status == null) return;
        try {
            int displayId = getDisplay() == null ? -1 : getDisplay().getDisplayId();
            JSONObject value = new JSONObject().put("displayId", displayId).put("text", field.getText().toString())
                .put("clicks", clicks).put("keyEvents", keyEvents).put("moved", moved).put("lastMovedDisplay", lastDisplay)
                .put("windowFocused", focused).put("taskId", getTaskId());
            status.setText(value.toString());
            try (FileOutputStream output = openFileOutput("probe.json", MODE_PRIVATE)) {
                output.write(value.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) { }
    }
}
