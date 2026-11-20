package wiki.shion.tsukiakari;

import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

public final class MessageService extends Service {
    private static volatile boolean activityVisible;
    private static volatile MessageService instance;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Object mode = new Object();
    private final AtomicReference<HttpURLConnection> events = new AtomicReference<>();
    private volatile boolean running;
    private Device device;

    static void foreground(boolean value) {
        activityVisible = value;
        var service = instance;
        if (service != null) {
            if (value) service.interruptStream();
            synchronized (service.mode) { service.mode.notifyAll(); }
        }
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        device = new Device(this);
        startForeground(Notice.SERVICE_ID, Notice.connection(this, false));
        if (!permitted()) { stopSelf(); return START_NOT_STICKY; }
        instance = this;
        if (!running) { running = true; worker.submit(this::listen); }
        return START_STICKY;
    }

    private boolean permitted() {
        String owner = device.owner();
        return !owner.isEmpty() && device.flag(owner, "background") && device.allowed() && Endpoint.validate(device.origin(), BuildConfig.DEBUG) != null;
    }

    private boolean current(String origin, String owner) {
        return running && !activityVisible && permitted() && owner.equals(device.owner()) && origin.equals(device.origin());
    }

    private void interruptStream() {
        HttpURLConnection stream = events.getAndSet(null);
        if (stream != null) workerDisconnect(stream);
    }

    // HttpURLConnection may wait for a socket read during disconnect. Keep it off the UI thread.
    private static void workerDisconnect(HttpURLConnection stream) { new Thread(stream::disconnect, "tsukiakari-stream-close").start(); }

    private void status(boolean connected) {
        if (running && instance == this) getSystemService(NotificationManager.class).notify(Notice.SERVICE_ID, Notice.connection(this, connected));
    }

    private void listen() {
        long delay = 1500;
        while (running && permitted()) {
            try {
                synchronized (mode) { while (running && activityVisible) mode.wait(); }
                if (!running || !permitted()) break;
                String owner = device.owner(), origin = device.origin();
                JSONObject session = Endpoint.json(origin, "/api/chat/session", null, null);
                if (!owner.equals(session.optString("key"))) { invalidate(origin, owner); return; }
                if (!current(origin, owner)) continue;
                stream(origin, owner, session.getString("csrf"));
                delay = 1500;
            } catch (Endpoint.Reply error) {
                if (error.status == 401) {
                    Notice.clear(this);
                    stopSelf(); return;
                }
            } catch (InterruptedException stopped) { return; }
            catch (Exception ignored) { /* Retry after bounded backoff. */ }
            if (!running) return;
            status(false);
            synchronized (mode) {
                try { if (!activityVisible && running) mode.wait(delay); }
                catch (InterruptedException stopped) { return; }
            }
            delay = Math.min(60_000, delay * 2);
        }
        if (running) stopSelf();
    }

    private void invalidate(String origin, String owner) {
        if (owner.equals(device.owner()) && origin.equals(device.origin())) {
            Notice.clear(this); stopSelf();
        }
    }

    private static final class ThreadInfo {
        private final String kind, title;
        private final int unread;
        ThreadInfo(String kind, String title, int unread) { this.kind = kind; this.title = title; this.unread = unread; }
        String kind() { return kind; }
        String title() { return title; }
        int unread() { return unread; }
        static ThreadInfo from(JSONObject item) { return new ThreadInfo(item.optString("kind"), item.optString("title"), item.optInt("unread")); }
    }

    private void stream(String origin, String owner, String csrf) throws Exception {
        var summaries = new HashMap<String, ThreadInfo>();
        HttpURLConnection connection = Endpoint.request(origin, "/api/chat/events", true);
        events.set(connection);
        try {
            int code = connection.getResponseCode();
            if (code != 200) throw new Endpoint.Reply(code);
            status(true);
            try (var in = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                String type = "", data = "";
                for (String line; current(origin, owner) && (line = in.readLine()) != null;) {
                    if (line.startsWith("event: ")) type = line.substring(7);
                    else if (line.startsWith("data: ") && line.length() <= 524_288) data = line.substring(6);
                    else if (line.isEmpty()) {
                        if (type.equals("ready")) reconcile(origin, owner, csrf, summaries);
                        if (!data.isEmpty()) {
                            JSONObject event = new JSONObject(data);
                            String id = event.optString("threadId");
                            if (type.equals("message") && Endpoint.thread(id)) deliver(origin, owner, csrf, id, event.optJSONObject("item"), summaries, false);
                            String read = event.optString("id");
                            if (type.equals("read") && Endpoint.thread(read)) readChanged(origin, read, summaries);
                            if (type.equals("deleted")) {
                                String deleted = event.optString("id");
                                if (Endpoint.thread(deleted)) Notice.read(this, deleted, Long.MAX_VALUE);
                            }
                        }
                        type = data = "";
                    }
                }
            }
        } finally { events.compareAndSet(connection, null); connection.disconnect(); }
    }

