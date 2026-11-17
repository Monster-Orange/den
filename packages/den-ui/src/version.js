/**
 * den-ui version chip: the running product's version in the top bar
 * (shell-html.js draws it as #version-pill; a click opens What's new).
 *
 *   versionLabel(running, changelog)  "v0.4.61-dev.0": the running build's
 *                own version, prerelease and all; the changelog's newest
 *                heading only as the fallback (it names the release being
 *                built, not this build). null when neither is known.
 *   setVersion(label, root?)   the chip's text
 *   setUnread(on, root?)       the dot: the newest notes are unread
 */
export function versionLabel(running, changelog) {
  const v =
    (typeof running === "string" && running.trim()) || changelog?.[0]?.version;
  return v ? `v${v}` : null;
}

export function setVersion(label, root = document) {
  const el = root.getElementById
    ? root.getElementById("version-pill")
    : root.querySelector("#version-pill");
  const txt = el?.querySelector(".v-txt");
  if (txt && label) {
    txt.textContent = label;
    // The whole version, when the bar is short and the text ends in "…".
    txt.title = label;
  }
}

export function setUnread(on, root = document) {
  const pip = root.getElementById
    ? root.getElementById("v-pip")
    : root.querySelector("#v-pip");
  if (pip) pip.style.display = on ? "block" : "none";
}
