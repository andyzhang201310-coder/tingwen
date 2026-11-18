package com.tingwen.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.tingwen.app.plugins.BailianAsrPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        /* Capacitor 默认把每次插件调用的参数都打进 logcat，
           pushPcm 每 100ms 一帧带 4KB base64，会淹没日志缓冲区并拖慢桥接。
           日志级别改由 capacitor.config.json 的 loggingBehavior=none 控制。 */
        // 在 super.onCreate 之前注册原生插件（Capacitor 官方要求）
        registerPlugin(BailianAsrPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
