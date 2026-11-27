package com.tingwen.app.plugins;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
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
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
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
 * 音频要转码：安卓 WebView 的 MediaRecorder 只吐 webm/opus（老 WebView 连 audio/mp4
 * 都不支持），这种封装微信、华为音乐、车机基本都打不开。所以 open 时带 convertTo
 * 就先把字节写到缓存里的临时文件，close 时用 MediaCodec 解码 opus → 编码 AAC，
 * 由 MediaMuxer 封成 .m4a，再搬进下载目录。转码失败不影响导出：原样保存原始封装。
 *
 * 协议：open → append（分块 base64，避免一次把几十 MB 音频塞进桥接）→ close。
 * close 时若 share=true，顺带拉起系统分享面板。
 */
@CapacitorPlugin(name = "FileExport")
public class FileExportPlugin extends Plugin {
    private static final String TAG = "FileExport";
    /** 下载目录下的子文件夹，避免和系统下载混在一起 */
    private static final String SUB_DIR = "听文";
    /** 转码目标：AAC-LC 封装进 MP4（.m4a），微信/华为音乐/车机都认 */
    private static final String MIME_AAC = "audio/mp4a-latm";
    private static final String MIME_M4A = "audio/mp4";
    /** 语音够用的码率：48 kbps 单声道约 21MB/小时，比 webm 原文件还小一点 */
    private static final int AAC_BITRATE = 48000;
    /** 转码总时长上限，防解码器异常时空转 */
    private static final long MAX_TRANSCODE_MS = 30 * 60 * 1000L;

    private static class Handle {
        OutputStream out;
        File tmp;        // 临时文件（写完再搬进下载目录）
        String name;     // 目标文件名
        String mime;
        String convertTo; // 需要转码的目标 MIME；空表示原样保存
    }

    private final Map<String, Handle> handles = new HashMap<>();

    @PluginMethod
    public void open(PluginCall call) {
        String name = safeName(call.getString("name", "tingwen"));
        String mime = call.getString("mime", "application/octet-stream");
        String convertTo = call.getString("convertTo", "");
        Handle h = new Handle();
        h.name = name;
        h.mime = mime;
        h.convertTo = convertTo == null || convertTo.isEmpty() ? null : convertTo;
        try {
            /* 一律先写临时文件：转码要从文件读，直接落下载目录的话失败会留下半个坏文件 */
            File dir = new File(getContext().getCacheDir(), "export");
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("无法创建临时目录");
                return;
            }
            File tmp = new File(dir, UUID.randomUUID().toString() + ".part");
            h.tmp = tmp;
            h.out = new FileOutputStream(tmp);
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
        /* 转码可能跑几十秒（一小时的录音），不能在桥接线程上同步做完 */
        new Thread(() -> finish(call, h, share)).start();
    }

