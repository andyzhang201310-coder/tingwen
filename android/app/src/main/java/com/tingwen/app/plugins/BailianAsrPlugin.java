package com.tingwen.app.plugins;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.UUID;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * 百炼实时语音识别（DashScope WebSocket 协议）Capacitor 插件。
 *
 * 为什么不用官方 AAR：官方 Fun-ASR Android SDK 精简包缺少端侧 CEI 模型，
 * startDialog 之后会在 asr_main_thr 里空指针崩溃（SIGSEGV in vfprintf），
 * 真机上表现为「一直不出字」。这里直接用 OkHttp 开 WebSocket，
 * 由原生层补 Authorization 头（WebView 的 WebSocket 不能自定义请求头），
 * 协议与网页端 asr-proxy.mjs 完全一致：
 *
 *   1) ws 连上 → 发 run-task
 *   2) 收到 task-started → 开始接收二进制 PCM（16k/16bit/mono，100ms 一帧）
 *   3) result-generated → payload.output.sentence.text / sentence_end
 *   4) 结束时发 finish-task → 收到 task-finished
 *
 * JS 侧接口与旧 SDK 版一致：init / start / pushPcm / stop / release。
 */
@CapacitorPlugin(name = "BailianAsr")
public class BailianAsrPlugin extends Plugin {
    private static final String TAG = "BailianAsr";

    private static final String DEFAULT_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
    private static final int FRAME_BYTES = 3200;   // 100ms @ 16k/16bit/mono

    private OkHttpClient client;
    private WebSocket ws;

    private String key = "";
    private String model = "fun-asr-realtime";
    private String lang = "zh";
    private String workspaceId = "";
    private String taskId = "";

    private volatile boolean started = false;
    private int frameCount = 0;
    private volatile boolean intentionalStop = false;
    /** 已连接但还没收到 task-started 时，先攒最多 1 秒音频，避免开头丢字 */
    private final java.util.LinkedList<byte[]> pending = new java.util.LinkedList<>();

    @PluginMethod
    public void init(PluginCall call) {
        String k = call.getString("key", "");
        if (k == null || k.trim().isEmpty()) {
            call.reject("missing_key");
            return;
        }
        key = k.trim();
        String m = call.getString("model", "fun-asr-realtime");
        model = (m == null || m.trim().isEmpty()) ? "fun-asr-realtime" : m.trim();
        String l = call.getString("lang", "zh");
        lang = (l != null && l.toLowerCase().startsWith("en")) ? "en" : "zh";
        String w = call.getString("workspaceId", "");
        workspaceId = (w == null) ? "" : w.trim();

        client = new OkHttpClient.Builder()
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .connectTimeout(12, TimeUnit.SECONDS)
                .pingInterval(20, TimeUnit.SECONDS)
                .build();

        JSObject ok = new JSObject();
        ok.put("ok", true);
        call.resolve(ok);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (key.isEmpty()) {
            call.reject("not_initialized");
            return;
        }
        if (client == null) {
            client = new OkHttpClient.Builder()
                    .readTimeout(0, TimeUnit.MILLISECONDS)
                    .connectTimeout(12, TimeUnit.SECONDS)
                    .pingInterval(20, TimeUnit.SECONDS)
                    .build();
        }
        intentionalStop = false;
        started = false;
        synchronized (pending) { pending.clear(); }
        emitStatus("starting", null);

        /* 先同步返回，连接结果通过 status 事件回传，避免弱网时 JS 卡在「识别启动中」 */
        JSObject ok = new JSObject();
        ok.put("ok", true);
        call.resolve(ok);

        String url = DEFAULT_URL;
        Request.Builder rb = new Request.Builder().url(url);
        rb.header("Authorization", "Bearer " + key);
        if (!workspaceId.isEmpty()) {
            rb.header("X-DashScope-WorkSpace", workspaceId);
            rb.header("X-DashScope-Workspace", workspaceId);
        }
        /* 部分网关要求带 User-Agent，OkHttp 默认 OkHttp/x.y 会被拦 */
        rb.header("User-Agent", "TingWen/1.9 (Android)");

        taskId = UUID.randomUUID().toString();
        Log.i(TAG, "connect " + url + " model=" + model + " lang=" + lang);
        ws = client.newWebSocket(rb.build(), listener);
    }

    /** 推送一帧 16kHz/16bit/mono PCM（base64）。 */
    @PluginMethod
    public void pushPcm(PluginCall call) {
        /* 每帧都必须 resolve：JS 侧是 await 调用的，不 resolve 会让推流在第一帧后永久挂起 */
        try {
            handlePcm(call.getString("data", ""));
        } finally {
            call.resolve();
        }
    }

    private void handlePcm(String b64) {
        if (b64 == null || b64.isEmpty() || ws == null) return;
        byte[] pcm;
        try {
            pcm = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
        } catch (Exception e) {
            return;
        }
        if (pcm.length == 0) return;

        if (started) {
            frameCount++;
            if (frameCount % 20 == 1) Log.i(TAG, "pcm frame " + frameCount + " len=" + pcm.length + " ws=" + (ws != null));
            sendBinary(pcm);
        } else {
            /* 还没 task-started：先攒 1 秒，连上后立即补发，避免开头被吃掉 */
            synchronized (pending) {
                pending.add(pcm);
                while (pending.size() > 10) pending.removeFirst();
            }
        }
    }

