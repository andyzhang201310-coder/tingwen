/* 听文 TingWen · 离线外壳缓存（仅缓存静态资源，不缓存录音数据） */
const CACHE = 'tingwen-shell-v43';
const ASSETS = [
  './',
  './index.html',
  './css/tokens.css',
  './css/app.css',
  './css/views.css',
  './js/main.js',
  './js/util.js',
  './js/version.js',
  './js/i18n.js',
  './js/icons.js',
  './js/store.js',
  './js/audio.js',
  './js/asr.js',
  './js/asr-cloud.js',
  './js/asr-native.js',
  './js/asr-live.js',
  './js/asr-sdk.js',
  './js/ai.js',
  './js/correct.js',
  './js/pinyin-data.js',
  './js/diarize.js',
  './js/speakers.js',
  './js/summarize.js',
  './js/live-speaker.js',
  './js/repair.js',
  './js/export.js',
  './js/terms.js',
  './js/keepalive.js',
  './js/translate.js',
  './js/llm.js',
  './js/model-id.js',
  './js/ui.js',
  './js/model.js',
  './js/demo.js',
  './js/views/home.js',
  './js/views/record.js',
  './js/views/doc.js',
  './js/views/doc-speaker-tabs.js',
  './js/views/speakers.js',
  './js/views/settings.js',
  './js/views/trash.js',
  './assets/icon.svg',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(request).then((hit) => {
      if (hit) {
        fetch(request).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    }),
  );
});
