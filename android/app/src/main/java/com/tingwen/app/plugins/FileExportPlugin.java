package com.tingwen.app.plugins;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 文件导出插件：把 WebView 里生成的 Blob（音频、Word、字幕…）真正写到手机存储。
 *
 * 为什么需要它：网页端的导出走 <a download> + blob: 链接，安卓 WebView 不支持这条路径
 * （Capacitor 默认也没有 DownloadListener），点了会静默失败，只弹一个假的「已导出」提示。
 *
 * 写入位置：Android 10+ 用 MediaStore 放进「下载/听文/」，卸载应用后文件仍在，
 * 且无需任何存储权限；Android 9 及以下没有分区存储，退而写到应用专属外部目录。
 *
 * 协议：open → append（分块 base64，避免一次把几十 MB 音频塞进桥接）→ close。
 * close 时若 share=true，顺带拉起系统分享面板。
 */
@CapacitorPlugin(name = "FileExport")
public class FileExportPlugin extends Plugin {
    private static final String TAG = "FileExport";
    /** 下载目录下的子文件夹，避免和系统下载混在一起 */
    private static final String SUB_DIR = "听文";

    private static class Handle {
        OutputStream out;
        Uri uri;
        File file;
        String name;
        String mime;
    }

    private final Map<String, Handle> handles = new HashMap<>();

    @PluginMethod
    public void open(PluginCall call) {
        String name = safeName(call.getString("name", "tingwen"));
        String mime = call.getString("mime", "application/octet-stream");
        Handle h = new Handle();
        h.name = name;
        h.mime = mime;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver cr = getContext().getContentResolver();
                String rel = Environment.DIRECTORY_DOWNLOADS + File.separator + SUB_DIR + File.separator;
                /* 同名文件直接覆盖：否则同一场录音导出两次会堆出「… (1).wav」「… (2).wav」，
                   用户根本分不清哪份是新的。只动我们自己的子目录。 */
                try {
                    cr.delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                            MediaStore.MediaColumns.DISPLAY_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + "=?",
                            new String[]{ name, rel });
                } catch (Exception e) {
                    Log.w(TAG, "replace existing file failed: " + e.getMessage());
                }
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + File.separator + SUB_DIR);
                cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) {
                    call.reject("无法在下载目录创建文件");
                    return;
                }
                h.uri = uri;
                h.out = cr.openOutputStream(uri);
            } else {
                /* Android 9 及以下：写应用专属目录，不需要运行时权限 */
                File dir = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), SUB_DIR);
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("无法创建导出目录");
                    return;
                }
                File f = new File(dir, name);
                h.file = f;
                h.out = new FileOutputStream(f);
            }
            if (h.out == null) {
                call.reject("无法打开输出流");
                return;
            }
            String id = UUID.randomUUID().toString();
            handles.put(id, h);
            JSObject ret = new JSObject();
            ret.put("id", id);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "open failed", e);
            call.reject("打开文件失败：" + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void append(PluginCall call) {
        String id = call.getString("id");
        String data = call.getString("data");
        Handle h = id == null ? null : handles.get(id);
        if (h == null || h.out == null) {
            call.reject("写入会话已失效");
            return;
        }
        try {
            if (data != null && !data.isEmpty()) {
                h.out.write(Base64.decode(data, Base64.DEFAULT));
            }
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "append failed", e);
            call.reject("写入失败：" + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        String id = call.getString("id");
        boolean share = Boolean.TRUE.equals(call.getBoolean("share", false));
        Handle h = id == null ? null : handles.remove(id);
        if (h == null) {
            call.reject("写入会话已失效");
            return;
        }
        try {
            if (h.out != null) {
                h.out.flush();
                h.out.close();
            }
            if (h.uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContext().getContentResolver().update(h.uri, done, null, null);
            }
        } catch (Exception e) {
            Log.e(TAG, "close failed", e);
            call.reject("保存失败：" + e.getMessage(), e);
            return;
        }

        String shownPath = h.uri != null ? "Download/" + SUB_DIR + "/" + h.name : h.file.getAbsolutePath();
        if (share) shareUri(h.uri, h.file, h.mime);

        JSObject ret = new JSObject();
        ret.put("path", shownPath);
        ret.put("uri", h.uri != null ? h.uri.toString() : "");
        call.resolve(ret);
    }

    /** 拉起系统分享面板（微信、邮件、网盘都在这张表里） */
    private void shareUri(Uri uri, File file, String mime) {
        try {
            Uri target = uri;
            if (target == null && file != null) {
                target = androidx.core.content.FileProvider.getUriForFile(
                        getContext(), getContext().getPackageName() + ".fileprovider", file);
            }
            if (target == null) return;
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime != null ? mime : "application/octet-stream");
            send.putExtra(Intent.EXTRA_STREAM, target);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "分享");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
        } catch (Exception e) {
            Log.e(TAG, "share failed", e);
        }
    }

    /** 文件名只留最后一段，去掉路径分隔符，防止写到下载目录之外 */
    private String safeName(String raw) {
        String name = raw == null ? "tingwen" : raw.trim();
        int cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (cut >= 0) name = name.substring(cut + 1);
        name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        if (name.isEmpty()) name = "tingwen";
        return name.length() > 120 ? name.substring(0, 120) : name;
    }
}