    private void sendBinary(byte[] pcm) {
        WebSocket w = ws;
        if (w == null) return;
        try {
            boolean ok = w.send(ByteString.of(pcm, 0, pcm.length));
            if (!ok) Log.w(TAG, "send returned false, queue full or closed");
        } catch (Exception e) {
            Log.w(TAG, "sendBinary: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        intentionalStop = true;
        started = false;
        try {
            if (ws != null) {
                JSONObject header = new JSONObject();
                header.put("action", "finish-task");
                header.put("task_id", taskId);
                header.put("streaming", "duplex");
                JSONObject payload = new JSONObject();
                payload.put("input", new JSONObject());
                JSONObject msg = new JSONObject();
                msg.put("header", header);
                msg.put("payload", payload);
                ws.send(msg.toString());
            }
        } catch (Exception e) {
            Log.w(TAG, "finish-task: " + e.getMessage());
        }
        /* 留 900ms 收尾句与 task-finished，再断开 */
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            try { if (ws != null) ws.close(1000, "stop"); } catch (Exception ignore) { }
            ws = null;
        }, 900);

        JSObject ok = new JSObject();
        ok.put("ok", true);
        call.resolve(ok);
    }

    @PluginMethod
    public void release(PluginCall call) {
        intentionalStop = true;
        started = false;
        try {
            if (ws != null) ws.cancel();
        } catch (Exception ignore) { }
        ws = null;
        synchronized (pending) { pending.clear(); }
        JSObject ok = new JSObject();
        ok.put("ok", true);
        call.resolve(ok);
    }

    private final WebSocketListener listener = new WebSocketListener() {
        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            Log.i(TAG, "ws open, sending run-task");
            try {
                JSONObject header = new JSONObject();
                header.put("action", "run-task");
                header.put("task_id", taskId);
                header.put("streaming", "duplex");

                JSONObject parameters = new JSONObject();
                parameters.put("format", "pcm");
                parameters.put("sample_rate", 16000);
                parameters.put("punctuation_prediction_enabled", true);
                parameters.put("heartbeat", true);
                if (!"auto".equals(lang)) {
                    org.json.JSONArray hints = new org.json.JSONArray();
                    hints.put(lang);
                    parameters.put("language_hints", hints);
                }

                JSONObject payload = new JSONObject();
                payload.put("task_group", "audio");
                payload.put("task", "asr");
                payload.put("function", "recognition");
                payload.put("model", model);
                payload.put("input", new JSONObject());
                payload.put("parameters", parameters);

                JSONObject msg = new JSONObject();
                msg.put("header", header);
                msg.put("payload", payload);
                webSocket.send(msg.toString());
            } catch (Exception e) {
                Log.e(TAG, "run-task build failed", e);
                emitStatus("error", "run_task_build");
            }
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            try {
                JSONObject evt = new JSONObject(text);
                JSONObject header = evt.optJSONObject("header");
                String event = header != null ? header.optString("event", "") : "";
                JSONObject payload = evt.optJSONObject("payload");

                if ("task-started".equals(event)) {
                    started = true;
                    Log.i(TAG, "task-started");
                    emitStatus("listening", null);
                    flushPending();
                    return;
                }
                if ("result-generated".equals(event) || "transcription-generated".equals(event)) {
                    JSONObject output = payload != null ? payload.optJSONObject("output") : null;
                    if (output == null) return;
                    JSONObject sentence = output.optJSONObject("sentence");
                    String t = sentence != null ? sentence.optString("text", "") : output.optString("text", "");
                    boolean end = sentence != null && sentence.optBoolean("sentence_end", false);
                    t = t == null ? "" : t.trim();
                    if (t.isEmpty()) return;
                    JSObject d = new JSObject();
                    d.put("text", t);
                    if (end) {
                        d.put("final", true);
                        notifyListeners("final", d);
                    } else {
                        notifyListeners("interim", d);
                    }
                    return;
                }
                if ("task-finished".equals(event)) {
                    started = false;
                    emitStatus("completed", null);
                    return;
                }
                if ("task-failed".equals(event)) {
                    String code = header != null ? header.optString("error_code", "task_failed") : "task_failed";
                    String msg = header != null ? header.optString("error_message", "") : "";
                    Log.e(TAG, "task-failed " + code + " " + msg);
                    started = false;
                    emitStatus("error", code);
                }
            } catch (Exception e) {
                Log.w(TAG, "onMessage parse: " + e.getMessage());
            }
        }

        @Override
        public void onMessage(WebSocket webSocket, ByteString bytes) {
            onMessage(webSocket, bytes.utf8());
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, Response response) {
            int code = response != null ? response.code() : 0;
            String reason = t != null ? t.getMessage() : "unknown";
            Log.e(TAG, "ws failure code=" + code + " reason=" + reason);
            started = false;
            if (!intentionalStop) {
                emitStatus("error", code > 0 ? String.valueOf(code) : ("ws_" + reason));
            }
        }

        @Override
        public void onClosing(WebSocket webSocket, int code, String reason) {
            webSocket.close(1000, null);
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            Log.i(TAG, "ws closed " + code);
            started = false;
            if (!intentionalStop) emitStatus("error", "closed_" + code);
        }
    };

    private void flushPending() {
        java.util.List<byte[]> frames;
        synchronized (pending) {
            frames = new java.util.ArrayList<>(pending);
            pending.clear();
        }
        for (byte[] f : frames) sendBinary(f);
    }

    private void emitStatus(String state, String code) {
        try {
            JSObject s = new JSObject();
            s.put("state", state);
            if (code != null) s.put("code", code);
            notifyListeners("status", s);
        } catch (Exception e) {
            Log.w(TAG, "emitStatus: " + e.getMessage());
        }
    }

    @Override
    protected void handleOnDestroy() {
        intentionalStop = true;
        try { if (ws != null) ws.cancel(); } catch (Exception ignore) { }
        ws = null;
        super.handleOnDestroy();
    }
}
