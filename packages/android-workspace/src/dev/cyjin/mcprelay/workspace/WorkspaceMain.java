package dev.cyjin.mcprelay.workspace;

import android.content.ComponentName;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Display;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.*;
import java.lang.reflect.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Root-only Android 14+ private display owner.
 *
 * The binder token belongs to this process. EOF, an independent monotonic lease,
 * and a fixed hard deadline all revoke input and move tasks before releasing it.
 * DESTROY_CONTENT_ON_REMOVAL is deliberately absent: binder death also returns
 * content to the default display instead of destroying the applications.
 * No clipboard service, IME selection, default-display injection, or global key
 * is used. This helper never adopts an existing task from another display.
 */
public final class WorkspaceMain {
    private static final String PREFIX = "mcp-relay-workspace:";
    private static final long MAX_LEASE_MS = 900_000L;
    private static final long MAX_HARD_MS = 86_400_000L;
    private static final int REQUIRED_DISPLAY_FLAGS = (1 << 7) | (1 << 11) | (1 << 12);
    private static final int CREATE_FLAGS = 1 | 2 | 8 | (1 << 6) | (1 << 7) | (1 << 10) | (1 << 11) | (1 << 14) | (1 << 16);
    private static final Object OUTPUT = new Object();
    private final Object inputLock = new Object();
    private final Object frameLock = new Object();
    private final Object launchLock = new Object();
    private volatile Process launchProcess;
    private final AtomicBoolean closing = new AtomicBoolean(false);
    private volatile boolean inputAllowed = false;
    private volatile long expiresElapsed;
    private volatile long lastHeartbeatElapsed;
    private final ExecutorService actions = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<Runnable>(16), r -> new Thread(r, "relay-workspace-actions"));
    private volatile long closeStarted;
    private long hardElapsed;
    private String leaseId, instanceId, displayName;
    private File receipt;
    private File revocation;
    private int width, height, displayId = -1;
    private String uniqueId;
    private DisplayManager displays;
    private VirtualDisplay virtualDisplay;
    private ImageReader reader;
    private HandlerThread frameThread;
    private Bitmap latestFrame;
    private Object inputManager, taskManager, windowManager;
    private Method injectMethod, setDisplayMethod, rootTasksMethod, moveTaskMethod, getImePolicyMethod, setImePolicyMethod, syncInputMethod;
    private final Set<Integer> heldKeys = new HashSet<>();
    private boolean touchDown;
    private float touchX, touchY;
    private long touchDownTime;
    private volatile JSONObject finalReceipt;
    private String closeReason = "unknown";

    public static void main(String[] args) {
        WorkspaceMain owner = new WorkspaceMain();
        try {
            owner.initializeServices();
            if (args.length == 1 && "--probe".equals(args[0])) {
                emit(owner.capabilities());
                return;
            }
            if (args.length == 2 && "--find".equals(args[0])) {
                emit(owner.find(args[1]));
                return;
            }
            if (args.length == 2 && "--recover".equals(args[0])) {
                emit(owner.recover(new File(args[1])));
                return;
            }
            if (args.length != 3 || !"--owner".equals(args[0])) throw new IllegalArgumentException("Missing private owner identity");
            JSONObject options = new JSONObject(readBoundedLine(System.in, 64 * 1024));
            if (!args[1].equals(options.getString("leaseId")) || !args[2].equals(options.getString("instanceId"))) throw new IllegalArgumentException("Owner identity mismatch");
            owner.open(options);
            owner.listen();
        } catch (Throwable failure) {
            emit(error("startup", failure));
            if (owner.receipt != null || owner.virtualDisplay != null) {
                owner.requestClose("startup_failed");
                owner.awaitClose();
            } else System.exit(1);
        }
    }

    private void initializeServices() throws Exception {
        if (Build.VERSION.SDK_INT < 34) throw new IllegalStateException("Android 14 or later is required");
        if (android.os.Process.myUid() != 0) throw new SecurityException("root app_process is required");
        if (Looper.getMainLooper() == null) Looper.prepareMainLooper();
        Class<?> at = Class.forName("android.app.ActivityThread");
        Object thread = at.getMethod("systemMain").invoke(null);
        Context context = (Context) at.getMethod("getSystemContext").invoke(thread);
        displays = (DisplayManager) context.getSystemService(Context.DISPLAY_SERVICE);
        Class<?> im = Class.forName("android.hardware.input.InputManager");
        inputManager = im.getMethod("getInstance").invoke(null);
        injectMethod = im.getMethod("injectInputEvent", InputEvent.class, int.class);
        setDisplayMethod = InputEvent.class.getMethod("setDisplayId", int.class);
        taskManager = Class.forName("android.app.ActivityTaskManager").getMethod("getService").invoke(null);
        Class<?> tm = Class.forName("android.app.IActivityTaskManager");
        rootTasksMethod = tm.getMethod("getAllRootTaskInfos");
        moveTaskMethod = tm.getMethod("moveRootTaskToDisplay", int.class, int.class);
        windowManager = Class.forName("android.view.WindowManagerGlobal").getMethod("getWindowManagerService").invoke(null);
        Class<?> wm = Class.forName("android.view.IWindowManager");
        getImePolicyMethod = wm.getMethod("getDisplayImePolicy", int.class);
        setImePolicyMethod = wm.getMethod("setDisplayImePolicy", int.class, int.class);
        syncInputMethod = wm.getMethod("syncInputTransactions", boolean.class);
        requireFlag(Display.class, "FLAG_TRUSTED", 1 << 7);
        requireFlag(Display.class, "REMOVE_MODE_MOVE_CONTENT_TO_PRIMARY", 0);
        Display.class.getMethod("getRemoveMode");
        requireFlag(Display.class, "FLAG_OWN_FOCUS", 1 << 11);
        requireFlag(Display.class, "FLAG_STEAL_TOP_FOCUS_DISABLED", 1 << 12);
        requireFlag(DisplayManager.class, "VIRTUAL_DISPLAY_FLAG_OWN_FOCUS", 1 << 14);
        requireFlag(DisplayManager.class, "VIRTUAL_DISPLAY_FLAG_STEAL_TOP_FOCUS_DISABLED", 1 << 16);
    }

    private static void requireFlag(Class<?> type, String name, int value) throws Exception {
        if (type.getField(name).getInt(null) != value) throw new IllegalStateException("Unsupported Android flag: " + name);
    }

    private JSONObject capabilities() throws Exception {
        return new JSONObject().put("event", "probe").put("available", true).put("sdk", Build.VERSION.SDK_INT)
            .put("root", true).put("unicodeText", false).put("independentWatchdog", true)
            .put("maxLeaseMs", MAX_LEASE_MS).put("maxHardMs", MAX_HARD_MS);
    }

    private JSONObject find(String name) throws Exception {
        if (!name.matches("mcp-relay-workspace:[A-Za-z0-9_-]{8,100}:[A-Za-z0-9_-]{8,100}")) {
            throw new IllegalArgumentException("Invalid owned display name");
        }
        JSONArray matches = new JSONArray();
        for (Display display : displays.getDisplays()) {
            if (name.equals(display.getName())) matches.put(displayInfo(display));
        }
        return new JSONObject().put("event", "find").put("displays", matches);
    }

    private JSONObject recover(File saved) throws Exception {
        if (!saved.isAbsolute()) throw new IllegalArgumentException("Invalid receipt path");
        JSONObject state;
        try (FileInputStream input = new FileInputStream(saved)) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            copyBounded(input, bytes, 64 * 1024);
            state = new JSONObject(bytes.toString("UTF-8"));
        }
        String lease = identifier(state.getString("leaseId"));
        String instance = identifier(state.getString("instanceId"));
        if (!saved.getName().equals("android-" + instance + ".json")) throw new IllegalArgumentException("Receipt owner mismatch");
        String name = PREFIX + lease + ":" + instance;
        if (!name.equals(state.getString("displayName"))) throw new IllegalArgumentException("Receipt display mismatch");
        int pid = state.getInt("pid");
        String startTicks = state.getString("processStartTicks");
        if (pid <= 1 || pid == android.os.Process.myPid() || !startTicks.matches("[0-9]+")) throw new IllegalArgumentException("Invalid native process identity");
        boolean matching = matchingOwner(pid, startTicks, lease, instance);
        boolean emergencySignal = false;
        if (matching) {
            // app_process does not reliably execute Java shutdown hooks on SIGTERM.
            // The permanent fence lets the independent owner perform ordered cleanup first.
            File fence = new File(saved.getParentFile(), "revoked.json");
            if (fence.createNewFile()) {
                try (FileOutputStream output = new FileOutputStream(fence)) {
                    output.write(new JSONObject().put("schema", 1).put("leaseId", lease).put("reason", "native_recovery")
                        .put("revokedAt", System.currentTimeMillis()).toString().getBytes(StandardCharsets.UTF_8));
                    output.getFD().sync();
                }
            }
            long until = SystemClock.elapsedRealtime() + 10_500L;
            while (matchingOwner(pid, startTicks, lease, instance) && SystemClock.elapsedRealtime() < until) SystemClock.sleep(50);
            // Last-resort binder death for this exact PID/start time/lease process only.
            if (matchingOwner(pid, startTicks, lease, instance)) {
                emergencySignal = true;
                android.os.Process.sendSignal(pid, 15);
                SystemClock.sleep(250);
                if (matchingOwner(pid, startTicks, lease, instance)) android.os.Process.killProcess(pid);
            }
        }
        long until = SystemClock.elapsedRealtime() + 2500L;
        JSONArray remaining;
        do {
            remaining = find(name).getJSONArray("displays");
            if (remaining.length() == 0) break;
            SystemClock.sleep(25);
        } while (SystemClock.elapsedRealtime() < until);
        boolean revoked = !matchingOwner(pid, startTicks, lease, instance);
        boolean removed = remaining.length() == 0;
        return new JSONObject().put("event", "recovered").put("leaseId", lease).put("instanceId", instance)
            .put("inputRevoked", revoked).put("ownedDisplayRemoved", removed).put("complete", revoked && removed)
            .put("matchedOwnerProcess", matching).put("emergencySignal", emergencySignal);
    }

    private static boolean matchingOwner(int pid, String startTicks, String lease, String instance) {
        try {
            String line;
            try (BufferedReader input = new BufferedReader(new FileReader("/proc/" + pid + "/stat"))) { line = input.readLine(); }
            if (!startTicks.equals(line.substring(line.lastIndexOf(')') + 2).split(" ")[19])) return false;
            byte[] bytes;
            try (FileInputStream input = new FileInputStream("/proc/" + pid + "/cmdline")) {
                ByteArrayOutputStream value = new ByteArrayOutputStream();
                copyBounded(input, value, 64 * 1024);
                bytes = value.toByteArray();
            }
            String cmdline = new String(bytes, StandardCharsets.UTF_8);
            String marker = "dev.cyjin.mcprelay.workspace.WorkspaceMain\0--owner\0" + lease + "\0" + instance + "\0";
            return cmdline.endsWith(marker);
        } catch (Throwable ignored) { return false; }
    }

    private void open(JSONObject options) throws Exception {
        leaseId = identifier(options.getString("leaseId"));
        instanceId = identifier(options.getString("instanceId"));
        displayName = PREFIX + leaseId + ":" + instanceId;
        width = options.getInt("width");
        height = options.getInt("height");
        if (width < 64 || height < 64 || width > 4096 || height > 4096 || (long) width * height > 4_194_304L) {
            throw new IllegalArgumentException("Display must be 64..4096 pixels per axis and at most 4 megapixels");
        }
        long ttl = options.getLong("ttlMs"), hardTtl = options.getLong("hardTtlMs");
        if (ttl < 1 || ttl > MAX_LEASE_MS || hardTtl < ttl || hardTtl > MAX_HARD_MS) throw new IllegalArgumentException("Invalid lease deadline");
        long now = SystemClock.elapsedRealtime();
        expiresElapsed = now + ttl;
        lastHeartbeatElapsed = now;
        hardElapsed = now + hardTtl;
        receipt = new File(options.getString("receipt"));
        if (!receipt.isAbsolute() || !receipt.getName().equals("android-" + instanceId + ".json")) {
            throw new IllegalArgumentException("Invalid private receipt path");
        }
        revocation = new File(options.getString("revocationPath"));
        if (!revocation.getCanonicalFile().equals(new File(receipt.getParentFile(), "revoked.json").getCanonicalFile())) throw new IllegalArgumentException("Revocation fence must be in the private lease directory");
        if (revocation.exists()) throw new IllegalStateException("Workspace was already revoked");
        writeReceipt("preparing", null);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            requestClose("process_exit");
            awaitClose();
        }, "relay-workspace-shutdown"));
        Thread watchdog = new Thread(() -> {
            while (true) {
                long tick = SystemClock.elapsedRealtime();
                if (!closing.get() && (tick >= expiresElapsed || tick >= hardElapsed)) requestClose("lease_expired");
                if (!closing.get() && tick - lastHeartbeatElapsed >= 15_000L) requestClose("owner_heartbeat_lost");
                if (!closing.get() && revocation != null && revocation.exists()) requestClose("revoked");
                if (closing.get() && finalReceipt != null) return;
                if (closing.get() && closeStarted > 0 && tick - closeStarted > 10_000L) {
                    // Killing only this token owner invokes Android's binder-death cleanup.
                    android.os.Process.killProcess(android.os.Process.myPid());
                    return;
                }
                SystemClock.sleep(50);
            }
        }, "relay-workspace-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();

        frameThread = new HandlerThread("relay-workspace-frames");
        frameThread.start();
        Handler handler = new Handler(frameThread.getLooper());
        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
        reader.setOnImageAvailableListener(r -> acceptFrame(r), handler);
        checkAlive();
        virtualDisplay = displays.createVirtualDisplay(displayName, width, height, 160, reader.getSurface(), CREATE_FLAGS);
        if (virtualDisplay == null) throw new IllegalStateException("Virtual display creation failed");
        Display display = virtualDisplay.getDisplay();
        displayId = display.getDisplayId();
        uniqueId = uniqueId(display);
        if (displayId <= 0 || (display.getFlags() & REQUIRED_DISPLAY_FLAGS) != REQUIRED_DISPLAY_FLAGS || removeMode(display) != 0) {
            throw new IllegalStateException("Android did not retain the required independent-focus flags");
        }
        // This is per-display policy. Never change the selected/enabled global IME.
        setImePolicyMethod.invoke(windowManager, displayId, 2 /* DISPLAY_IME_POLICY_HIDE */);
        if (((Integer) getImePolicyMethod.invoke(windowManager, displayId)) != 2) {
            throw new IllegalStateException("Cannot hide IME on owned display");
        }
        checkAlive();
        inputAllowed = true;
        writeReceipt("active", null);
        emit(new JSONObject().put("event", "ready").put("leaseId", leaseId).put("instanceId", instanceId)
            .put("pid", android.os.Process.myPid()).put("display", displayInfo(display)).put("imePolicy", 2));
    }

    private void acceptFrame(ImageReader source) {
        Image image = null;
        try {
            image = source.acquireLatestImage();
            if (image == null || closing.get()) return;
            Image.Plane plane = image.getPlanes()[0];
            int pixelStride = plane.getPixelStride();
            int rowStride = plane.getRowStride();
            if (pixelStride != 4 || rowStride < width * pixelStride) return;
            int paddedWidth = rowStride / pixelStride;
            Bitmap padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888);
            ByteBuffer buffer = plane.getBuffer();
            padded.copyPixelsFromBuffer(buffer);
            Bitmap bitmap = paddedWidth == width ? padded : Bitmap.createBitmap(padded, 0, 0, width, height);
            if (bitmap != padded) padded.recycle();
            synchronized (frameLock) {
                if (latestFrame != null) latestFrame.recycle();
                latestFrame = bitmap;
                frameLock.notifyAll();
            }
        } catch (Throwable ignored) {
            // A later capture reports no frame; never switch to the physical display.
        } finally {
            if (image != null) image.close();
        }
    }

    private void listen() throws Exception {
        while (!closing.get()) {
            String line = readBoundedLine(System.in, 128 * 1024);
            if (line == null) { requestClose("owner_eof"); break; }
            String id = "?";
            try {
                JSONObject request = new JSONObject(line);
                id = request.getString("id");
                if (!id.matches("[A-Za-z0-9_-]{1,100}")) throw new IllegalArgumentException("Invalid request id");
                String op = request.getString("op");
                if ("close".equals(op)) { requestClose("explicit"); break; }
                checkAlive();
                if ("renew".equals(op)) {
                    long ttl = request.getLong("ttlMs");
                    if (ttl < 1 || ttl > MAX_LEASE_MS) throw new IllegalArgumentException("Invalid lease duration");
                    long now = SystemClock.elapsedRealtime();
                    expiresElapsed = Math.min(hardElapsed, now + ttl);
                    lastHeartbeatElapsed = now;
                    emit(new JSONObject().put("id", id).put("ok", true).put("result",
                        new JSONObject().put("remainingMs", expiresElapsed - now)));
                } else {
                    final String requestId = id;
                    // Renew/close remains responsive while a gesture or app launch is running.
                    actions.execute(() -> executeRequest(requestId, op, request));
                }
            } catch (Throwable failure) { emit(error(id, failure)); }
        }
        awaitClose();
    }

    private void executeRequest(String id, String op, JSONObject request) {
        try {
            checkAlive();
            JSONObject result;
            switch (op) {
                case "inspect": result = inspect(); break;
                case "capture": result = capture(); break;
                case "act":
                    syncInputMethod.invoke(windowManager, false);
                    checkAlive();
                    String expectedApp = request.optString("expectedAppId", "");
                    if (!expectedApp.isEmpty() && !expectedApp.equals(ownedAppId())) throw new IllegalStateException("The workspace foreground application changed");
                    result = act(request.getJSONObject("action")); break;
                case "launch": result = launch(request.getString("component")); break;
                default: throw new IllegalArgumentException("Unsupported command: " + op);
            }
            emit(new JSONObject().put("id", id).put("ok", true).put("result", result));
        } catch (Throwable failure) { emit(error(id, failure)); }
    }

    private JSONObject inspect() throws Exception {
        Display display = ownedDisplay();
        return new JSONObject().put("display", displayInfo(display)).put("imePolicy", getImePolicyMethod.invoke(windowManager, displayId))
            .put("remainingMs", Math.max(0, expiresElapsed - SystemClock.elapsedRealtime()))
            .put("inputAllowed", inputAllowed).put("tasks", ownedTasks()).put("appId", ownedAppId());
    }

    private JSONObject capture() throws Exception {
        ownedDisplay();
        long end = Math.min(expiresElapsed, SystemClock.elapsedRealtime() + 2000);
        synchronized (frameLock) {
            while (latestFrame == null && !closing.get() && SystemClock.elapsedRealtime() < end) frameLock.wait(50);
            checkAlive();
            if (latestFrame == null) throw new IllegalStateException("Owned display has not produced a frame");
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            latestFrame.compress(Bitmap.CompressFormat.PNG, 100, buffer);
            return new JSONObject().put("mimeType", "image/png").put("width", width).put("height", height)
                .put("base64", java.util.Base64.getEncoder().encodeToString(buffer.toByteArray()))
                .put("displayId", displayId).put("appId", ownedAppId());
        }
    }

    private JSONObject act(JSONObject action) throws Exception {
        String type = action.getString("type");
        if ("click".equals(type)) {
            if (!"left".equals(action.optString("button", "left"))) throw new IllegalArgumentException("Only touch/left click is supported");
            float x = coordinate(action.getDouble("x"), width), y = coordinate(action.getDouble("y"), height);
            int count = action.optInt("clicks", 1);
            if (count < 1 || count > 3) throw new IllegalArgumentException("Invalid click count");
            for (int n = 0; n < count; n++) { touch(MotionEvent.ACTION_DOWN, x, y, false); SystemClock.sleep(25); touch(MotionEvent.ACTION_UP, x, y, false); }
        } else if ("drag".equals(type)) {
            gesture(coordinate(action.getDouble("fromX"), width), coordinate(action.getDouble("fromY"), height),
                coordinate(action.getDouble("toX"), width), coordinate(action.getDouble("toY"), height),
                action.optLong("durationMs", 300));
        } else if ("scroll".equals(type)) {
            float x = coordinate(action.optDouble("x", width / 2.0), width), y = coordinate(action.optDouble("y", height / 2.0), height);
            int amount = action.optInt("amount", 3);
            if (amount < 1 || amount > 100) throw new IllegalArgumentException("Invalid scroll amount");
            float distance = Math.min(Math.min(width, height) * 0.65f, amount * 48f), dx = 0, dy = 0;
            switch (action.getString("direction")) {
                case "down": dy = -distance; break;
                case "up": dy = distance; break;
                case "right": dx = -distance; break;
                case "left": dx = distance; break;
                default: throw new IllegalArgumentException("Invalid direction");
            }
            gesture(x, y, Math.max(1, Math.min(width - 2, x + dx)), Math.max(1, Math.min(height - 2, y + dy)), 250);
        } else if ("key".equals(type)) {
            JSONArray values = action.getJSONArray("keys");
            if (values.length() < 1 || values.length() > 6) throw new IllegalArgumentException("Invalid key chord");
            List<Integer> codes = new ArrayList<>();
            for (int i = 0; i < values.length(); i++) codes.add(keyCode(values.getString(i)));
            if (codes.contains(113) && (codes.contains(KeyEvent.KEYCODE_C) || codes.contains(KeyEvent.KEYCODE_X) || codes.contains(KeyEvent.KEYCODE_V))) {
                throw new IllegalArgumentException("Clipboard shortcuts are unavailable in private workspaces");
            }
            if (codes.contains(113)) {
                Set<Integer> editing = new HashSet<>(Arrays.asList(KeyEvent.KEYCODE_A, KeyEvent.KEYCODE_Z,
                    KeyEvent.KEYCODE_Y, KeyEvent.KEYCODE_F, 19, 20, 21, 22, 122, 123, 67, 112));
                int nonModifiers = 0;
                for (int code : codes) {
                    if (code == 113 || code == 59) continue;
                    if (!editing.contains(code)) throw new IllegalArgumentException("Global/IME keyboard shortcuts are unavailable");
                    nonModifiers++;
                }
                if (nonModifiers != 1) throw new IllegalArgumentException("Only a single app editing key can accompany Ctrl");
            }
            int meta = 0;
            try {
                for (int code : codes) { meta |= modifier(code); key(KeyEvent.ACTION_DOWN, code, meta, false); }
            } finally {
                for (int i = codes.size() - 1; i >= 0; i--) { key(KeyEvent.ACTION_UP, codes.get(i), meta, true); meta &= ~modifier(codes.get(i)); }
            }
        } else if ("text".equals(type)) {
            String text = action.getString("text");
            if (text.length() > 4096 || !text.matches("[\\x20-\\x7E\\r\\n\\t]*")) throw new IllegalArgumentException("Private workspace text supports ASCII keyboard characters only; Unicode requires a display-scoped input method");
            KeyEvent[] events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray());
            if (events == null) throw new IllegalArgumentException("Text cannot be mapped to private keyboard events");
            try {
                for (KeyEvent event : events) key(event.getAction(), event.getKeyCode(), event.getMetaState(), false);
            } finally { releaseInput(); }
        } else throw new IllegalArgumentException("Unsupported private touch action: " + type);
        return new JSONObject().put("displayId", displayId).put("performed", type);
    }

    private static float coordinate(double value, int limit) {
        if (Double.isNaN(value) || Double.isInfinite(value) || value < 0 || value >= limit) throw new IllegalArgumentException("Coordinate is outside the owned display");
        return (float) value;
    }

    private void gesture(float x0, float y0, float x1, float y1, long duration) throws Exception {
        if (duration < 1 || duration > 5000) throw new IllegalArgumentException("Gesture duration must be 1..5000 ms");
        touch(MotionEvent.ACTION_DOWN, x0, y0, false);
        try {
            int steps = Math.max(1, (int) (duration / 16));
            for (int i = 1; i <= steps; i++) {
                SystemClock.sleep(duration / steps);
                touch(MotionEvent.ACTION_MOVE, x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, false);
            }
        } finally { touch(MotionEvent.ACTION_UP, x1, y1, true); }
    }

    private void touch(int action, float x, float y, boolean releasing) throws Exception {
        synchronized (inputLock) {
            if (!releasing) requireInput();
            if (displayId < 1 || (releasing && !touchDown)) return;
            long now = SystemClock.uptimeMillis();
            if (action == MotionEvent.ACTION_DOWN) touchDownTime = now;
            MotionEvent event = MotionEvent.obtain(touchDownTime, now, action, x, y, 0);
            event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            try {
                setDisplayMethod.invoke(event, displayId);
                if (!(Boolean) injectMethod.invoke(inputManager, event, 2)) throw new IllegalStateException("Owned-display touch injection was rejected");
                touchDown = action != MotionEvent.ACTION_UP && action != MotionEvent.ACTION_CANCEL;
                touchX = x; touchY = y;
            } finally { event.recycle(); }
        }
    }

    private void key(int action, int code, int meta, boolean releasing) throws Exception {
        synchronized (inputLock) {
            if (!releasing) requireInput();
            if (displayId < 1 || (releasing && !heldKeys.contains(code))) return;
            long now = SystemClock.uptimeMillis();
            KeyEvent event = new KeyEvent(now, now, action, code, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD);
            setDisplayMethod.invoke(event, displayId);
            if (!(Boolean) injectMethod.invoke(inputManager, event, 2)) throw new IllegalStateException("Owned-display keyboard injection was rejected");
            if (action == KeyEvent.ACTION_DOWN) heldKeys.add(code); else heldKeys.remove(code);
        }
    }

    private static int keyCode(String name) {
        String key = name.toUpperCase(Locale.ROOT).replace("KEY_", "");
        Map<String, Integer> allowed = new HashMap<>();
        allowed.put("ENTER", 66); allowed.put("RETURN", 66); allowed.put("TAB", 61);
        allowed.put("ESC", 111); allowed.put("ESCAPE", 111); allowed.put("BACKSPACE", 67);
        allowed.put("DELETE", 112); allowed.put("SPACE", 62);
        allowed.put("LEFT", 21); allowed.put("ARROWLEFT", 21); allowed.put("RIGHT", 22); allowed.put("ARROWRIGHT", 22);
        allowed.put("UP", 19); allowed.put("ARROWUP", 19); allowed.put("DOWN", 20); allowed.put("ARROWDOWN", 20);
        allowed.put("HOME", 122); allowed.put("END", 123); allowed.put("PAGEUP", 92); allowed.put("PAGEDOWN", 93);
        allowed.put("CTRL", 113); allowed.put("CONTROL", 113); allowed.put("SHIFT", 59);
        Integer code = allowed.get(key);
        if (code != null) return code;
        if (key.matches("[A-Z]")) return KeyEvent.KEYCODE_A + key.charAt(0) - 'A';
        if (key.matches("[0-9]")) return KeyEvent.KEYCODE_0 + key.charAt(0) - '0';
        throw new IllegalArgumentException("Key is not display-scoped or is unsupported: " + name);
    }

    private static int modifier(int code) {
        if (code == 113) return KeyEvent.META_CTRL_ON | KeyEvent.META_CTRL_LEFT_ON;
        if (code == 59) return KeyEvent.META_SHIFT_ON | KeyEvent.META_SHIFT_LEFT_ON;
        if (code == 57) return KeyEvent.META_ALT_ON | KeyEvent.META_ALT_LEFT_ON;
        return 0;
    }

    private JSONObject launch(String componentText) throws Exception {
        requireInput();
        if (!componentText.matches("[A-Za-z][A-Za-z0-9_.]*/[A-Za-z0-9_.$]+")) throw new IllegalArgumentException("Use an explicit Android package/Activity component");
        ComponentName component = ComponentName.unflattenFromString(componentText);
        if (component == null) throw new IllegalArgumentException("Invalid Android component");
        String packageName = component.getPackageName();
        for (Object task : rootTasks()) {
            if (fieldInt(task, "displayId") == displayId) continue;
            String[] childNames = (String[]) task.getClass().getField("childTaskNames").get(task);
            if (childNames != null) for (String name : childNames) {
                if (name != null && (name.startsWith(packageName + "/") || name.startsWith(packageName + "."))) {
                    throw new IllegalStateException("Application already has a task on another display; refusing to move an existing user task");
                }
            }
            for (String name : new String[] { "topActivity", "baseActivity" }) {
                ComponentName value = (ComponentName) task.getClass().getField(name).get(task);
                if (value != null && packageName.equals(value.getPackageName())) throw new IllegalStateException("Application is already open outside this workspace");
            }
        }
        requireInput();
        Process process;
        synchronized (launchLock) {
            requireInput();
            if (Math.min(expiresElapsed, hardElapsed) - SystemClock.elapsedRealtime() < 9000) throw new IllegalStateException("At least nine seconds of lease are required before launching an application");
            process = new ProcessBuilder("/system/bin/am", "start", "-W", "--user", "current", "--display", String.valueOf(displayId),
                "-n", componentText, "-f", "0x18000000").redirectErrorStream(true).start();
            launchProcess = process;
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        Thread drain = new Thread(() -> {
            try { copyBounded(process.getInputStream(), output, 64 * 1024); } catch (IOException ignored) { }
        }, "relay-workspace-launch-output");
        drain.setDaemon(true); drain.start();
        if (!process.waitFor(8, TimeUnit.SECONDS)) { process.destroy(); throw new IllegalStateException("Application launch timed out"); }
        drain.join(500);
        synchronized (launchLock) { if (launchProcess == process) launchProcess = null; }
        String text = new String(output.toByteArray(), StandardCharsets.UTF_8);
        requireInput();
        if (process.exitValue() != 0 || text.contains("Error:") || text.contains("Exception")) throw new IllegalStateException("Application launch failed: " + text.trim());
        // am start -W waits for launch reporting, not necessarily InputDispatcher focus.
        // Flush window transactions before the first key; never retry a possibly-applied input.
        syncInputMethod.invoke(windowManager, true);
        requireInput();
        writeReceipt("active", null);
        return new JSONObject().put("displayId", displayId).put("component", componentText).put("tasks", ownedTasks());
    }

    private void requireInput() throws Exception {
        checkAlive();
        if (!inputAllowed) throw new IllegalStateException("Workspace input is revoked");
        ownedDisplay();
        if (((Integer) getImePolicyMethod.invoke(windowManager, displayId)) != 2) {
            requestClose("isolation_lost");
            throw new IllegalStateException("Owned display lost its hidden IME policy");
        }
    }

    private void checkAlive() {
        if (revocation != null && revocation.exists()) { requestClose("revoked"); throw new IllegalStateException("Workspace has been permanently revoked"); }
        if (closing.get() || SystemClock.elapsedRealtime() >= expiresElapsed || SystemClock.elapsedRealtime() >= hardElapsed) {
            throw new IllegalStateException("Workspace lease has expired or is closing");
        }
    }

    private Display ownedDisplay() throws Exception {
        if (displayId <= 0) throw new IllegalStateException("No owned virtual display");
        Display display = displays.getDisplay(displayId);
        if (display == null || !displayName.equals(display.getName()) || !Objects.equals(uniqueId, uniqueId(display))) {
            throw new IllegalStateException("Owned display is gone or its identity changed");
        }
        if ((display.getFlags() & REQUIRED_DISPLAY_FLAGS) != REQUIRED_DISPLAY_FLAGS || removeMode(display) != 0) throw new IllegalStateException("Owned display lost its isolation or content-preservation policy");
        return display;
    }

    @SuppressWarnings("unchecked")
    private List<Object> rootTasks() throws Exception {
        return (List<Object>) rootTasksMethod.invoke(taskManager);
    }

    private String ownedAppId() throws Exception {
        String result = null;
        for (Object task : rootTasks()) {
            if (fieldInt(task, "displayId") != displayId) continue;
            boolean visible = task.getClass().getField("isVisible").getBoolean(task);
            if (!visible) continue;
            ComponentName top = (ComponentName) task.getClass().getField("topActivity").get(task);
            if (top == null) continue;
            if (result != null) return null;
            result = top.getPackageName();
        }
        return result;
    }

    private JSONArray ownedTasks() throws Exception {
        JSONArray result = new JSONArray();
        for (Object task : rootTasks()) if (fieldInt(task, "displayId") == displayId) {
            result.put(new JSONObject().put("rootTaskId", fieldInt(task, "taskId")));
        }
        return result;
    }

    private void releaseInput() {
        synchronized (inputLock) {
            try { if (touchDown) touch(MotionEvent.ACTION_CANCEL, touchX, touchY, true); } catch (Throwable ignored) { }
            for (int code : new HashSet<>(heldKeys)) try { key(KeyEvent.ACTION_UP, code, 0, true); } catch (Throwable ignored) { }
            heldKeys.clear(); touchDown = false;
        }
    }

    private void requestClose(String reason) {
        if (!closing.compareAndSet(false, true)) return;
        inputAllowed = false;
        actions.shutdownNow();
        closeStarted = SystemClock.elapsedRealtime();
        closeReason = reason;
        Thread cleanup = new Thread(() -> {
            JSONArray moved = new JSONArray(), errors = new JSONArray();
            boolean removed = displayId < 1;
            releaseInput();
            // Let an already-issued start transaction settle before removing its target display.
            // Pending launches were rejected by inputAllowed=false and actions.shutdownNow().
            synchronized (launchLock) {
                Process pending = launchProcess;
                if (pending != null) {
                    try { if (!pending.waitFor(8, TimeUnit.SECONDS)) pending.destroy(); }
                    catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); pending.destroy(); }
                    launchProcess = null;
                }
            }
            try { writeReceipt("restoring", null); } catch (Throwable failure) { errors.put(message(failure)); }
            if (displayId > 0 && virtualDisplay != null) {
                try {
                    Display present = displays.getDisplay(displayId);
                    if (present != null && displayName.equals(present.getName()) && Objects.equals(uniqueId, uniqueId(present))) {
                        for (Object task : rootTasks()) {
                            if (fieldInt(task, "displayId") != displayId) continue;
                            int taskId = fieldInt(task, "taskId");
                            try { moveTaskMethod.invoke(taskManager, taskId, Display.DEFAULT_DISPLAY); moved.put(taskId); }
                            catch (Throwable failure) { errors.put("task " + taskId + ": " + message(failure)); }
                        }
                    }
                } catch (Throwable failure) { errors.put(message(failure)); }
                try { virtualDisplay.release(); } catch (Throwable failure) { errors.put(message(failure)); }
                long until = SystemClock.elapsedRealtime() + 2000;
                do {
                    Display remaining = displays.getDisplay(displayId);
                    removed = remaining == null || !Objects.equals(uniqueId, uniqueId(remaining));
                    if (!removed) SystemClock.sleep(25);
                } while (!removed && SystemClock.elapsedRealtime() < until);
            }
            try { if (reader != null) reader.close(); } catch (Throwable ignored) { }
            if (frameThread != null) frameThread.quitSafely();
            synchronized (frameLock) { if (latestFrame != null) latestFrame.recycle(); latestFrame = null; frameLock.notifyAll(); }
            try {
                JSONObject result = new JSONObject().put("event", "closed").put("leaseId", leaseId).put("instanceId", instanceId)
                    .put("reason", closeReason).put("inputRevoked", true).put("ownedDisplayRemoved", removed)
                    .put("complete", removed).put("movedRootTasks", moved).put("errors", errors);
                writeReceipt(removed ? "closed" : "cleanup_pending", result);
                finalReceipt = result;
                emit(result);
            } catch (Throwable failure) { emit(error("cleanup", failure)); }
            // The main thread may still be blocked in stdin. Exit only this owner.
            System.exit(removed ? 0 : 2);
        }, "relay-workspace-cleanup");
        cleanup.setDaemon(false);
        cleanup.start();
    }

    private void awaitClose() {
        long until = SystemClock.elapsedRealtime() + 11_000;
        while (finalReceipt == null && SystemClock.elapsedRealtime() < until) SystemClock.sleep(25);
    }

    private JSONObject displayInfo(Display display) throws Exception {
        return new JSONObject().put("id", display.getDisplayId()).put("uniqueId", uniqueId(display))
            .put("name", display.getName()).put("flags", display.getFlags()).put("removeMode", removeMode(display)).put("width", width).put("height", height);
    }

    private void writeReceipt(String phase, JSONObject result) throws Exception {
        if (receipt == null) return;
        JSONObject state = new JSONObject().put("version", 1).put("phase", phase).put("leaseId", leaseId).put("instanceId", instanceId)
            .put("pid", android.os.Process.myPid()).put("processStartTicks", processStartTicks())
            .put("displayId", displayId).put("displayName", displayName).put("displayUniqueId", uniqueId)
            .put("width", width).put("height", height).put("inputRevoked", !inputAllowed);
        if (result != null) state.put("result", result);
        File temporary = new File(receipt.getPath() + ".next");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(state.toString().getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        if (!temporary.renameTo(receipt)) throw new IOException("Cannot publish private helper receipt");
    }

    private static String processStartTicks() throws IOException {
        String line;
        try (BufferedReader input = new BufferedReader(new FileReader("/proc/self/stat"))) { line = input.readLine(); }
        String[] fields = line.substring(line.lastIndexOf(')') + 2).split(" ");
        return fields[19];
    }

    private static int removeMode(Display display) {
        try { return (Integer) Display.class.getMethod("getRemoveMode").invoke(display); }
        catch (ReflectiveOperationException failure) { throw new IllegalStateException("Cannot verify display content-preservation policy", failure); }
    }
    private static String uniqueId(Display display) {
        try { return (String) Display.class.getMethod("getUniqueId").invoke(display); }
        catch (ReflectiveOperationException failure) { throw new IllegalStateException("Cannot verify display identity", failure); }
    }
    private static int fieldInt(Object object, String name) throws Exception { return object.getClass().getField(name).getInt(object); }
    private static String identifier(String text) {
        if (!text.matches("[A-Za-z0-9_-]{8,100}")) throw new IllegalArgumentException("Invalid workspace identifier");
        return text;
    }
    private static void emit(JSONObject value) {
        synchronized (OUTPUT) { System.out.println(value.toString()); System.out.flush(); }
    }
    private static JSONObject error(String id, Throwable error) {
        JSONObject result = new JSONObject();
        try { result.put("id", id).put("ok", false).put("error", message(error)); } catch (Exception ignored) { }
        return result;
    }
    private static String message(Throwable failure) {
        while (failure instanceof InvocationTargetException && failure.getCause() != null) failure = failure.getCause();
        return failure.getClass().getSimpleName() + ": " + String.valueOf(failure.getMessage());
    }
    private static String readBoundedLine(InputStream input, int maximum) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        while (true) {
            int value = input.read();
            if (value == -1) return bytes.size() == 0 ? null : bytes.toString("UTF-8");
            if (value == 10) return bytes.toString("UTF-8");
            if (value != 13) bytes.write(value);
            if (bytes.size() > maximum) throw new IOException("Request line exceeds its limit");
        }
    }
    private static void copyBounded(InputStream input, OutputStream output, int maximum) throws IOException {
        byte[] buffer = new byte[4096]; int total = 0, count;
        while ((count = input.read(buffer)) != -1) { total += count; if (total > maximum) throw new IOException("Command output exceeds its limit"); output.write(buffer, 0, count); }
    }
}