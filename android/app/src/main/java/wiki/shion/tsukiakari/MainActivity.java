package wiki.shion.tsukiakari;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.window.OnBackInvokedDispatcher;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int FILE = 41, SAVE = 42, NOTICES = 43;
    private static final int NIGHT = Color.rgb(16, 18, 31), LIGHT = Color.rgb(245, 232, 246), MUTED = Color.rgb(190, 178, 204);
    private static final String POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    private final ExecutorService files = Executors.newSingleThreadExecutor();
    private Device device;
    private FrameLayout root;
    private WebView web;
    private WebMessagePort port;
    private ValueCallback<Uri[]> picker;
    private DocumentJob document;
    private String origin, account = "", nextThread, nextAccount;
    private boolean foreground, bridgeReady, farewell;
    private android.media.SoundPool sound;
    private int chime;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        device = new Device(this);
        origin = Endpoint.validate(device.origin(), BuildConfig.DEBUG);
        getWindow().setStatusBarColor(NIGHT);
        getWindow().setNavigationBarColor(NIGHT);
        root = new FrameLayout(this);
        root.setBackgroundColor(NIGHT);
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                var edges = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                var keyboard = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(edges.left, edges.top, edges.right, Math.max(edges.bottom, keyboard.bottom));
                return WindowInsets.CONSUMED;
            });
        }
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        capture(getIntent());
        if (state != null && state.getBoolean("farewell")) farewell = true;
        if (state != null && Endpoint.thread(state.getString("nextThread"))) {
            nextThread = state.getString("nextThread"); nextAccount = state.getString("nextAccount");
        }
        ShortcutManager shortcuts = getSystemService(ShortcutManager.class);
        ShortcutInfo night = new ShortcutInfo.Builder(this, "farewell")
            .setShortLabel(getString(R.string.shortcut_hello)).setLongLabel(getString(R.string.shortcut_long))
            .setIcon(Icon.createWithResource(this, R.drawable.brand_art))
            .setIntent(new Intent(Intent.ACTION_VIEW, Uri.parse("tsukiakari://farewell"), this, MainActivity.class)).build();
        try { shortcuts.setDynamicShortcuts(Collections.singletonList(night)); } catch (RuntimeException ignored) {}
        if (origin == null) showConnection(); else showChat();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putBoolean("farewell", farewell);
        state.putString("nextThread", nextThread);
        state.putString("nextAccount", nextAccount);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        capture(intent);
        deliverEntry();
    }

    private void capture(Intent intent) {
        Uri link = intent.getData();
        if (link == null || !"tsukiakari".equals(link.getScheme())) return;
        if ("farewell".equals(link.getHost())) farewell = true;
        if ("notice".equals(link.getHost()) && Endpoint.thread(link.getLastPathSegment())
            && !device.owner().isEmpty() && device.owner().equals(intent.getStringExtra("owner"))) {
            nextThread = link.getLastPathSegment(); nextAccount = device.owner();
        }
        intent.setData(null);
    }

    private void deliverEntry() {
        if (!bridgeReady || account.isEmpty()) return;
        if (nextThread != null) {
            if (account.equals(nextAccount)) event("thread", nextThread);
            nextThread = nextAccount = null;
        }
        if (farewell) { farewell = false; event("farewell", true); }
    }

    @Override protected void onStart() {
        super.onStart();
        foreground = true;
        MessageService.foreground(true);
        event("visible", true);
        if (web != null) web.onResume();
    }

    @Override protected void onStop() {
        foreground = false;
        event("visible", false);
        if (web != null) web.onPause();
        MessageService.foreground(false);
        super.onStop();
    }

    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        if (web != null) web.getSettings().setTextZoom(Math.round(config.fontScale * 100));
        root.requestApplyInsets();
    }

    @Override public void onBackPressed() { back(); }

    private void back() {
        if (web == null || !bridgeReady) { moveTaskToBack(true); return; }
        web.evaluateJavascript("Boolean(window.tsukiakariAndroidBack?.())", consumed -> {
            if (!"true".equals(consumed)) moveTaskToBack(true);
        });
    }

    private int dp(int n) { return Math.round(n * getResources().getDisplayMetrics().density); }

    private GradientDrawable panel(int color, int radius) {
        GradientDrawable surface = new GradientDrawable();
        surface.setColor(color);
        surface.setCornerRadius(dp(radius));
        return surface;
    }

    private TextView copy(String value, int size, int color) {
        TextView text = new TextView(this);
        text.setText(value); text.setTextSize(size); text.setTextColor(color);
        text.setLineSpacing(dp(3), 1);
        return text;
    }

    private void showConnection() {
        ScrollView screen = new ScrollView(this);
        screen.setFillViewport(true);
        FrameLayout surround = new FrameLayout(this);
        FrameLayout.LayoutParams fit = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        LinearLayout card = new LinearLayout(this) {
            @Override protected void onMeasure(int w, int h) {
                super.onMeasure(View.MeasureSpec.makeMeasureSpec(Math.min(View.MeasureSpec.getSize(w), dp(480)), View.MeasureSpec.EXACTLY), h);
            }
        };
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(26), dp(32), dp(26), dp(32));
        ImageView brand = new ImageView(this);
        brand.setImageResource(R.drawable.brand_art);
        brand.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        card.addView(brand, new LinearLayout.LayoutParams(dp(68), dp(68)));
        TextView title = copy("月明かり", 28, LIGHT); title.setTypeface(Typeface.SERIF, Typeface.NORMAL);
        title.setPadding(0, dp(18), 0, dp(14)); card.addView(title);
        card.addView(copy("连接你的聊天服务", 21, LIGHT));
        TextView intro = copy("连接后，使用与桌面端相同的账号登录。", 16, MUTED);
        intro.setPadding(0, dp(8), 0, dp(17)); card.addView(intro);
        EditText address = new EditText(this);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setSingleLine(true); address.setTextSize(16); address.setTextColor(LIGHT);
        address.setHintTextColor(MUTED); address.setHint("https://chat.example.org");
        address.setContentDescription("聊天服务地址"); address.setText(origin == null ? "" : origin);
        address.setPadding(dp(15), dp(9), dp(15), dp(9)); address.setMinHeight(dp(54));
        address.setBackground(panel(Color.rgb(36, 35, 54), 12)); card.addView(address);
        TextView status = copy("", 14, MUTED); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        status.setPadding(0, dp(7), 0, dp(12)); card.addView(status);
        Button apply = new Button(this);
        apply.setText("继续登录"); apply.setAllCaps(false); apply.setTextColor(Color.rgb(39, 25, 49));
        apply.setBackground(panel(Color.rgb(229, 191, 216), 13)); apply.setMinimumHeight(dp(52));
        apply.setOnClickListener(v -> {
            String chosen = Endpoint.validate(address.getText().toString(), BuildConfig.DEBUG);
            if (chosen == null) {
                status.setText(BuildConfig.DEBUG ? "填写 HTTPS 服务地址。调试版也支持经 ADB 转发的本机 HTTP。" : "填写 HTTPS 服务根地址，地址中请勿加入账号或路径。");
                return;
            }
            getSystemService(InputMethodManager.class).hideSoftInputFromWindow(address.getWindowToken(), 0);
            apply.setEnabled(false); address.setEnabled(false);
            status.setText("正在检查聊天服务…");
            files.submit(() -> {
                String issue = connectionIssue(chosen);
                runOnUiThread(() -> {
                    if (isFinishing() || !screen.isAttachedToWindow()) return;
                    apply.setEnabled(true); address.setEnabled(true);
                    if (issue != null) { status.setText(issue); return; }
                    if (!chosen.equals(origin)) {
                        stopService(new Intent(this, MessageService.class));
                        Notice.clear(this);
                        device.connectedTo(chosen); origin = chosen; account = "";
                        nextAccount = nextThread = null;
                    }
                    showChat();
                });
            });
        });
        card.addView(apply, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)));
        if (origin != null) {
            Button cancel = new Button(this); cancel.setText("返回登录"); cancel.setAllCaps(false);
            cancel.setOnClickListener(v -> showChat()); card.addView(cancel);
        }
        surround.addView(card, fit); screen.addView(surround);
        root.removeAllViews(); root.addView(screen);
    }

    private static String connectionIssue(String chosen) {
        try {
            HttpURLConnection request = Endpoint.request(chosen, "/api/chat/session", false);
            try {
                int code = request.getResponseCode();
                String mime = request.getContentType();
                if ((code == 200 || code == 401) && mime != null && mime.startsWith("application/json")) return null;
                if (code == 404 || code == 200 || code == 401) return "此地址没有月明かり聊天接口。请填写聊天服务的根地址。";
            } finally { request.disconnect(); }
        } catch (IOException unavailable) { /* Explain connection errors without exposing addresses or cookies. */ }
        return "暂时连不上聊天服务，请检查地址、网络和 HTTPS 证书。";
    }

    private WebResourceResponse asset(WebResourceRequest request) {
        String url = request.getUrl().toString(), path = request.getUrl().getPath();
        if (!Endpoint.belongs(url, origin) || path == null) return blocked();
        if (path.equals("/chat") || path.equals("/chat/manage")) path = "/chat.html";
        if (!path.matches("/[A-Za-z0-9_./-]+") || path.contains("..")) return null;
        String suffix = path.substring(path.lastIndexOf('.') + 1);
        try {
            var local = getAssets().open("web" + path);
            String type = switch (suffix) {
                case "html" -> "text/html";
                case "js" -> "text/javascript";
                case "css" -> "text/css";
                default -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(suffix);
            };
            var headers = new HashMap<String, String>();
            headers.put("Content-Security-Policy", POLICY); headers.put("Cache-Control", "no-store");
            return new WebResourceResponse(type, "UTF-8", 200, "OK", headers, local);
        } catch (IOException ignored) { return null; }
    }

    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private void showChat() {
        disposeWeb();
        root.removeAllViews();
        web = new WebView(this);
        web.setBackgroundColor(NIGHT);
        web.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        var config = web.getSettings();
        config.setJavaScriptEnabled(true); config.setDomStorageEnabled(true);
        config.setAllowFileAccess(false); config.setAllowContentAccess(true);
        config.setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        config.setMediaPlaybackRequiresUserGesture(true);
        config.setSupportMultipleWindows(false);
        config.setTextZoom(Math.round(getResources().getConfiguration().fontScale * 100));
        config.setUserAgentString(config.getUserAgentString() + " TsukiakariAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return asset(request);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return true;
                Uri url = request.getUrl();
                if (Endpoint.belongs(url.toString(), origin) && "/chat".equals(url.getPath())) return false;
                if (request.hasGesture() && "https".equals(url.getScheme()) && url.getUserInfo() == null) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, url)); } catch (RuntimeException ignored) {}
                }
                return true;
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (view == web && Endpoint.belongs(url, origin) && "/chat".equals(Uri.parse(url).getPath())) establishPort(view);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams config) {
                if (picker != null) picker.onReceiveValue(null);
                picker = callback;
                Intent open = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE)
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, config.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(open, FILE); }
                catch (RuntimeException unavailable) { picker.onReceiveValue(null); picker = null; }
                return true;
            }
        });
        web.setDownloadListener((url, agent, disposition, mime, size) -> {
            if (account.isEmpty() || !Endpoint.belongs(url, origin)) return;
            String source = origin, owner = account;
            selectDestination(mime, URLUtil.guessFileName(url, disposition, mime), out -> {
                if (!owner.equals(device.owner()) || !source.equals(device.origin())) throw new IOException("Account changed");
                HttpURLConnection request = (HttpURLConnection) URI.create(url).toURL().openConnection();
                request.setInstanceFollowRedirects(false); request.setConnectTimeout(6000); request.setReadTimeout(30000);
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) request.setRequestProperty("Cookie", cookie);
                try {
                    if (request.getResponseCode() != 200) throw new IOException("File unavailable");
                    try (var in = request.getInputStream()) {
                        byte[] buffer = new byte[16384]; long total = 0;
                        for (int n; (n = in.read(buffer)) >= 0;) {
                            total += n;
                            if (total > 105_000_000) throw new IOException("File exceeds limit");
                            out.write(buffer, 0, n);
                        }
                    }
                } finally { request.disconnect(); }
            });
        });
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        web.loadUrl(origin + "/chat");
    }

    private void establishPort(WebView target) {
        if (port != null) port.close();
        bridgeReady = false;
        WebMessagePort[] ports = target.createWebMessageChannel();
        port = ports[0];
        port.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override public void onMessage(WebMessagePort from, WebMessage message) {
                if (port != from || target != web || !Endpoint.belongs(target.getUrl(), origin)) return;
                String body = message.getData();
                if (body == null || body.length() > 3_000_000) return;
                try { command(new JSONObject(body)); } catch (Exception ignored) {}
            }
        });
        target.postWebMessage(new WebMessage("tsukiakari:connect", new WebMessagePort[]{ports[1]}), Uri.parse(origin));
    }

    private void command(JSONObject input) throws Exception {
        switch (input.optString("type")) {
            case "ready" -> { bridgeReady = true; event("visible", foreground); deliverEntry(); }
            case "session" -> {
                String key = input.optString("owner");
                if (!key.matches("(?:admin|member):[a-zA-Z0-9-]{1,80}")) return;
                if (!device.owner().isEmpty() && !key.equals(device.owner())) Notice.clear(this);
                account = key; device.owner(key); CookieManager.getInstance().flush();
                prepareChime(); applyService(); sendPreferences(); deliverEntry();
            }
            case "logout" -> {
                if (input.optBoolean("explicit")) { nextThread = nextAccount = null; }
                account = ""; device.owner(""); Notice.clear(this);
                stopService(new Intent(this, MessageService.class)); CookieManager.getInstance().flush();
            }
            case "connection" -> { disposeWeb(); showConnection(); }
            default -> { if (!account.isEmpty()) authenticated(input); }
        }
    }

    private void authenticated(JSONObject input) throws Exception {
        switch (input.optString("type")) {
            case "preferences" -> sendPreferences();
            case "readSummary" -> {
                var ids = input.optJSONArray("threads");
                if (ids != null) for (int i = 0; i < Math.min(ids.length(), 150); i++) {
                    String id = ids.optString(i);
                    if (Endpoint.thread(id)) Notice.read(this, id, Long.MAX_VALUE);
                }
            }
            case "alert" -> {
                int filter = getSystemService(android.app.NotificationManager.class).getCurrentInterruptionFilter();
                if (!foreground || device.flag(account, "quiet") || filter != android.app.NotificationManager.INTERRUPTION_FILTER_ALL) return;
                if (sound != null && device.flag(account, "sound")) sound.play(chime, .45f, .45f, 1, 0, 1f);
                if (device.flag(account, "vibrate")) getSystemService(android.os.Vibrator.class)
                    .vibrate(android.os.VibrationEffect.createOneShot(35, android.os.VibrationEffect.DEFAULT_AMPLITUDE));
            }
            case "savePreferences" -> {
                JSONObject values = input.optJSONObject("values");
                if (values == null) return;
                device.save(account, values); applyService(); sendPreferences();
                event("status", "设备设置已保存。");
            }
            case "notificationPermission" -> {
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTICES);
                } else sendPreferences();
            }
            case "notificationSettings" -> startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
            case "uninstall" -> {
                try { startActivity(new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + getPackageName()))); }
                catch (RuntimeException unavailable) { event("status", "系统未打开卸载界面，可在应用设置中操作。"); }
            }
            case "export" -> {
                byte[] json = input.optString("json").getBytes(StandardCharsets.UTF_8);
                if (json.length > 2_700_000) { event("status", "导出文件过大，请缩小范围后重试。"); return; }
                selectDestination("application/json", "Tsukiakari-personal.json", out -> out.write(json));
            }
        }
    }

    private void sendPreferences() throws Exception {
        if (!account.isEmpty()) event("preferences", device.values(account));
    }

    private void prepareChime() {
        if (sound != null) return;
        sound = new android.media.SoundPool.Builder().setMaxStreams(1).setAudioAttributes(new android.media.AudioAttributes.Builder()
            .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION).build()).build();
        chime = sound.load(this, R.raw.message, 1);
    }

    private void applyService() {
        Intent service = new Intent(this, MessageService.class);
        if (device.flag(account, "background") && device.allowed()) {
            if (foreground) try { startForegroundService(service); }
            catch (RuntimeException denied) { event("status", "后台连接未能启动。前台聊天仍然可用。"); }
        } else stopService(service);
    }

    @Override protected void onResume() {
        super.onResume();
        try { sendPreferences(); } catch (Exception ignored) {}
        if (!account.isEmpty()) applyService();
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == NOTICES) { applyService(); try { sendPreferences(); } catch (Exception ignored) {} }
    }

    private void event(String type, Object value) {
        if (!bridgeReady || port == null) return;
        try { port.postMessage(new WebMessage(new JSONObject().put("type", type).put("value", value).toString())); }
        catch (Exception ignored) {}
    }

    private interface DocumentJob { void write(OutputStream out) throws Exception; }

    private void selectDestination(String mime, String name, DocumentJob job) {
        if (document != null) { event("status", "请先完成当前的文件选择。"); return; }
        document = job;
        Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime == null ? "application/octet-stream" : mime).putExtra(Intent.EXTRA_TITLE, name);
        try { startActivityForResult(create, SAVE); }
        catch (RuntimeException unavailable) { document = null; event("status", "系统文件选择器暂不可用。"); }
    }

    @Override protected void onActivityResult(int code, int result, Intent intent) {
        super.onActivityResult(code, result, intent);
        if (code == FILE && picker != null) {
            ArrayList<Uri> selected = new ArrayList<>();
            if (result == RESULT_OK && intent != null) {
                if (intent.getClipData() != null) {
                    for (int i = 0; i < Math.min(8, intent.getClipData().getItemCount()); i++) selected.add(intent.getClipData().getItemAt(i).getUri());
                } else if (intent.getData() != null) selected.add(intent.getData());
                selected.removeIf(uri -> uri == null || !"content".equals(uri.getScheme()));
            }
            ValueCallback<Uri[]> callback = picker; picker = null;
            callback.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0]));
        } else if (code == SAVE) {
            DocumentJob job = document; document = null;
            Uri uri = intent == null ? null : intent.getData();
            if (job == null || result != RESULT_OK || uri == null || !"content".equals(uri.getScheme())) return;
            files.execute(() -> {
                boolean success = false;
                try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                    if (out == null) throw new IOException("File unavailable");
                    job.write(out); success = true;
                } catch (Exception ignored) {}
                String message = success ? "文件已保存到所选位置。" : "文件未能保存，可重试。";
                runOnUiThread(() -> event("status", message));
            });
        }
    }

    private void disposeWeb() {
        if (port != null) { port.close(); port = null; }
        bridgeReady = false;
        if (web != null) { root.removeView(web); web.destroy(); web = null; }
    }

    @Override protected void onDestroy() {
        if (picker != null) picker.onReceiveValue(null);
        document = null;
        if (sound != null) sound.release();
        disposeWeb(); files.shutdownNow();
        super.onDestroy();
    }
}
