package wiki.shion.tsukiakari;

import android.content.Context;
import android.content.SharedPreferences;
import android.app.NotificationManager;
import android.os.Build;
import org.json.JSONObject;

final class Device {
    static final String[] FLAGS = {"cards", "sound", "vibrate", "groups", "quiet", "preview", "background", "reduce"};
    private final SharedPreferences prefs;
    private final Context context;

    Device(Context context) {
        this.context = context.getApplicationContext();
        prefs = this.context.getSharedPreferences("device", Context.MODE_PRIVATE);
    }

    String origin() { return prefs.getString("origin", ""); }
    String owner() { return prefs.getString("owner", ""); }
    void connectedTo(String origin) { prefs.edit().putString("origin", origin).remove("owner").apply(); }
    void owner(String value) { prefs.edit().putString("owner", value).apply(); }

    private String key(String account, String flag) { return "pref:" + origin() + ":" + account + ":" + flag; }

    boolean flag(String owner, String flag) {
        boolean enabled = flag.equals("cards") || flag.equals("sound") || flag.equals("groups");
        return prefs.getBoolean(key(owner, flag), enabled);
    }

    JSONObject values(String owner) throws Exception {
        JSONObject result = new JSONObject();
        for (String flag : FLAGS) result.put(flag, flag(owner, flag));
        return result.put("notificationAllowed", allowed()).put("permissionNeeded", Build.VERSION.SDK_INT >= 33);
    }

    void save(String owner, JSONObject values) {
        var edit = prefs.edit();
        for (String flag : FLAGS) if (values.opt(flag) instanceof Boolean value) edit.putBoolean(key(owner, flag), value);
        edit.apply();
    }

    boolean allowed() { return context.getSystemService(NotificationManager.class).areNotificationsEnabled(); }
}
