package dev.cyjin.mcprelay.input;

import android.inputmethodservice.InputMethodService;
import java.lang.ref.WeakReference;

/** A temporary, headless IME. No network, clipboard, history, or surrounding-text reads. */
public final class RelayInputService extends InputMethodService {
    private static WeakReference<RelayInputService> active = new WeakReference<>(null);

    @Override public void onCreate() {
        super.onCreate();
        active = new WeakReference<>(this);
    }

    @Override public void onDestroy() {
        if (active.get() == this) active.clear();
        super.onDestroy();
    }

    static RelayInputService active() { return active.get(); }
    @Override public boolean onEvaluateFullscreenMode() { return false; }
    @Override public boolean onEvaluateInputViewShown() { return false; }
}
