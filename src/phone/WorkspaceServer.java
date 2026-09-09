package com.lop.phone;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.ActivityOptions;
import android.app.KeyguardManager;
import android.app.UiAutomation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.*;
import android.util.Base64;
import android.util.SparseArray;
import android.view.*;
import android.view.accessibility.*;
import org.json.*;
import java.io.*;
import java.lang.reflect.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

/** Deterministic shell-only UI broker. No model calls, clipboard, network listener or app data copies. */
public final class WorkspaceServer {
    static final int MAX_WORKSPACES = 2;
    static final String SOCKET = "pi_phone_workspaces_v1";
    final ShellContext context;
    final UiAutomation ui;
    final DisplayManager displays;
    final Object input;
    final Method inject, setDisplay;
    final HandlerThread frames = new HandlerThread("phone-workspace-frames");
    final Map<String, Workspace> workspaces = new LinkedHashMap<>();
    final Object injectionLock = new Object(); // Complete touch gestures are atomic across the shared injector.
    final ExecutorService observations = Executors.newFixedThreadPool(MAX_WORKSPACES);
    final String version;
    final String instance = UUID.randomUUID().toString();
    volatile boolean running = true;
    LocalServerSocket listener;

    static void log(String s) { System.err.println("[phone-workspaces] " + s); }
    static void require(boolean condition, String reason) { if (!condition) throw new IllegalStateException(reason); }
    static String cause(Throwable t) {
        while (t.getCause() != null) t = t.getCause();
        return t.getClass().getSimpleName() + ": " + String.valueOf(t.getMessage());
    }
    static int flag(String name) throws Exception {
        int f = DisplayManager.class.getDeclaredField(name).getInt(null);
        require(f != 0, "ISOLATION_FLAG_UNAVAILABLE: " + name); return f;
    }
    WorkspaceServer(String version, ShellContext context) throws Exception {
        require(Build.VERSION.SDK_INT >= 34, "Android 14+ required for independent virtual-display focus; no degraded mode");
        this.version = version; this.context = context;
        frames.start();
        Constructor<DisplayManager> dm = DisplayManager.class.getDeclaredConstructor(Context.class); dm.setAccessible(true);
        displays = dm.newInstance(context);
        HandlerThread automationThread = new HandlerThread("phone-workspace-ui"); automationThread.start();
        Class<?> connection = Class.forName("android.app.IUiAutomationConnection");
        Object impl = Class.forName("android.app.UiAutomationConnection").getDeclaredConstructor().newInstance();
        ui = UiAutomation.class.getConstructor(Looper.class, connection).newInstance(automationThread.getLooper(), impl);
        UiAutomation.class.getMethod("connect", int.class).invoke(ui, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        AccessibilityServiceInfo info = ui.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
        ui.setServiceInfo(info);
        input = context.getSystemService(Context.INPUT_SERVICE);
        inject = input.getClass().getMethod("injectInputEvent", InputEvent.class, int.class);
        setDisplay = InputEvent.class.getMethod("setDisplayId", int.class);
        log("ready version=" + version + " maxWorkspaces=" + MAX_WORKSPACES + " clipboard=disabled ime=hidden");
    }
    final class Workspace {
        final String name, pkg;
        final int width = 720, height = 1280, dpi = 240;
        final ImageReader reader;
        final VirtualDisplay display;
        final int displayId;
        final Object frameLock = new Object();
        Image image;
        long frameTime;
        final AtomicLong frameNumber = new AtomicLong();
        String snapshotId, fingerprint;
        long snapshotTime;
        boolean closed;
        Map<String, AccessibilityNodeInfo> nodes = new HashMap<>();
        Workspace(String name, String pkg) throws Exception {
            this.name = name; this.pkg = pkg;
            int flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC | DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY
                    | flag("VIRTUAL_DISPLAY_FLAG_SUPPORTS_TOUCH") | flag("VIRTUAL_DISPLAY_FLAG_TRUSTED")
                    | flag("VIRTUAL_DISPLAY_FLAG_OWN_FOCUS") | flag("VIRTUAL_DISPLAY_FLAG_STEAL_TOP_FOCUS_DISABLED")
                    | flag("VIRTUAL_DISPLAY_FLAG_DESTROY_CONTENT_ON_REMOVAL");
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
            reader.setOnImageAvailableListener(r -> {
                synchronized (frameLock) {
                    if (closed) return;
                    Image next = r.acquireLatestImage();
                    if (next != null) {
                        if (image != null) image.close(); image = next;
                        frameTime = System.currentTimeMillis(); frameNumber.incrementAndGet();
                    }
                }
            }, new Handler(frames.getLooper()));
            VirtualDisplay created = null;
            try {
                created = displays.createVirtualDisplay("Astra:" + name, width, height, dpi, reader.getSurface(), flags);
                require(created != null && created.getDisplay() != null, "VIRTUAL_DISPLAY_CREATION_FAILED");
                display = created; displayId = display.getDisplay().getDisplayId();
                require(displayId > 0, "DEFAULT_DISPLAY_FORBIDDEN");
                Object binder = Class.forName("android.os.ServiceManager").getMethod("getService", String.class).invoke(null, "window");
                Object wm = Class.forName("android.view.IWindowManager$Stub").getMethod("asInterface", IBinder.class).invoke(null, binder);
                wm.getClass().getMethod("setDisplayImePolicy", int.class, int.class).invoke(wm, displayId, 2);
                int actual = (int) wm.getClass().getMethod("getDisplayImePolicy", int.class).invoke(wm, displayId);
                require(actual == 2, "IME_ISOLATION_UNAVAILABLE");
            } catch (Exception e) {
                if (created != null) created.release(); reader.close(); throw e;
            }
        }
        JSONObject identity() throws JSONException {
            return new JSONObject().put("workspace", name).put("package", pkg).put("displayId", displayId)
                    .put("width", width).put("height", height).put("frame", frameNumber.get()).put("frameTime", frameTime);
        }
        void close() {
            synchronized (this) {
                if (closed) return;
                synchronized (frameLock) {
                    closed = true;
                    if (image != null) { image.close(); image = null; }
                    reader.setOnImageAvailableListener(null, null);
                    display.release(); reader.close();
                }
                nodes.clear(); log("closed workspace=" + name + " display=" + displayId);
            }
        }
    }
    SparseArray<List<AccessibilityWindowInfo>> windows() { return ui.getWindowsOnAllDisplays(); }
    static String pkg(AccessibilityNodeInfo n) { return n == null || n.getPackageName() == null ? "" : n.getPackageName().toString(); }
    static String text(CharSequence c) { return c == null ? "" : c.toString(); }
    String mainPackage() {
        List<AccessibilityWindowInfo> list = windows().get(0);
        if (list != null) for (AccessibilityWindowInfo win : list)
            if (win.getType() == AccessibilityWindowInfo.TYPE_APPLICATION) return pkg(win.getRoot());
        return "";
    }
    void unlocked() {
        KeyguardManager keyguard = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        require(keyguard != null && !keyguard.isKeyguardLocked(), "PHONE_LOCKED: workspace paused; unlock through phone entry");
    }
    synchronized Workspace open(JSONObject request) throws Exception {
        unlocked(); String name = request.getString("workspace"), pkg = request.getString("package");
        require(name.matches("[a-zA-Z][a-zA-Z0-9_-]{0,31}"), "INVALID_WORKSPACE");
        require(pkg.matches("[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+"), "INVALID_PACKAGE");
        Workspace old = workspaces.get(name);
        if (old != null) { require(old.pkg.equals(pkg), "WORKSPACE_ALREADY_ASSIGNED"); assertTarget(old); return old; }
        require(workspaces.size() < MAX_WORKSPACES, "WORKSPACE_CAPACITY: two UI slots; queue additional tasks");
        for (Workspace w : workspaces.values()) require(!w.pkg.equals(pkg), "APP_ALREADY_LEASED: " + pkg);
        String main = mainPackage(); require(!main.equals(pkg), "MAIN_DISPLAY_APP_BUSY: leave the app on main before allocating it");
        Intent intent = context.getPackageManager().getLaunchIntentForPackage(pkg);
        require(intent != null, "APP_NOT_LAUNCHABLE");
        Workspace w = new Workspace(name, pkg);
        try {
            require(intent.getComponent() != null, "APP_COMPONENT_UNRESOLVED");
            // A shell context has no Activity Instrumentation. Use Android's supported am entry
            // rather than depending on another private ActivityThread initialization field.
            java.lang.Process launch = new ProcessBuilder("/system/bin/am", "start", "--display", String.valueOf(w.displayId),
                    "-f", "0x18000000", "-n", intent.getComponent().flattenToString()).redirectErrorStream(true).start();
            if (!launch.waitFor(6, TimeUnit.SECONDS)) { launch.destroy(); throw new IllegalStateException("APP_LAUNCH_TIMEOUT"); }
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (InputStream stream = launch.getInputStream()) {
                byte[] chunk = new byte[1024]; int length;
                while ((length = stream.read(chunk)) > 0 && output.size() < 16000) output.write(chunk, 0, length);
            }
            String launchResult = output.toString("UTF-8");
            require(launch.exitValue() == 0 && !launchResult.contains("Error:") && !launchResult.contains("Exception"),
                    "APP_LAUNCH_REJECTED: " + launchResult.trim());
            boolean seen = false;
            for (int i = 0; i < 20; i++) {
                SystemClock.sleep(150);
                List<AccessibilityWindowInfo> list = windows().get(w.displayId);
                if (list != null) for (AccessibilityWindowInfo win : list) if (pkg.equals(pkg(win.getRoot()))) seen = true;
                if (seen) break;
            }
            require(seen, "APP_NOT_ON_TARGET_DISPLAY: no main-screen fallback");
            require(main.equals(mainPackage()), "MAIN_DISPLAY_CHANGED_DURING_LAUNCH");
            workspaces.put(name, w); log("opened workspace=" + name + " display=" + w.displayId + " app=" + pkg);
            return w;
        } catch (Exception e) { w.close(); throw e; }
    }
    synchronized Workspace get(String name) {
        Workspace w = workspaces.get(name); require(w != null && !w.closed, "WORKSPACE_NOT_FOUND: " + name); return w;
    }
    synchronized JSONObject list() throws JSONException {
        JSONArray out = new JSONArray(); for (Workspace w : workspaces.values()) out.put(w.identity());
        return new JSONObject().put("version", version).put("instance", instance).put("maxWorkspaces", MAX_WORKSPACES)
                .put("workspaces", out).put("mainPackage", mainPackage());
    }
    synchronized JSONObject close(String name) throws JSONException {
        Workspace w = workspaces.remove(name); if (w != null) w.close();
        return new JSONObject().put("closed", name).put("alreadyClosed", w == null);
    }
    void assertTarget(Workspace w) {
        unlocked(); require(!w.closed && displays.getDisplay(w.displayId) != null, "DISPLAY_LOST");
        boolean found = false;
        SparseArray<List<AccessibilityWindowInfo>> all = windows();
        for (int i = 0; i < all.size(); i++) {
            int id = all.keyAt(i);
            for (AccessibilityWindowInfo win : all.valueAt(i)) {
                if (win.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
                String p = pkg(win.getRoot());
                if (id == w.displayId) {
                    if (w.pkg.equals(p)) found = true;
                    else require(p.isEmpty(), "FOREIGN_WINDOW_PAUSED: " + p);
                } else require(!w.pkg.equals(p), "APP_MOVED_OR_SHARED: operation paused");
            }
        }
        require(found, "TARGET_APP_NOT_VISIBLE: operation paused");
    }
    static String hash(String s) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder(); for (byte b : d) out.append(String.format("%02x", b & 255)); return out.toString();
    }
    void walk(AccessibilityNodeInfo n, String ref, JSONArray out, Map<String, AccessibilityNodeInfo> nodes, int depth) throws JSONException {
        if (n == null || depth > 35 || nodes.size() >= 1500) return;
        Rect b = new Rect(); n.getBoundsInScreen(b);
        JSONObject item = new JSONObject().put("ref", ref).put("package", pkg(n)).put("class", text(n.getClassName()))
                .put("resourceId", text(n.getViewIdResourceName())).put("text", n.isPassword() ? "[protected]" : text(n.getText()))
                .put("description", n.isPassword() ? "" : text(n.getContentDescription()))
                .put("bounds", new JSONArray(Arrays.asList(b.left, b.top, b.right, b.bottom)))
                .put("enabled", n.isEnabled()).put("visible", n.isVisibleToUser()).put("clickable", n.isClickable())
                .put("editable", n.isEditable()).put("scrollable", n.isScrollable());
        out.put(item); nodes.put(ref, n);
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), ref + "." + i, out, nodes, depth + 1);
    }
    JSONArray tree(Workspace w, Map<String, AccessibilityNodeInfo> nodes) throws JSONException {
        JSONArray out = new JSONArray(); List<AccessibilityWindowInfo> list = windows().get(w.displayId);
        if (list != null) for (AccessibilityWindowInfo win : list) {
            AccessibilityNodeInfo root = win.getRoot();
            if (w.pkg.equals(pkg(root))) walk(root, "w" + win.getId() + ":0", out, nodes, 0);
        }
        return out;
    }
    JSONObject snapshot(Workspace w) throws Exception {
        synchronized (w) {
            assertTarget(w); Map<String, AccessibilityNodeInfo> nodes = new HashMap<>();
            JSONArray all = tree(w, nodes); require(all.length() > 0, "NO_UI_NODES: use screenshot for observation; unsafe actions disabled");
            w.nodes = nodes; w.fingerprint = hash(all.toString()); w.snapshotId = UUID.randomUUID().toString();
            w.snapshotTime = System.currentTimeMillis();
            return w.identity().put("snapshot", w.snapshotId).put("capturedAt", w.snapshotTime).put("nodes", all);
        }
    }
    JSONObject observe(JSONArray names) throws Exception {
        require(names.length() >= 1 && names.length() <= MAX_WORKSPACES, "INVALID_OBSERVE_COUNT");
        Set<String> unique = new HashSet<>(); List<Future<JSONObject>> pending = new ArrayList<>();
        long started = System.currentTimeMillis();
        for (int i = 0; i < names.length(); i++) {
            String name = names.getString(i); require(unique.add(name), "DUPLICATE_WORKSPACE");
            Workspace w = get(name); pending.add(observations.submit(() -> snapshot(w)));
        }
        JSONArray results = new JSONArray();
        for (Future<JSONObject> task : pending) results.put(task.get(15, TimeUnit.SECONDS));
        return new JSONObject().put("observations", results).put("elapsedMs", System.currentTimeMillis() - started);
    }
    void fresh(Workspace w, String token) throws Exception {
        assertTarget(w);
        require(token.equals(w.snapshotId) && System.currentTimeMillis() - w.snapshotTime <= 10000, "STALE_SNAPSHOT: observe again");
        Map<String, AccessibilityNodeInfo> current = new HashMap<>();
        require(hash(tree(w, current).toString()).equals(w.fingerprint), "STALE_SNAPSHOT: UI changed; observe again");
        w.nodes = current;
    }
    void send(int displayId, InputEvent event) throws Exception {
        require(displayId > 0, "DEFAULT_DISPLAY_FORBIDDEN"); unlocked();
        setDisplay.invoke(event, displayId);
        require(Boolean.TRUE.equals(inject.invoke(input, event, 2)), "DISPLAY_INPUT_REJECTED");
    }
    void motion(Workspace w, long down, int action, int x, int y) throws Exception {
        require(x >= 0 && y >= 0 && x < w.width && y < w.height, "COORDINATE_OUT_OF_BOUNDS");
        MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0);
        event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        try { send(w.displayId, event); } finally { event.recycle(); }
    }
    JSONObject action(Workspace w, JSONObject r) throws Exception {
        synchronized (w) {
            fresh(w, r.getString("snapshot")); String op = r.getString("op");
            long started = System.currentTimeMillis();
            // Consume before execution: timeout/crash must never automatically replay an action.
            w.snapshotId = null;
            if (op.equals("click") || op.equals("text")) {
                AccessibilityNodeInfo node = w.nodes.get(r.getString("ref"));
                require(node != null && node.isEnabled() && node.isVisibleToUser() && w.pkg.equals(pkg(node)), "INVALID_NODE");
                if (op.equals("text")) {
                    require(node.isEditable() && !node.isPassword(), "TEXT_TARGET_UNSUPPORTED_OR_PROTECTED");
                    String text = r.getString("text"); require(text.length() <= 8192, "TEXT_TOO_LONG");
                    Bundle args = new Bundle(); args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
                    require(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args), "DIRECT_TEXT_REJECTED: no clipboard or IME fallback");
                } else require(node.performAction(AccessibilityNodeInfo.ACTION_CLICK), "NODE_CLICK_REJECTED: observe before coordinate action");
            } else synchronized (injectionLock) {
                assertTarget(w);
                long down = SystemClock.uptimeMillis();
                if (op.equals("tap") || op.equals("swipe")) {
                    int x = r.getInt("x"), y = r.getInt("y");
                    int ex = r.optInt("endX", x), ey = r.optInt("endY", y);
                    int duration = op.equals("swipe") ? r.optInt("duration", 300) : 40;
                    require(duration >= 40 && duration <= 1000 && ex >= 0 && ex < w.width && ey >= 0 && ey < w.height, "INVALID_GESTURE");
                    motion(w, down, MotionEvent.ACTION_DOWN, x, y);
                    try {
                        if (op.equals("swipe")) for (int i = 1; i <= 10; i++) {
                            SystemClock.sleep(duration / 10);
                            motion(w, down, MotionEvent.ACTION_MOVE, x + (ex - x) * i / 10, y + (ey - y) * i / 10);
                        } else SystemClock.sleep(40);
                    } finally { motion(w, down, MotionEvent.ACTION_UP, ex, ey); }
                } else {
                    int key = op.equals("back") ? KeyEvent.KEYCODE_BACK : op.equals("enter") ? KeyEvent.KEYCODE_ENTER : -1;
                    require(key != -1, "UNSUPPORTED_OPERATION");
                    send(w.displayId, new KeyEvent(down, down, KeyEvent.ACTION_DOWN, key, 0));
                    send(w.displayId, new KeyEvent(down, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, key, 0));
                }
            }
            return w.identity().put("applied", op).put("elapsedMs", System.currentTimeMillis() - started).put("observeRequired", true);
        }
    }
    JSONObject screenshot(Workspace w) throws Exception {
        synchronized (w) {
            assertTarget(w);
            synchronized (w.frameLock) {
                require(w.image != null, "NO_FRAME_YET");
                Image.Plane plane = w.image.getPlanes()[0];
                int paddedWidth = plane.getRowStride() / plane.getPixelStride();
                Bitmap padded = Bitmap.createBitmap(paddedWidth, w.height, Bitmap.Config.ARGB_8888);
                ByteBuffer pixels = plane.getBuffer(); pixels.rewind(); padded.copyPixelsFromBuffer(pixels);
                Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, w.width, w.height);
                ByteArrayOutputStream bytes = new ByteArrayOutputStream(); cropped.compress(Bitmap.CompressFormat.PNG, 100, bytes);
                if (cropped != padded) cropped.recycle(); padded.recycle();
                return w.identity().put("capturedAt", System.currentTimeMillis()).put("png", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
            }
        }
    }
    static String xmlEscape(String s) { return s.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;"); }
    void xmlNode(AccessibilityNodeInfo n, StringBuilder b, int depth) {
        if (n == null || depth > 35 || b.length() > 2000000) return;
        Rect r = new Rect(); n.getBoundsInScreen(r);
        b.append("<node package=\"").append(xmlEscape(pkg(n))).append("\" resource-id=\"").append(xmlEscape(text(n.getViewIdResourceName())))
            .append("\" text=\"").append(xmlEscape(n.isPassword() ? "" : text(n.getText()))).append("\" content-desc=\"")
            .append(xmlEscape(n.isPassword() ? "" : text(n.getContentDescription()))).append("\" class=\"").append(xmlEscape(text(n.getClassName())))
            .append("\" enabled=\"").append(n.isEnabled()).append("\" clickable=\"").append(n.isClickable()).append("\" bounds=\"[")
            .append(r.left).append(',').append(r.top).append("][").append(r.right).append(',').append(r.bottom).append("]\">");
        for (int i = 0; i < n.getChildCount(); i++) xmlNode(n.getChild(i), b, depth + 1);
        b.append("</node>");
    }
    JSONObject mainUi() throws JSONException {
        // Read-only main-display tree also serves the existing verified DPAPI unlock path.
        StringBuilder out = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?><hierarchy rotation=\"0\">");
        List<AccessibilityWindowInfo> list = windows().get(0);
        if (list != null) for (AccessibilityWindowInfo win : list) xmlNode(win.getRoot(), out, 0);
        out.append("</hierarchy>"); return new JSONObject().put("xml", out.toString());
    }
    JSONObject dispatch(JSONObject r) throws Exception {
        String op = r.getString("op");
        if (op.equals("ping")) return new JSONObject().put("version", version).put("instance", instance).put("pid", android.os.Process.myPid());
        require(instance.equals(r.optString("instance")), "BROKER_IDENTITY_CHANGED: explicit reconnect required");
        if (op.equals("list")) return list();
        if (op.equals("main-ui")) return mainUi();
        if (op.equals("open")) return open(r).identity();
        if (op.equals("observe")) return observe(r.getJSONArray("workspaces"));
        if (op.equals("close")) return close(r.getString("workspace"));
        if (op.equals("stop")) {
            synchronized (this) { for (Workspace w : workspaces.values()) w.close(); workspaces.clear(); }
            running = false; return new JSONObject().put("stopped", true);
        }
        Workspace w = get(r.getString("workspace"));
        if (op.equals("snapshot")) return snapshot(w);
        if (op.equals("screenshot")) return screenshot(w);
        return action(w, r);
    }
    static String readLine(InputStream stream) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream(); int c;
        while ((c = stream.read()) != -1 && c != '\n') {
            if (line.size() >= 65536) throw new IOException("REQUEST_TOO_LARGE"); line.write(c);
        }
        return line.toString("UTF-8");
    }
    void serve(LocalSocket socket) {
        String id = "unknown";
        try (LocalSocket s = socket) {
            s.setSoTimeout(25000);
            int uid = s.getPeerCredentials().getUid();
            require(uid == 2000 || uid == 0, "SHELL_ONLY_TRANSPORT");
            JSONObject response = new JSONObject();
            try {
                JSONObject request = new JSONObject(readLine(s.getInputStream())); id = request.getString("id");
                response.put("id", id).put("ok", true).put("result", dispatch(request));
            } catch (Throwable e) {
                String reason = cause(e); log("request=" + id + " rejected=" + reason);
                response = new JSONObject().put("id", id).put("ok", false).put("error", reason);
            }
            s.getOutputStream().write((response.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            s.getOutputStream().flush();
            if (!running) {
                UiAutomation.class.getMethod("disconnect").invoke(ui);
                log("stopped; accessibility connection released"); System.exit(0);
            }
        } catch (Throwable e) { log("transport rejected=" + cause(e)); }
    }
    void run() throws Exception {
        listener = new LocalServerSocket(SOCKET);
        ThreadPoolExecutor clients = new ThreadPoolExecutor(4, 4, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(16));
        while (running) {
            LocalSocket socket = listener.accept();
            try { clients.execute(() -> serve(socket)); }
            catch (RejectedExecutionException e) { log("CLIENT_CAPACITY: connection rejected"); socket.close(); }
        }
    }
    public static void main(String[] args) throws Exception {
        Looper.prepareMainLooper(); ShellContext context = ShellContext.create();
        String version = args.length > 0 ? args[0] : "unknown";
        new Thread(() -> {
            try { new WorkspaceServer(version, context).run(); }
            catch (Throwable e) { log("fatal=" + cause(e)); e.printStackTrace(); System.exit(1); }
        }, "phone-workspace-server").start();
        Looper.loop();
    }
}
