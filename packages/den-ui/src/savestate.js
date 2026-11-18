/**
 * The save-state line: what an autosaving editor says about its text.
 * Framework-free, and blind to the editor: any input, textarea or editor
 * that tells it "changed" works. The host gives the save and what Copy
 * text copies:
 *
 *   const line = createSaveState(el, {
 *     save: () => Promise<void>,   the host's save (rejects on failure)
 *     copyText: () => string,      error's Copy text: the title and body,
 *                                  say (none: no Copy text)
 *     watch: field,                optional: its `input` is changed(), its
 *                                  `focusout` (blur) is flush()
 *     lang: "en" | () => "en",     default: <html lang>
 *     words: { saving, saved, error, copy, savedAt },  optional overrides
 *                                  of the kit's words (strings.js)
 *     css: "/kit/savestate.css",   where savestate.css is, for a page that
 *                                  doesn't link it (default: beside another
 *                                  kit stylesheet on the page)
 *   })
 *   line.changed()   the text changed: a save SAVE_AFTER_MS after the last
 *   line.flush()     save now, when anything changed (→ Promise)
 *   line.retry()     after a failure, try again now (→ Promise)
 *   line.state()     "idle" | "saving" | "saved" | "error"
 *   line.destroy()   timers and listeners off; the live region removed
 *
 * The element becomes <p class="den-savestate" data-state="…"
 * role="status" aria-live="off">: a dot, then the words. aria-live="off"
 * keeps the routine "Saved" quiet; a separate, visually hidden polite
 * region beside it says only the error and its recovery.
 *
 *   idle    nothing (the line keeps its height)
 *   saving  "Saving…", only when a save takes more than SAVING_AFTER_MS
 *   saved   "Saved", title "Saved at {time}"; stays until the next save
 *   error   "Not saved. Retrying…" and Copy text; retries at RETRY_MS,
 *           then every RETRY_EVERY_MS, and at once when the browser is
 *           back online; a success is "saved" again
 *
 * A page going hidden (visibilitychange) saves at once.
 *
 * saveScheduler({ save, onChange }) is the same timing with no DOM (a
 * server, a test, a host's own view): onChange({ state, at?, announce? })
 * on each change of state; announce is "error" or "recovered", else null.
 *
 * Its look is savestate.css (linked from beside this file).
 */
import { kitT } from "./strings.js";
import { formatTime } from "./time.js";

export const SAVE_AFTER_MS = 800;
export const SAVING_AFTER_MS = 400;
export const RETRY_MS = [2000, 4000, 8000];
export const RETRY_EVERY_MS = 30_000;

/** The timing of saves and their states, with no DOM. */
export function saveScheduler({ save, onChange }) {
  let state = "idle";
  let dirty = false;
  let failing = false;
  let again = false;
  let step = 0;
  let dead = false;
  let debounce = 0;
  let retryTimer = 0;
  let running = null;

  const set = (s, extra) => {
    if (dead) return;
    state = s;
    onChange?.({ state: s, announce: null, ...extra });
  };

  function run() {
    if (dead) return Promise.resolve();
    // A save is out: save again as soon as it ends.
    if (running) {
      again = true;
      return running;
    }
    clearTimeout(retryTimer);
    retryTimer = 0;
    dirty = false;
    // While in error the line keeps saying "Retrying…".
    const show = failing ? 0 : setTimeout(() => set("saving"), SAVING_AFTER_MS);
    running = (async () => {
      let ok = true;
      try {
        await save();
      } catch {
        ok = false;
      }
      clearTimeout(show);
      running = null;
      if (dead) return;
      if (ok) {
        const recovered = failing;
        failing = false;
        step = 0;
        set("saved", {
          at: new Date(),
          announce: recovered ? "recovered" : null,
        });
      } else {
        dirty = true;
        if (!failing) {
          failing = true;
          set("error", { announce: "error" });
        }
        const wait = RETRY_MS[step] ?? RETRY_EVERY_MS;
        step++;
        retryTimer = setTimeout(() => {
          retryTimer = 0;
          void run();
        }, wait);
      }
      if (again) {
        again = false;
        if (dirty && !failing) return run();
      }
    })();
    return running;
  }

  return {
    changed() {
      if (dead) return;
      dirty = true;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = 0;
        void run();
      }, SAVE_AFTER_MS);
    },
    flush() {
      clearTimeout(debounce);
      debounce = 0;
      if (dead || !dirty) return running ?? Promise.resolve();
      return run();
    },
    retry() {
      if (dead || !failing) return running ?? Promise.resolve();
      return run();
    },
    state: () => state,
    destroy() {
      dead = true;
      clearTimeout(debounce);
      clearTimeout(retryTimer);
    },
  };
}