    private void reconcile(String origin, String owner, String csrf, HashMap<String, ThreadInfo> summaries) throws Exception {
        JSONArray list = Endpoint.json(origin, "/api/chat/threads?limit=100", null, null).getJSONArray("items");
        int caughtUp = 0;
        for (int index = 0; index < list.length() && current(origin, owner); index++) {
            JSONObject item = list.getJSONObject(index);
            String id = item.optString("id");
            if (!Endpoint.thread(id)) continue;
            ThreadInfo info = ThreadInfo.from(item);
            summaries.put(id, info);
            if (info.unread() == 0) { Notice.read(this, id, Long.MAX_VALUE); continue; }
            if (caughtUp >= 8 || device.flag(owner, "quiet") || info.kind().equals("group") && !device.flag(owner, "groups")) continue;
            caughtUp++;
            JSONArray history;
            try { history = Endpoint.json(origin, "/api/chat/threads/" + id, null, null).getJSONArray("messages"); }
            catch (Endpoint.Reply denied) {
                if (denied.status == 403 || denied.status == 404) { Notice.read(this, id, Long.MAX_VALUE); continue; }
                throw denied;
            }
            for (int pos = history.length() - 1; pos >= 0; pos--) {
                JSONObject message = history.getJSONObject(pos);
                if (incoming(owner, message)) { deliver(origin, owner, csrf, id, message, summaries, true); break; }
            }
        }
    }

    private void readChanged(String origin, String id, HashMap<String, ThreadInfo> summaries) throws Exception {
        try {
            ThreadInfo latest = ThreadInfo.from(Endpoint.json(origin, "/api/chat/threads/" + id, null, null).getJSONObject("item"));
            summaries.put(id, latest);
            if (latest.unread() == 0) Notice.read(this, id, Long.MAX_VALUE);
        } catch (Endpoint.Reply denied) {
            if (denied.status != 403 && denied.status != 404) throw denied;
            summaries.remove(id);
            Notice.read(this, id, Long.MAX_VALUE);
        }
    }

    private static boolean incoming(String owner, JSONObject item) {
        return item != null && item.optLong("id") > 0 && "complete".equals(item.optString("status")) && !owner.equals(item.optString("senderKey"));
    }

    private void deliver(String origin, String owner, String csrf, String id, JSONObject item,
                         HashMap<String, ThreadInfo> summaries, boolean catchUp) throws Exception {
        if (!incoming(owner, item) || !current(origin, owner) || device.flag(owner, "quiet")) return;
        ThreadInfo info = summaries.get(id);
        if (info == null || !catchUp) {
            try { info = ThreadInfo.from(Endpoint.json(origin, "/api/chat/threads/" + id, null, null).getJSONObject("item")); }
            catch (Endpoint.Reply denied) { if (denied.status == 403 || denied.status == 404) return; throw denied; }
            if (summaries.size() >= 140) summaries.clear();
            summaries.put(id, info);
        }
        if (info.unread() == 0 || info.kind().equals("group") && !device.flag(owner, "groups") || !current(origin, owner)) return;
        long message = item.getLong("id");
        JSONObject claim = Endpoint.json(origin, "/api/chat/notifications/claim", csrf, new JSONObject().put("messageId", message));
        if (!claim.optBoolean("notify") || !current(origin, owner)) return;
        JSONObject display = claim.getJSONObject("item");
        Notice.message(this, device, owner, id, info.kind(), info.title(), display.optString("sender"), display.optString("body"), message, info.unread(), catchUp);
    }

    @Override public void onDestroy() {
        running = false;
        if (instance == this) instance = null;
        interruptStream(); worker.shutdownNow();
        synchronized (mode) { mode.notifyAll(); }
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
}
