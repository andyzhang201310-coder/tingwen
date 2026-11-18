/**
 * 听文 TingWen · 实时识别 WebSocket 代理
 *
 * 为什么需要它：浏览器和 WebView 的原生 WebSocket 不允许自定义请求头，
 * 而阿里百炼实时语音识别的鉴权必须放在握手头 Authorization: Bearer <key>。
 * 因此网页端和真机端都不能直连百炼实时接口，必须由本代理注入鉴权头。
 *
 * 客户端连：ws://127.0.0.1:8790/ws/asr
 * 代理连：  wss://dashscope.aliyuncs.com/api-ws/v1/inference（或 Workspace 专属域名）
 *
 * 协议（客户端 ↔ 代理）：
 *   1) 连上后先发一条 JSON 文本：
 *      { "action": "start", "key": "<DashScope API Key>",
 *        "model": "paraformer-realtime-v2", "format": "pcm",
 *        "sampleRate": 16000, "lang": "zh" }
 *   2) 之后持续发二进制消息：16kHz / 16bit / 单声道 PCM，建议每 100ms 一帧
 *   3) 结束发一条 JSON 文本：{ "action": "finish" }
 *   4) 代理把百炼的 result-generated / task-started / task-finished 等 JSON 事件原样回传
 *
 * Key 只在本机代理进程内使用，不写进前端代码、不进 IndexedDB 的导出、不进日志。
 *
 * 用法：
 *   node asr-proxy.mjs                 # 默认 0.0.0.0:8790（局域网可达，供真机连接）
 *   node asr-proxy.mjs 9001            # 指定端口
 *   ASR_PROXY_HOST=0.0.0.0 node asr-proxy.mjs
 */
import http from 'node:http';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.argv[2] || process.env.ASR_PROXY_PORT || 8790);
const HOST = process.env.ASR_PROXY_HOST || '0.0.0.0';

/** 百炼实时接口地址。华北2(北京)通用域名；也可用 Workspace 专属域名 */
const DASHSCOPE_WS = process.env.DASHSCOPE_WS
  || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

