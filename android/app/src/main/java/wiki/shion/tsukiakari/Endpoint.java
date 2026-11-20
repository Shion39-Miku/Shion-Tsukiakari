package wiki.shion.tsukiakari;

import android.webkit.CookieManager;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

final class Endpoint {
    private Endpoint() {}

    static String originKey(URI uri) {
        String scheme = uri.getScheme(), host = uri.getHost();
        if (scheme == null || host == null || uri.getRawUserInfo() != null || uri.getPort() > 65535 || uri.getPort() == 0) return null;
        scheme = scheme.toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) return null;
        int port = uri.getPort(), standard = scheme.equals("https") ? 443 : 80;
        return scheme + "://" + host.toLowerCase(Locale.ROOT) + (port < 0 || port == standard ? "" : ":" + port);
    }

    static String validate(String raw, boolean debug) {
        try {
            URI uri = URI.create(raw.trim());
            String key = originKey(uri);
            String path = uri.getRawPath();
            if (key == null || uri.getRawQuery() != null || uri.getRawFragment() != null || !(path.isEmpty() || path.equals("/"))) return null;
            if (key.startsWith("https://") || debug && key.startsWith("http://") && (uri.getHost().equals("127.0.0.1") || uri.getHost().equalsIgnoreCase("localhost"))) return key;
        } catch (IllegalArgumentException ignored) {}
        return null;
    }

    static boolean belongs(String url, String origin) {
        try { return origin != null && origin.equals(originKey(URI.create(url))); }
        catch (IllegalArgumentException ignored) { return false; }
    }

    static boolean thread(String id) { return id != null && id.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"); }

    static HttpURLConnection request(String origin, String path, boolean sse) throws IOException {
        if (!path.startsWith("/api/chat/") || !belongs(origin + path, origin)) throw new IOException("Invalid chat route");
        HttpURLConnection request = (HttpURLConnection) URI.create(origin + path).toURL().openConnection();
        request.setInstanceFollowRedirects(false);
        request.setUseCaches(false);
        request.setConnectTimeout(7000);
        request.setReadTimeout(sse ? 45000 : 7000);
        request.setRequestProperty("Accept", sse ? "text/event-stream" : "application/json");
        request.setRequestProperty("Cache-Control", "no-store");
        String cookies = CookieManager.getInstance().getCookie(origin + path);
        if (cookies != null) request.setRequestProperty("Cookie", cookies);
        return request;
    }

    static JSONObject json(String origin, String path, String csrf, JSONObject data) throws Exception {
        HttpURLConnection request = request(origin, path, false);
        try {
            if (csrf != null) {
                request.setRequestMethod("POST");
                request.setRequestProperty("Origin", origin);
                request.setRequestProperty("X-CSRF-Token", csrf);
                if (data != null) {
                    byte[] bytes = data.toString().getBytes(StandardCharsets.UTF_8);
                    request.setRequestProperty("Content-Type", "application/json");
                    request.setDoOutput(true);
                    request.setFixedLengthStreamingMode(bytes.length);
                    try (var out = request.getOutputStream()) { out.write(bytes); }
                }
            }
            int code = request.getResponseCode();
            if (code >= 400) throw new Reply(code);
            if (code >= 300) throw new IOException("Unexpected redirect");
            try (InputStream in = request.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] bytes = new byte[8192];
                for (int size; (size = in.read(bytes)) >= 0;) {
                    if (out.size() + size > 4 * 1024 * 1024) throw new IOException("Reply too large");
                    out.write(bytes, 0, size);
                }
                return new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
            }
        } finally { request.disconnect(); }
    }

    static final class Reply extends IOException {
        final int status;
        Reply(int status) { super("HTTP " + status); this.status = status; }
    }
}
