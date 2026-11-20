package wiki.shion.tsukiakari;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.graphics.Bitmap;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;

final class Notice {
    static final int SERVICE_ID = 5701;
    static final String CONNECTION = "connection";
    private static final int CHAT_ID = 5702;
    private static Bitmap avatar;
    private Notice() {}

    private static NotificationManager manager(Context ctx) { return ctx.getSystemService(NotificationManager.class); }
    private static String tag(String id) { return "chat:" + id; }

    static Notification connection(Context ctx, boolean connected) {
        manager(ctx).createNotificationChannel(new NotificationChannel(CONNECTION, "后台消息连接", NotificationManager.IMPORTANCE_LOW));
        Intent open = new Intent(ctx, MainActivity.class);
        return new Notification.Builder(ctx, CONNECTION).setSmallIcon(R.drawable.ic_notice)
            .setContentTitle("月明かり · 后台消息连接")
            .setContentText(connected ? "正在等待新消息" : "等待连接 · 可在「我的」关闭")
            .setContentIntent(PendingIntent.getActivity(ctx, SERVICE_ID, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
            .setOnlyAlertOnce(true).setShowWhen(false).setOngoing(true).build();
    }

    private static String channel(Context ctx, boolean sound, boolean vibrate) {
        String id = "chat_" + (sound ? "sound" : "quiet") + (vibrate ? "_vibrate" : "");
        NotificationChannel channel = new NotificationChannel(id,
            "消息 · " + (sound && vibrate ? "提示音与振动" : sound ? "提示音" : vibrate ? "振动" : "静默"),
            sound || vibrate ? NotificationManager.IMPORTANCE_DEFAULT : NotificationManager.IMPORTANCE_LOW);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        channel.enableVibration(vibrate);
        channel.setSound(sound ? Uri.parse("android.resource://" + ctx.getPackageName() + "/" + R.raw.message) : null,
            new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build());
        manager(ctx).createNotificationChannel(channel);
        return id;
    }

    static void message(Context ctx, Device device, String owner, String id, String kind, String title, String sender,
                        String body, long through, int unread, boolean catchUp) {
        if (!device.allowed() || device.flag(owner, "quiet") || !owner.equals(device.owner())) return;
        if (kind.equals("group") && !device.flag(owner, "groups")) return;
        boolean preview = device.flag(owner, "preview");
        String channel = channel(ctx, !catchUp && device.flag(owner, "sound"), !catchUp && device.flag(owner, "vibrate"));
        String brief = unread > 1 ? "月明かり收到 " + unread + " 条新消息" : "月明かり收到一条新消息";
        String conversation = switch (kind) { case "group" -> "群聊"; case "ai" -> "AI"; default -> "好友"; };
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse("tsukiakari://notice/" + id), ctx, MainActivity.class)
            .putExtra("owner", owner).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(ctx, CHAT_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification publicNotice = new Notification.Builder(ctx, channel).setSmallIcon(R.drawable.ic_notice)
            .setContentTitle("月明かり").setContentText(brief).build();
        Intent mark = new Intent(ctx, ReadAction.class).setData(Uri.parse("tsukiakari://read/" + id + "/" + through)).putExtra("owner", owner);
        PendingIntent action = PendingIntent.getBroadcast(ctx, CHAT_ID, mark, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Action.Builder command = new Notification.Action.Builder(android.graphics.drawable.Icon.createWithResource(ctx, R.drawable.ic_notice), "标记已读", action);
        if (Build.VERSION.SDK_INT >= 31) command.setAuthenticationRequired(true);
        String text = preview ? (sender.isEmpty() ? body : sender + " · " + body) : brief;
        var extra = new android.os.Bundle(); extra.putLong("through", through);
        if (avatar == null) avatar = BitmapFactory.decodeResource(ctx.getResources(), R.drawable.brand_art);
        Notification message = new Notification.Builder(ctx, channel).setSmallIcon(R.drawable.ic_notice)
            .setLargeIcon(avatar)
            .setContentTitle(preview ? conversation + " · " + title : "月明かり")
            .setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text))
            .setCategory(Notification.CATEGORY_MESSAGE).setVisibility(preview ? Notification.VISIBILITY_PUBLIC : Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(preview ? null : publicNotice).setNumber(unread).setContentIntent(content).setAutoCancel(true)
            .addAction(command.build()).addExtras(extra).setOnlyAlertOnce(catchUp).build();
        manager(ctx).notify(tag(id), CHAT_ID, message);
    }

    static void clear(Context ctx) {
        for (var item : manager(ctx).getActiveNotifications()) if (item.getId() == CHAT_ID) manager(ctx).cancel(item.getTag(), CHAT_ID);
    }

    static void read(Context ctx, String id, long through) {
        for (var item : manager(ctx).getActiveNotifications()) {
            if (item.getId() == CHAT_ID && tag(id).equals(item.getTag()) && item.getNotification().extras.getLong("through") <= through) manager(ctx).cancel(tag(id), CHAT_ID);
        }
    }
}