/** 允许的模型白名单，避免客户端传入任意字符串打到别的服务 */
const MODELS = new Set([
  'paraformer-realtime-v2',
  'paraformer-realtime-8k-v2',
  'fun-asr-realtime',
  'qwen3-asr-flash-realtime',
]);

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: DASHSCOPE_WS }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('听文 ASR 代理已启动。客户端请连接 /ws/asr。');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* ignore */ }
  if (pathname !== '/ws/asr') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (client, req) => {
  const remote = req.socket.remoteAddress || '?';
  let upstream = null;
  let started = false;
  let finished = false;
  let startTimer = null;

  console.log(`[asr-proxy] 客户端接入 ${remote}`);

  const fail = (msg, code = 'proxy_error') => {
    send(client, { header: { action: 'error' }, payload: { code, message: msg } });
  };

  const closeUpstream = () => {
    clearTimeout(startTimer);
    if (upstream && upstream.readyState < WebSocket.CLOSING) {
      try { upstream.close(); } catch { /* ignore */ }
    }
    upstream = null;
  };

  client.on('message', (data, isBinary) => {
    /* ── 二进制音频帧：直接透传给百炼 ── */
    if (isBinary) {
      if (!started || !upstream || upstream.readyState !== WebSocket.OPEN) {
        fail('任务尚未开启，音频被丢弃', 'not_started');
        return;
      }
      try { upstream.send(data, { binary: true }); } catch (e) { fail(String(e?.message || e)); }
      return;
    }

    /* ── 文本控制消息 ── */
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { fail('消息不是合法 JSON', 'bad_json'); return; }

    if (msg.action === 'start') {
      if (started) { fail('任务已开启', 'already_started'); return; }
      const key = String(msg.key || '').trim();
      if (!key) { fail('缺少 API Key', 'no_key'); return; }
      const model = MODELS.has(msg.model) ? msg.model : 'paraformer-realtime-v2';
      const format = ['pcm', 'opus', 'wav', 'mp3'].includes(msg.format) ? msg.format : 'pcm';
      const sampleRate = Number(msg.sampleRate) === 8000 ? 8000 : 16000;
      const lang = ['auto', 'zh', 'en', 'ja', 'ko', 'yue'].includes(msg.lang) ? msg.lang : 'auto';

      /* 用 workspace 专属域名时，请求头需要带 X-DashScope-WorkSpace */
      const headers = { Authorization: `Bearer ${key}` };
      const wsId = String(msg.workspaceId || process.env.DASHSCOPE_WORKSPACE_ID || '').trim();
      if (wsId) headers['X-DashScope-WorkSpace'] = wsId;

      try {
        upstream = new WebSocket(DASHSCOPE_WS, { headers });
      } catch (e) {
        fail(`无法创建上游连接: ${e?.message || e}`, 'upstream_init');
        return;
      }

      upstream.on('open', () => {
        /* run-task 必须等上游 open 后发；task_group/task/function 固定三件套 */
        const taskId = crypto.randomUUID();
        client._taskId = taskId;   // finish-task 必须复用同一个 task_id
        send(upstream, {
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model,
            input: {},
            parameters: {
              format,
              sample_rate: sampleRate,
              language_hints: lang === 'auto' ? undefined : [lang],
              punctuation_prediction_enabled: true,
              heartbeat: true,
            },
          },
        });
        startTimer = setTimeout(() => {
          if (!started) {
            fail('上游 10 秒未返回 task-started，请检查 Key 权限/地域', 'upstream_timeout');
            closeUpstream();
          }
        }, 10000);
      });

      upstream.on('message', (raw) => {
        let text = raw.toString();
        try {
          const evt = JSON.parse(text);
          if (evt.header?.event === 'task-started' || evt.header?.action === 'task-started') started = true;
          if (evt.header?.event === 'task-finished') finished = true;
        } catch { /* 非 JSON 也原样回传 */ }
        if (client.readyState === WebSocket.OPEN) client.send(text);
      });

      upstream.on('error', (e) => {
        fail(`上游连接错误: ${e?.message || e}`, 'upstream_error');
      });

      upstream.on('close', (code, reason) => {
        if (!finished && client.readyState === WebSocket.OPEN) {
          send(client, {
            header: { action: 'error' },
            payload: { code: 'upstream_closed', message: `上游连接关闭 (${code}) ${reason || ''}`.trim() },
          });
        }
        if (client.readyState === WebSocket.OPEN) {
          try { client.close(1000, 'upstream closed'); } catch { /* ignore */ }
        }
      });

      return;
    }

    if (msg.action === 'finish') {
      if (!started || !upstream || upstream.readyState !== WebSocket.OPEN) {
        fail('任务未开启，无法结束', 'not_started');
        return;
      }
      /* finish-task 的 task_id 需要与 run-task 一致，这里由服务端记住 */
      if (client._taskId) {
        send(upstream, {
          header: { action: 'finish-task', task_id: client._taskId, streaming: 'duplex' },
          payload: { input: {} },
        });
      }
      return;
    }

    if (msg.action === 'ping') {
      send(client, { action: 'pong', t: msg.t });
      return;
    }

    fail(`未知 action: ${msg.action}`, 'bad_action');
  });

  client.on('close', () => {
    console.log(`[asr-proxy] 客户端断开 ${remote}`);
    closeUpstream();
  });
  client.on('error', () => closeUpstream());
});

/** 列出本机所有局域网 IPv4，供真机填写时直接照抄 */
function lanAddresses() {
  const out = [];
  const seen = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal && !seen.has(ni.address)) {
        seen.add(ni.address);
        out.push(ni.address);
      }
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log(`听文 ASR 代理已启动: ws://${HOST}:${PORT}/ws/asr`);
  console.log(`上游: ${DASHSCOPE_WS}`);
  console.log('健康检查: ' + `http://127.0.0.1:${PORT}/healthz`);
  const addrs = lanAddresses();
  if (addrs.length) {
    console.log('\n手机端请填下面任一地址（手机需与电脑同一 WiFi）：');
    for (const a of addrs) console.log(`  ws://${a}:${PORT}/ws/asr`);
    console.log('');
  }
});

process.on('SIGINT', () => {
  wss.close();
  server.close(() => process.exit(0));
});
