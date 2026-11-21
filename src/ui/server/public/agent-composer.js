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
 */

import { focusWhenFree } from "/kit/dialog.js";

/** The most pages one message carries (shared-page.ts MAX_SHARED). */
export const MAX_SHARED = 5;

/** The composer's element and its controls. */
export function makeComposer({ t, name, send, onClose, holds = false }) {
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
      ta.value = "";
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
