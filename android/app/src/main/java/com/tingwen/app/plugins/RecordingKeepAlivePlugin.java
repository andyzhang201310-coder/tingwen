package com.tingwen.app.plugins;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.tingwen.app.RecordingService;

/**
 * 录音保活插件：把 WebView 里开始的录音挂上一个前台服务，
 * 让 30 秒分段的落盘回调在切后台 / 锁屏时还能被执行（产品文档 5.3）。
 *
 * 注意这里不做任何音频采集——采集仍在 WebView 的 MediaRecorder 里，
 * 本插件只负责「进程别被冻住」和「给用户一个看得见、能停止的入口」。
 */
@CapacitorPlugin(
        name = "RecordingKeepAlive",
        permissions = {
                @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
        }
)
public class RecordingKeepAlivePlugin extends Plugin {
    private static final String TAG = "RecordingKeepAlive";

    @Override
    public void load() {
        /* 用户在通知栏点「停止录音」→ 交给 JS 走正常收尾，不能直接杀服务，
           否则最后几秒的分段和尾句会来不及落盘 */
        RecordingService.setStopListener(() -> {
            try {
                notifyListeners("stopRequested", new JSObject());
            } catch (Exception e) {
                Log.w(TAG, "notifyListeners failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        /* 用户拒绝通知权限也照样启动：Android 只是把通知隐藏起来，
           不会阻止前台服务运行。后台录音能力不该被一条通知的授权挡住。 */
        doStart(call);
    }

    private void doStart(PluginCall call) {
        String title = call.getString("title", "听文正在录音");
        String text = call.getString("text", "");
        Intent i = new Intent(getContext(), RecordingService.class)
                .setAction(RecordingService.ACTION_START)
                .putExtra(RecordingService.EXTRA_TITLE, title)
                .putExtra(RecordingService.EXTRA_TEXT, text);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(i);
            } else {
                getContext().startService(i);
            }
            /* 把通知授权状态一并回给 JS：用户拒绝了通知权限时服务照样跑，
               但锁屏后看不到「停止录音」，得让界面说明这一点 */
            JSObject ok = new JSObject();
            ok.put("running", true);
            ok.put("notif", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                    || getPermissionState("notifications") == PermissionState.GRANTED);
            call.resolve(ok);
        } catch (Exception e) {
            /* 前台服务启动被系统拒绝时不要连累录音本身，录音继续，只是失去后台保护 */
            Log.w(TAG, "startForegroundService failed: " + e.getMessage());
            JSObject r = new JSObject();
            r.put("running", false);
            r.put("reason", e.getClass().getSimpleName());
            call.resolve(r);
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        RecordingService svc = RecordingService.getInstance();
        if (svc != null) {
            String title = call.getString("title", "听文正在录音");
            String text = call.getString("text", "");
            svc.updateText(title, text);
        }
        JSObject r = new JSObject();
        r.put("running", svc != null);
        call.resolve(r);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), RecordingService.class));
        } catch (Exception e) {
            Log.w(TAG, "stopService failed: " + e.getMessage());
        }
        JSObject r = new JSObject();
        r.put("running", false);
        call.resolve(r);
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        JSObject r = new JSObject();
        r.put("running", RecordingService.getInstance() != null);
        call.resolve(r);
    }
}