    /** 关流 →（可选）转码 → 搬进下载目录 →（可选）分享 */
    private void finish(PluginCall call, Handle h, boolean share) {
        File tmp = h.tmp;
        File produced = null;
        try {
            if (h.out != null) {
                h.out.flush();
                h.out.close();
            }
        } catch (Exception e) {
            Log.e(TAG, "close failed", e);
            deleteQuietly(tmp);
            call.reject("保存失败：" + e.getMessage(), e);
            return;
        }

        File source = tmp;
        String name = h.name;
        String mime = h.mime;
        boolean converted = false;

        if (h.convertTo != null && tmp != null && tmp.length() > 0) {
            File dst = new File(tmp.getParentFile(), UUID.randomUUID().toString() + ".m4a");
            try {
                long t0 = System.currentTimeMillis();
                transcodeToM4a(tmp, dst);
                source = dst;
                produced = dst;
                name = swapExt(name, "m4a");
                mime = MIME_M4A;
                converted = true;
                Log.i(TAG, "transcode ok, " + tmp.length() + " → " + dst.length()
                        + " bytes, " + (System.currentTimeMillis() - t0) + "ms");
            } catch (Exception e) {
                /* 转码失败也要把文件给用户：原封装原样落盘，前端会提示一句 */
                Log.e(TAG, "transcode failed, fallback to original", e);
                deleteQuietly(dst);
            }
        }

        String shownPath;
        Uri uri = null;
        File legacyFile = null;
        try {
            if (source == null || !source.exists()) throw new Exception("临时文件不存在");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                uri = writeToDownloads(source, name, mime);
                shownPath = "Download/" + SUB_DIR + "/" + name;
            } else {
                legacyFile = writeToAppDir(source, name);
                shownPath = legacyFile.getAbsolutePath();
            }
        } catch (Exception e) {
            Log.e(TAG, "save failed", e);
            deleteQuietly(tmp);
            deleteQuietly(produced);
            call.reject("保存失败：" + e.getMessage(), e);
            return;
        } finally {
            /* tmp 与转码产物都是中间文件，落盘完就删；没走到这里说明失败，上面的 catch 已经清过 */
            deleteQuietly(tmp);
            if (produced != null && produced != tmp) deleteQuietly(produced);
        }

        if (share) shareUri(uri, legacyFile, mime);