/**
 * The look is savestate.css: linked, never injected, so a page under
 * style-src 'self' takes it. A page that links it (in its <head>) keeps
 * its own link. Else it is linked from opts.css, or from the folder of
 * another kit stylesheet on the page (tokens.css, say), as dialog.js does.
 */
const KIT_SHEET =
  /(^|\/)(tokens|base|fonts|busy|dialog|shell|update-pill)\.css$/;
function ensureCss(css) {
  if (document.getElementById("ss-css")) return;
  let near = null;
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) {
    const u = new URL(l.href, location.href);
    if (/(^|\/)savestate\.css$/.test(u.pathname)) return;
    if (!near && KIT_SHEET.test(u.pathname)) near = u;
  }
  const href =
    css ||
    (near ? new URL("savestate.css", near).href.replace(/\?.*$/, "") : null);
  if (!href) return;
  const l = document.createElement("link");
  l.id = "ss-css";
  l.rel = "stylesheet";
  l.href = href;
  document.head.append(l);
}

/**
 * Plain text to the clipboard. Kept here rather than imported from
 * whatsnew.js, which brings the shell's modules with it. The fallback
 * never focuses its textarea: focus stays on Copy text.
 */
function copy(text) {
  if (navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.className = "den-savestate-sr";
    ta.setAttribute("aria-hidden", "true");
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy") ? resolve() : reject(new Error("copy"));
    } catch (e) {
      reject(e);
    } finally {
      ta.remove();
    }
  });
}

/** The save-state line in `el` (see the top of this file). */
export function createSaveState(el, opts = {}) {
  const { save, copyText, watch, words = {} } = opts;
  const lang = () => {
    const l = typeof opts.lang === "function" ? opts.lang() : opts.lang;
    return l || document.documentElement.lang?.slice(0, 2) || "en";
  };
  const word = (key, vars) =>
    words[key] != null
      ? String(words[key]).replace(/\{(\w+)\}/g, (m, k) => vars?.[k] ?? m)
      : kitT(lang(), `kit.savestate.${key}`, vars);

  ensureCss(opts.css);
  el.classList.add("den-savestate");
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "off");
  el.dataset.state = "idle";
  const text = document.createElement("span");
  text.className = "den-savestate-text";
  el.replaceChildren(text);
  const live = document.createElement("span");
  live.className = "den-savestate-sr";
  live.setAttribute("aria-live", "polite");
  el.after(live);
  let btn = null;

  // The error and the recovery alternate, so each is new words to say.
  const say = (s) => {
    live.textContent = s;
  };

  function paint({ state, at, announce }) {
    el.dataset.state = state;
    text.textContent =
      state === "saving"
        ? word("saving")
        : state === "saved"
          ? word("saved")
          : state === "error"
            ? word("error")
            : "";
    const savedAt =
      state === "saved"
        ? word("savedAt", { time: formatTime(at, { style: "time" }) })
        : "";
    if (savedAt) el.title = savedAt;
    else el.removeAttribute("title");
    if (state === "error" && copyText && !btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "den-savestate-copy";
      btn.textContent = word("copy");
      btn.addEventListener("click", () => {
        void copy(String(copyText() ?? "")).catch(() => {});
      });
      el.append(btn);
    } else if (state !== "error" && btn) {
      btn.remove();
      btn = null;
    }
    if (announce === "error") say(word("error"));
    else if (announce === "recovered") say(savedAt);
  }

  const sch = saveScheduler({ save, onChange: paint });
  const onInput = () => sch.changed();
  const onBlur = () => void sch.flush();
  const onHidden = () => {
    if (document.visibilityState === "hidden") void sch.flush();
  };
  const onOnline = () => void sch.retry();
  watch?.addEventListener("input", onInput);
  watch?.addEventListener("focusout", onBlur);
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("online", onOnline);

  return {
    changed: sch.changed,
    flush: sch.flush,
    retry: sch.retry,
    state: sch.state,
    destroy() {
      sch.destroy();
      watch?.removeEventListener("input", onInput);
      watch?.removeEventListener("focusout", onBlur);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("online", onOnline);
      live.remove();
    },
  };
}
