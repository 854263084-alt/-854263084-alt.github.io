const CACHE = 'chainpulse-shell-v3';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './data/radar-history.json'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(hit => hit || caches.match('./index.html'))));
});

// 这里仅接收未来由真实推送服务发送的消息。当前站点没有 VAPID 配置或订阅端点，
// 因此不会伪装为已经具备网页关闭后的后台 Push。
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data ? event.data.text() : '' }; }
  const title = payload.title || '链潮 · 币圈趋势雷达';
  const options = {
    body: payload.body || '有新的链上市场提醒。',
    icon: './icon.svg',
    badge: './icon.svg',
    tag: payload.tag || 'chainpulse-push',
    renotify: false,
    data: { url: payload.url || './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || './';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const existing = list.find(client => client.url.includes(self.location.origin));
    return existing ? existing.focus() : clients.openWindow(target);
  }));
});