        JSObject ret = new JSObject();
        ret.put("path", shownPath);
        ret.put("uri", uri != null ? uri.toString() : "");
        ret.put("converted", converted);
        call.resolve(ret);
    }

    /* ── 落盘 ── */

    /** Android 10+：MediaStore 写入「下载/听文/」，同名覆盖，不需要任何权限 */
    private Uri writeToDownloads(File src, String name, String mime) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        String rel = Environment.DIRECTORY_DOWNLOADS + File.separator + SUB_DIR + File.separator;
        /* 同名文件直接覆盖：否则同一场录音导出两次会堆出「… (1).m4a」「… (2).m4a」，
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
        if (uri == null) throw new Exception("无法在下载目录创建文件");
        InputStream in = null;
        OutputStream out = null;
        try {
            in = new FileInputStream(src);
            out = cr.openOutputStream(uri);
            if (out == null) throw new Exception("无法打开输出流");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
        } catch (Exception e) {
            try { cr.delete(uri, null, null); } catch (Exception ignored) { /* 忽略 */ }
            throw e;
        } finally {
            closeQuietly(in);
            closeQuietly(out);
        }
        ContentValues done = new ContentValues();
        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(uri, done, null, null);
        return uri;
    }

    /** Android 9 及以下：写应用专属目录，不需要运行时权限 */
    private File writeToAppDir(File src, String name) throws Exception {
        File dir = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), SUB_DIR);
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建导出目录");
        File f = new File(dir, name);
        InputStream in = null;
        OutputStream out = null;
        try {
            in = new FileInputStream(src);
            out = new FileOutputStream(f);
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
        } finally {
            closeQuietly(in);
            closeQuietly(out);
        }
        return f;
    }

    /* ── 转码：webm/opus（或任意音频）→ AAC in MP4 ── */

    private void transcodeToM4a(File src, File dst) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        MediaCodec dec = null;
        MediaCodec enc = null;
        MediaMuxer muxer = null;
        try {
            extractor.setDataSource(src.getAbsolutePath());
            int track = -1;
            MediaFormat inFmt = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat f = extractor.getTrackFormat(i);
                String m = f.getString(MediaFormat.KEY_MIME);
                if (m != null && m.startsWith("audio/")) {
                    track = i;
                    inFmt = f;
                    break;
                }
            }
            if (track < 0 || inFmt == null) throw new Exception("没有音频轨道");
            extractor.selectTrack(track);

            String inMime = inFmt.getString(MediaFormat.KEY_MIME);
            int sampleRate = inFmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)
                    ? inFmt.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 48000;
            int channels = inFmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT)
                    ? inFmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 1;
            if (sampleRate <= 0) sampleRate = 48000;
            if (channels <= 0) channels = 1;

            dec = MediaCodec.createDecoderByType(inMime);
            dec.configure(inFmt, null, null, 0);
            dec.start();

            MediaFormat outFmt = MediaFormat.createAudioFormat(MIME_AAC, sampleRate, channels);
            outFmt.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
            outFmt.setInteger(MediaFormat.KEY_BIT_RATE, AAC_BITRATE);
            outFmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 64 * 1024);
            enc = MediaCodec.createEncoderByType(MIME_AAC);
            enc.configure(outFmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            enc.start();

            muxer = new MediaMuxer(dst.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);

            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            int muxTrack = -1;
            boolean muxStarted = false;
            boolean inputDone = false;
            boolean decDone = false;
            boolean encEos = false;
            boolean encDone = false;
            long deadline = System.currentTimeMillis() + MAX_TRANSCODE_MS;

            /* 解码出来的 PCM 先落在这个缓冲里，等编码器有空再送。
               以前是「拿不到编码器输入就 sleep 5ms 重试」，400 帧就是几秒的纯等待，
               长录音能拖到半小时；改成暂存 + 非阻塞，CPU 跑满就快了一个数量级。 */
            ByteBuffer pcmBuf = ByteBuffer.allocateDirect(256 * 1024);
            int pcmLen = -1;          // >0 表示有一帧 PCM 等着送
            long pcmPts = 0;
            long lastPts = 0;
            long lastWrittenPts = -1;
            int samples = 0;
            int ptsFixes = 0;

            while (!encDone) {
                if (System.currentTimeMillis() > deadline) throw new Exception("转码超时");
                boolean progress = false;

                /* 1) 送压缩帧给解码器（非阻塞） */
                if (!inputDone) {
                    int inIdx = dec.dequeueInputBuffer(0);
                    if (inIdx >= 0) {
                        ByteBuffer buf = dec.getInputBuffer(inIdx);
                        int size = buf == null ? -1 : extractor.readSampleData(buf, 0);
                        if (size < 0) {
                            dec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            dec.queueInputBuffer(inIdx, 0, size, extractor.getSampleTime(), 0);
                            extractor.advance();
                        }
                        progress = true;
                    }
                }

                /* 2) 解码出 PCM，暂存起来（上一帧还没送出去就先不取） */
                if (!decDone && pcmLen <= 0) {
                    int outIdx = dec.dequeueOutputBuffer(info, 0);
                    if (outIdx >= 0) {
                        int size = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0 ? 0 : info.size;
                        if (size > 0) {
                            ByteBuffer pcm = dec.getOutputBuffer(outIdx);
                            if (pcm != null) {
                                pcm.position(info.offset);
                                pcm.limit(info.offset + size);
                                if (pcmBuf.capacity() < size) pcmBuf = ByteBuffer.allocateDirect(size);
                                pcmBuf.clear();
                                pcmBuf.put(pcm);
                                pcmLen = size;
                                pcmPts = info.presentationTimeUs;
                                lastPts = pcmPts;
                            }
                        }
                        dec.releaseOutputBuffer(outIdx, false);
                        if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) decDone = true;
                        progress = true;
                    }
                }

                /* 3) PCM 送进编码器；都送完了给编码器发 EOS */
                if (pcmLen > 0) {
                    int encIn = enc.dequeueInputBuffer(0);
                    if (encIn >= 0) {
                        ByteBuffer dstBuf = enc.getInputBuffer(encIn);
                        if (dstBuf != null) {
                            dstBuf.clear();
                            pcmBuf.position(0);
                            pcmBuf.limit(pcmLen);
                            dstBuf.put(pcmBuf);
                            enc.queueInputBuffer(encIn, 0, pcmLen, pcmPts, 0);
                            pcmLen = -1;
                        } else {
                            /* 正常不会走到这里（输入缓冲总是可读的）：把这块空着还回去，
                               避免占着编码器的输入槽，下一轮再送这帧 PCM */
                            enc.queueInputBuffer(encIn, 0, 0, pcmPts, 0);
                        }
                        progress = true;
                    }
                } else if (decDone && !encEos) {
                    int encIn = enc.dequeueInputBuffer(0);
                    if (encIn >= 0) {
                        enc.queueInputBuffer(encIn, 0, 0, lastPts, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                        encEos = true;
                        progress = true;
                    }
                }

                /* 4) 编码出来的包一次抽干，写进 MP4 */
                while (true) {
                    int encIdx = enc.dequeueOutputBuffer(info, 0);
                    if (encIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        if (!muxStarted) {
                            muxTrack = muxer.addTrack(enc.getOutputFormat());
                            muxer.start();
                            muxStarted = true;
                        }
                        progress = true;
                        continue;
                    }
                    if (encIdx < 0) break;
                    boolean eos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0;
                    if (info.size > 0 && muxStarted) {
                        ByteBuffer out = enc.getOutputBuffer(encIdx);
                        if (out != null) {
                            /* MP4 要求同一轨的时间戳严格递增，编码器偶发重复/回退时
                               writeSampleData 会直接抛 IllegalStateException（整次转码白干），
                               这里把时间戳顶上去一格，宁可差 1ms 也不丢这帧音频。 */
                            if (samples > 0 && info.presentationTimeUs <= lastWrittenPts) {
                                info.presentationTimeUs = lastWrittenPts + 1000;
                                ptsFixes++;
                            }
                            out.position(info.offset);
                            out.limit(info.offset + info.size);
                            try {
                                muxer.writeSampleData(muxTrack, out, info);
                            } catch (Exception e) {
                                Log.e(TAG, "writeSampleData failed #" + samples
                                        + " pts=" + info.presentationTimeUs
                                        + " size=" + info.size + " offset=" + info.offset
                                        + " flags=" + info.flags
                                        + " cap=" + out.capacity());
                                throw e;
                            }
                            lastWrittenPts = info.presentationTimeUs;
                            samples++;
                        }
                    }
                    enc.releaseOutputBuffer(encIdx, false);
                    progress = true;
                    if (eos) encDone = true;
                }

                /* 全链路都暂时没进展（编码器在憋帧）才让出一小会儿 CPU */
                if (!progress && !encDone) {
                    try { Thread.sleep(1); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
                }
            }
            Log.i(TAG, "transcode samples=" + samples + " ptsFixes=" + ptsFixes
                    + " muxStarted=" + muxStarted);
        } finally {
            try { if (dec != null) dec.stop(); } catch (Exception ignored) { /* 忽略 */ }
            try { if (dec != null) dec.release(); } catch (Exception ignored) { /* 忽略 */ }
            try { if (enc != null) enc.stop(); } catch (Exception ignored) { /* 忽略 */ }
            try { if (enc != null) enc.release(); } catch (Exception ignored) { /* 忽略 */ }
            try { extractor.release(); } catch (Exception ignored) { /* 忽略 */ }
            try { if (muxer != null) muxer.stop(); } catch (Exception ignored) { /* 忽略 */ }
            try { if (muxer != null) muxer.release(); } catch (Exception ignored) { /* 忽略 */ }
        }
        if (!dst.exists() || dst.length() <= 0) throw new Exception("转码结果为空");
    }

    /* ── 工具 ── */

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

    /** report.webm → report.m4a（转码后后缀要跟着换，否则播放器按扩展名挑解码器） */
    private String swapExt(String name, String ext) {
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        return base + "." + ext;
    }

    private void deleteQuietly(File f) {
        try { if (f != null && f.exists()) f.delete(); } catch (Exception ignored) { /* 忽略 */ }
    }

    private void closeQuietly(java.io.Closeable c) {
        try { if (c != null) c.close(); } catch (Exception ignored) { /* 忽略 */ }
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
