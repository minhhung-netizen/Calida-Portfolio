/* Calida PWA worker: chỉ hiển thị push; không cache HTML hoặc dữ liệu phân quyền. */
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { payload = { body: event.data?.text() || "Có cập nhật mới." }; }
  const title = payload.title || "Calida Analyst";
  const options = {
    body: payload.body || "Có cập nhật mới cần xem.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: payload.tag || "calida",
    renotify: false,
    data: { url: payload.url || "/#overview" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/#overview", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url.split("#")[0] === target.split("#")[0]);
    if (existing) { await existing.navigate(target); await existing.focus(); return; }
    await clients.openWindow(target);
  })());
});
