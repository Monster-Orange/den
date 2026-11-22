/**
 * Issue 103: a composer for one agent, shared by the Agents page (a deep
 * link's /p/<project>/agents/<id>?context=<url>) and the embedded agent
 * pane. What is written here stays here until the person presses Send:
 * nothing reaches the agent before.
 *
 *   makeComposer({ t, name, send, onClose?, holds? })  → { el, setText,
 *                                                 focus, text, addContext,
 *                                                 contexts }
 *     send({ text, context?, button })  resolves when the agent has it;
 *                      rejects with an Error whose message is shown.
 *                      button is Send, for the kit's dots (issue 698)
 *     holds            send holds Send with the kit's dots, so the line
 *                      under the box doesn't say Sending… too
 *     addContext({ url, title, text })  a page shared with the message
 *                      (issue 103's "share this page"): a chip above the
 *                      box, with Remove. The same URL again replaces it.
 *                      It goes with the next Send, then the chips clear
 *
 * Every word is the page's catalog (`t`). Text is only ever set as text
 * (textContent, value), never as HTML.
 *
 * Issue 302: with `draft` (draftKey(...)), what is written is kept, unsent,
 * in this tab's own storage (sessionStorage; localStorage only where that
 * is unavailable) under that key, and comes back when the page reloads.
 * Send clears it, and so does the person's own clear (an empty box). It is
 * never sent anywhere.
 */

import { focusWhenFree } from "/kit/dialog.js";

/** The most pages one message carries (shared-page.ts MAX_SHARED). */
export const MAX_SHARED = 5;

/** Issue 302: an unsent draft's key: one per install, project and agent. */
export function draftKey({ install, project, agent }) {
  return `den-draft:${install}:${project}:${agent}`;
}

/** The tab's own storage for drafts, or null where there is none. */
export function draftStore(win = window) {
  for (const k of ["sessionStorage", "localStorage"]) {
    try {
      const s = win[k];
      const probe = "den-draft-probe";
      s.setItem(probe, "1");
      s.removeItem(probe);
      return s;
    } catch {
      /* the next, or none */
    }
  }
  return null;
}

/** The draft kept under `key`, or "". */
export function readDraft(key, store = draftStore()) {
  try {
    return (key && store?.getItem(key)) || "";
  } catch {
    return "";
  }
}

function keepDraft(key, text, store) {
  if (!key || !store) return;
  try {
    if (text) store.setItem(key, text);
    else store.removeItem(key);
  } catch {
    /* full or blocked: the box still has it */
  }
}

/** The composer's element and its controls. */
export function makeComposer({ t, name, send, onClose, draft, holds = false }) {
  const store = draft ? draftStore() : null;
  const el = document.createElement("form");
  el.className = "agc";
  el.noValidate = true;
  const label = t("agc.label", { name });
  const chips = document.createElement("ul");
  chips.className = "agc-chips";
  chips.hidden = true;
  chips.setAttribute("aria-label", t("agc.shared"));
  /** The shared pages, in order: { url, title, text }. */
  let shared = [];
  const paintChips = () => {
    chips.replaceChildren();
    for (const p of shared) {
      const li = document.createElement("li");
      li.className = "agc-chip";
      const words = document.createElement("span");
      words.className = "agc-chip-t";
      words.textContent = p.title || p.url;
      words.title = p.url;
      const where = document.createElement("span");
      where.className = "agc-chip-u";
      where.textContent = p.url;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "agc-chip-x";
      rm.textContent = "×";
      rm.setAttribute(
        "aria-label",
        t("agc.removeShared", { title: p.title || p.url }),
      );
      rm.addEventListener("click", () => {
        shared = shared.filter((x) => x !== p);
        paintChips();
        ta.focus();
      });
      li.append(words, where, rm);
      chips.append(li);
    }
    chips.hidden = !shared.length;
  };
  const ta = document.createElement("textarea");
  ta.className = "agc-in";
  ta.rows = 3;
  ta.setAttribute("aria-label", label);
  ta.placeholder = label;
  if (draft) ta.value = readDraft(draft, store);
  ta.addEventListener("input", () => keepDraft(draft, ta.value, store));
  const hint = document.createElement("p");
  hint.className = "agc-hint";
  hint.textContent = t("agc.hint");
  const msg = document.createElement("p");
  msg.className = "agc-msg";
  msg.setAttribute("role", "status");
  msg.setAttribute("aria-live", "polite");
  const acts = document.createElement("div");
  acts.className = "agc-acts";
  const sendBtn = document.createElement("button");
  sendBtn.type = "submit";
  sendBtn.className = "btn primary agc-send";
  sendBtn.textContent = t("agc.send");
  if (onClose) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn agc-close";
    close.textContent = t("agc.close");
    close.addEventListener("click", () => onClose());
    acts.append(close);
  }
  acts.append(sendBtn);
  el.append(chips, ta, hint, msg, acts);

  let busy = false;
  const say = (text, tone) => {
    msg.textContent = text;
    if (tone) msg.dataset.tone = tone;
    else delete msg.dataset.tone;
  };
  el.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const text = ta.value.trim();
    if (!text && !shared.length) {
      say(t("agc.empty"), "warn");
      ta.focus();
      return;
    }
    busy = true;
    sendBtn.disabled = true;
    // Issue 698: held with the kit's dots, Send says it; else this line.
    say(holds ? "" : t("agc.sending"));
    try {
      const context = shared.map(({ url, title, text: words }) => ({
        url,
        title,
        ...(words ? { text: words } : {}),
      }));
      await send(
        context.length
          ? { text, context, button: sendBtn }
          : { text, button: sendBtn },
      );
      // What was sent, not what was typed since: a draft written while it
      // went stays.
      if (ta.value.trim() === text) ta.value = "";
      keepDraft(draft, ta.value, store);
      shared = [];
      paintChips();
      say(t("agc.sent", { name }), "ok");
    } catch (err) {
      say(t("agc.failed", { e: err?.message || String(err) }), "err");
    } finally {
      busy = false;
      sendBtn.disabled = false;
    }
  });
  // ⌘/Ctrl+Enter sends; a plain Enter is a new line.
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault();
      el.requestSubmit();
    }
  });

  return {
    el,
    setText(v) {
      ta.value = String(v ?? "");
      keepDraft(draft, ta.value, store);
    },
    text: () => ta.value,
    addContext(p) {
      shared = shared.filter((x) => x.url !== p.url);
      shared.push({
        url: String(p.url),
        title: String(p.title ?? ""),
        text: String(p.text ?? ""),
      });
      shared = shared.slice(-MAX_SHARED);
      paintChips();
    },
    contexts: () => shared.map((p) => ({ ...p })),
    focus() {
      ta.setSelectionRange(ta.value.length, ta.value.length);
      // Issue 793: under an open pop-up (What's new), once it closes.
      focusWhenFree(ta);
    },
  };
}
