/**
 * Issue 103: a composer for one agent, shared by the Agents page (a deep
 * link's /p/<project>/agents/<id>?context=<url>) and the embedded agent
 * pane. What is written here stays here until the person presses Send:
 * nothing reaches the agent before.
 *
 *   makeComposer({ t, name, send, onClose? })  → { el, setText, focus,
 *                                                 text }
 *     send({ text })   resolves when the agent has it; rejects with an
 *                      Error whose message is shown
 *
 * Every word is the page's catalog (`t`). Text is only ever set as text
 * (textContent, value), never as HTML.
 */

/** The composer's element and its controls. */
export function makeComposer({ t, name, send, onClose }) {
  const el = document.createElement("form");
  el.className = "agc";
  el.noValidate = true;
  const label = t("agc.label", { name });
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
  el.append(ta, hint, msg, acts);

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
    if (!text) {
      say(t("agc.empty"), "warn");
      ta.focus();
      return;
    }
    busy = true;
    sendBtn.disabled = true;
    say(t("agc.sending"));
    try {
      await send({ text });
      ta.value = "";
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
    focus() {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    },
  };
}
