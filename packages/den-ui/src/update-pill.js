// den-ui: the shared update pill (see update-pill.css). No framework.
// - text is written only when it changes (WebKit drops a click whose
//   mouse-down node is replaced);
// - the words show at once (no layout shift under a click); a hidden status,
//   filled just after, is what a screen reader hears;
// - a text past one line turns the pill into a card, re-measured on resize.
/**
 * @param {{ message: string, reloadLabel: string, dismissLabel: string, cancelLabel?: string,
 *   askFirst?: { message: string } | null | (() => ({ message: string } | null)),
 *   onReload?: () => void, onDismiss?: () => void, region?: string, root?: HTMLElement }} o
 * askFirst: when it returns a message (e.g. unsaved text), Reload asks once and the × reads Cancel.
 * @returns {{ hide(): void }}
 */
export function showUpdate(o) {
  const box = document.createElement("div");
  box.className = "den-upd";
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", o.region || "Update");
  const pill = document.createElement("div");
  pill.className = "upd-pill";
  const icon = document.createElement("span");
  icon.className = "upd-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
  const msg = document.createElement("span");
  msg.className = "upd-msg";
  msg.setAttribute("aria-hidden", "true");
  const said = document.createElement("span");
  said.className = "upd-sr";
  said.setAttribute("role", "status");
  const btn = (cls) =>
    Object.assign(document.createElement("button"), {
      type: "button",
      className: cls,
    });
  const go = btn("upd-go");
  const other = btn("upd-dismiss");
  const acts = document.createElement("span");
  acts.className = "upd-acts";
  acts.append(go, other);
  pill.append(icon, msg, said, acts);
  box.append(pill);
  let asking = null;
  const put = (el, t) => {
    if (el.textContent !== t) el.textContent = t;
  };
  const fit = () => {
    if (!box.isConnected || box.hidden) return;
    pill.classList.remove("card");
    const r = document.createRange();
    r.selectNodeContents(msg);
    if (new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size > 1)
      pill.classList.add("card");
  };
  const render = () => {
    const text = asking ? asking.message : o.message;
    put(msg, text);
    put(said, text);
    put(go, o.reloadLabel);
    put(other, asking ? o.cancelLabel || "Cancel" : "×");
    other.classList.toggle("is-text", Boolean(asking));
    if (asking) other.removeAttribute("aria-label");
    else other.setAttribute("aria-label", o.dismissLabel);
    fit();
  };
  const hide = () => {
    window.removeEventListener("resize", fit);
    box.remove();
  };
  go.addEventListener("click", () => {
    const ask = typeof o.askFirst === "function" ? o.askFirst() : o.askFirst;
    if (!asking && ask) {
      asking = ask;
      render();
      return;
    }
    (o.onReload || (() => location.reload()))();
  });
  other.addEventListener("click", () => {
    if (asking) {
      asking = null;
      render();
      return;
    }
    hide();
    o.onDismiss?.();
  });
  window.addEventListener("resize", fit);
  (o.root || document.body).append(box);
  render();
  said.textContent = "";
  setTimeout(render, 50);
  return { hide };
}
