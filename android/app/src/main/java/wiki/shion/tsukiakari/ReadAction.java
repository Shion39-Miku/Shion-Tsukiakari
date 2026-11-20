package wiki.shion.tsukiakari;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class ReadAction extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        var uri = intent.getData();
        if (uri == null || uri.getPathSegments().size() != 2) return;
        String id = uri.getPathSegments().get(0), owner = intent.getStringExtra("owner");
        long through;
        try { through = Long.parseLong(uri.getPathSegments().get(1)); } catch (NumberFormatException ignored) { return; }
        if (!Endpoint.thread(id) || through <= 0 || owner == null || owner.isEmpty()) return;
        var result = goAsync();
        new Thread(() -> {
            try {
                Device device = new Device(context);
                String origin = Endpoint.validate(device.origin(), BuildConfig.DEBUG);
                if (origin == null || !owner.equals(device.owner())) return;
                var session = Endpoint.json(origin, "/api/chat/session", null, null);
                if (!owner.equals(session.optString("key")) || !owner.equals(device.owner()) || !origin.equals(device.origin())) return;
                Endpoint.json(origin, "/api/chat/threads/" + id + "/read?through=" + through, session.getString("csrf"), null);
                if (owner.equals(device.owner()) && origin.equals(device.origin())) Notice.read(context, id, through);
            } catch (Exception ignored) { /* Keep the notification so the action can be retried. */ }
            finally { result.finish(); }
        }, "tsukiakari-read").start();
    }
}
