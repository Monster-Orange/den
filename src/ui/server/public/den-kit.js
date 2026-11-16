/**
 * Issue 95: Den on the UI kit's client entry (/kit/kit.js, window.DenUI).
 * Den's side of the kit is here and only here: its words' language, its
 * name, and the adapter the kit's components call, Den's routes behind it.
 *
 *   changelog()    What's new: GET /api/changelog
 *   Report:        info, diagnostics, preview, send, githubSend and
 *                  githubPoll (the device flow), saveDraft (Finish later):
 *                  /api/report/*; the working pop-up for its slow calls;
 *                  My reports; the screenshot library (/vendor/)
 *
 * The working pop-up keeps busy-den.js (Den's actions and words); the
 * update pill is shell.js's, on the kit's update-pill.js.
 */
import DenUI from "/kit/kit.js";

const sh = () => window.denShell;
const LS_CHANGELOG_SEEN = "__DEN_CLI__-changelog-seen";

/**
 * A JSON call: { status, data } (the shell's fetch adds X-Den-CSRF). The
 * Report form's writes come with the working pop-up's headers (its
 * request id): { headers }.
 */
async function api(method, url, body, { headers = {} } = {}) {
  const r = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await r.json();
  } catch {
    /* not JSON */
  }
  return { status: r.status, data };
}

DenUI.configure({
  lang: () => sh()?.lang?.() || document.documentElement.lang || "en",
  product: { name: "__DEN_TITLE__" },
  adapter: {
    changelog: () => fetch("/api/changelog").then((r) => r.json()),
    info: () => api("GET", "/api/report").then((r) => r.data || {}),
    diagnostics: () =>
      api("GET", "/api/report/diagnostics").then((r) => r.data || {}),
    preview: (form, headers) =>
      api("POST", "/api/report/preview", form, { headers }),
    send: (form, headers) => api("POST", "/api/report/send", form, { headers }),
    githubSend: (form, headers) =>
      api("POST", "/api/report/github-send", form, { headers }),
    githubPoll: (id) => api("GET", `/api/report/github-send/${id}`),
    saveDraft: (form, headers) =>
      api("POST", "/api/report/drafts", form, { headers }),
  },
  whatsNew: {
    // FB (den#81): Report, as in every pop-up ("" when reports are off).
    reportButton: () => sh()?.reportButton?.() ?? "",
    onClose: (latest) => {
      if (!latest) return;
      try {
        localStorage.setItem(LS_CHANGELOG_SEEN, latest);
      } catch {
        /* storage off: seen for this page only */
      }
    },
  },
  report: {
    busy: (action, run, opts) => sh()?.busyAction?.(action, run, opts),
    mine: () => sh()?.myReports?.(),
    page: () =>
      document.getElementById("den-shell")?.getAttribute("data-page") || "",
    library: "/vendor/html-to-image.js",
  },
});

export default DenUI;
