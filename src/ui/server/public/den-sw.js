/**
 * Issue 172 S2: __DEN_TITLE__'s service worker, for alerts outside the
 * bell on a phone or with every tab closed. It does one thing: a push
 * (web-push.ts, encrypted for this device) shows as a notification, and a
 * click opens its page in a __DEN_TITLE__ tab, or a new one. It caches
 * nothing and serves no page. A classic script (no imports), at the root
 * so its scope is the whole site.
 */
/* eslint-disable no-restricted-globals */

/** Only this site's own pages. */
function pageOf(link) {
  return typeof link === "string" && /^\/(?!\/)/.test(link) ? link : "/agents";
}

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("push", function (e) {
  var m = {};
  try {
    m = (e.data && e.data.json()) || {};
  } catch (err) {
    m = {};
  }
  e.waitUntil(
    self.registration.showNotification(String(m.title || "__DEN_TITLE__"), {
      body: String(m.body || ""),
      tag: String(m.tag || ""),
      data: { link: pageOf(m.link) },
    }),
  );
});

self.addEventListener("notificationclick", function (e) {
  var link = pageOf(
    e.notification && e.notification.data && e.notification.data.link,
  );
  if (e.notification && e.notification.close) e.notification.close();
  e.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (tabs) {
        var tab = tabs && tabs[0];
        if (tab && tab.navigate)
          return tab.focus().then(function () {
            return tab.navigate(link);
          });
        return self.clients.openWindow(link);
      }),
  );
});
