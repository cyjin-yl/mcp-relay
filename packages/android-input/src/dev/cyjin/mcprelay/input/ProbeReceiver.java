package dev.cyjin.mcprelay.input;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Base64;
import java.nio.charset.StandardCharsets;

/** Reports only the app-owned test activity's hashes, counters, and geometry. */
public final class ProbeReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!isOrderedBroadcast() || !"dev.cyjin.mcprelay.input.PROBE_STATUS".equals(intent.getAction())) return;
        try {
            String payload = Base64.encodeToString(ProbeActivity.status().toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            setResultCode(-1);
            setResultData("relay-probe:" + payload);
        } catch (Exception error) {
            setResultCode(40);
            setResultData("relay-probe:not_foreground");
        }
    }
}
