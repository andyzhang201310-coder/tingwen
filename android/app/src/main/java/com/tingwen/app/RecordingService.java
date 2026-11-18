package com.tingwen.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * 录音期的前台服务（产品文档 5.3「后台录音」）。
 *
 * 为什么必须有它：录音实际发生在 WebView 的 MediaRecorder 里，音频本身是原生采集，
 * 但 30 秒分段的落盘回调（ondataavailable → IndexedDB）要回到 JS 线程执行。
 * 应用退到后台后，没有前台服务时进程降为 cached，JS 会被冻结/节流，
 * 分段回调不再执行，音频堆在 MediaRecorder 的内部缓冲里——回前台之前既没落盘也没校验，
 * 进程一旦被回收这段就真的没了。前台服务把进程钉在前台优先级，并持一把 PARTIAL_WAKE_LOCK
 * 防止 CPU 休眠，分段回调才能按时跑。
 *
 * 类型写死 microphone：Android 14 起前台服务必须声明类型，
 * 且 microphone 类型要求应用启动服务时自己有 RECORD_AUDIO 权限（WebView 录音时已授权）。
 */
public class RecordingService extends Service {
    public static final String ACTION_START = "com.tingwen.app.action.REC_START";
    public static final String ACTION_UPDATE = "com.tingwen.app.action.REC_UPDATE";
    public static final String ACTION_STOP = "com.tingwen.app.action.REC_STOP";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_TEXT = "text";

    private static final String CHANNEL_ID = "tingwen_recording";
    private static final int NOTIF_ID = 1001;
    /** 唤醒锁兜底上限：即便 release 被漏掉，4 小时后也自动放开，不至于一直耗电 */
    private static final long WAKE_TIMEOUT_MS = 4L * 60 * 60 * 1000;

    /** 通知栏「停止」被点 → 回调给插件，由 JS 走正常收尾流程（保存、校验、补存尾句） */
    public interface StopListener {
        void onStopRequested();
    }

    private static StopListener stopListener;

    public static void setStopListener(StopListener listener) {
        stopListener = listener;
    }

    /**
     * 运行中的实例。更新通知文案（录音时长）走这条直通路径，
     * 而不是每次再 startService 一次——Android 8 之后对后台 startService 有限制，
     * 服务已经在前台时也容易踩到 IllegalStateException。
     */
    private static volatile RecordingService instance;

    public static RecordingService getInstance() {
        return instance;
    }

    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
    }

    /** 只更新通知文本，不动前台状态 */
    public void updateText(String title, String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        try {
            nm.notify(NOTIF_ID, buildNotification(title, text));
        } catch (Exception ignored) {
            /* 通知被系统收走时 notify 会失败，不影响录音 */
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            if (stopListener != null) stopListener.onStopRequested();
            stopSelf();
            return START_NOT_STICKY;
        }

        String title = intent == null ? null : intent.getStringExtra(EXTRA_TITLE);
        String text = intent == null ? null : intent.getStringExtra(EXTRA_TEXT);
        /* 必须在 5 秒内 startForeground，否则系统会 ANR 掉服务 */
        pushForeground(buildNotification(title, text));
        acquireWake();
        /* 用 NOT_STICKY：进程被杀后系统重建服务时已经没有录音了，
           STICKY 会留下一个永远显示「正在录音」的僵尸通知 */
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        instance = null;
        releaseWake();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (Exception ignored) {
            /* 服务已不在前台时调用会抛，忽略即可 */
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void pushForeground(Notification n) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID,
                "录音进行中",
                NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("录音时保持应用在后台继续采集与保存音频");
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.enableVibration(false);
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification(String title, String text) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent content = PendingIntent.getActivity(this, 0, open, flags);

        Intent stop = new Intent(this, RecordingService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, flags);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        b.setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle(title == null || title.isEmpty() ? "听文正在录音" : title)
                .setContentText(text == null ? "" : text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setContentIntent(content)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止录音", stopPi);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return b.build();
    }

    private void acquireWake() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm == null) return;
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tingwen:recording");
        wakeLock.setReferenceCounted(false);
        try {
            wakeLock.acquire(WAKE_TIMEOUT_MS);
        } catch (Exception ignored) {
            /* 部分定制系统会限制，拿不到也不影响前台服务本身 */
        }
    }

    private void releaseWake() {
        if (wakeLock == null) return;
        try {
            if (wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
        } finally {
            wakeLock = null;
        }
    }
}
