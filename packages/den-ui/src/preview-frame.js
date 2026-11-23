/**
 * den-ui: inside a preview's frame (issue 789; preview.js loads it). The
 * host switches the theme and mode with a message, with no reload. Only a
 * message from the host (the parent window) counts, and only a theme slug
 * and a mode: nothing else in the page is touched.
 */
(function () {
  var me = document.currentScript;
  var base = (me && me.getAttribute("data-base")) || "/kit/";
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var d = e.data && e.data.denPreview;
    if (!d || typeof d !== "object") return;
    var link = document.getElementById("den-pv-theme");
    if (link && "theme" in d) {
      if (
        typeof d.theme === "string" &&
        /^[a-z0-9][a-z0-9-]{0,39}$/.test(d.theme)
      ) {
        link.href = base + "themes/" + d.theme + ".css";
        link.disabled = false;
      } else if (d.theme === null) {
        link.removeAttribute("href");
        link.disabled = true;
      }
    }
    if (d.mode === "light" || d.mode === "dark")
      document.documentElement.setAttribute("data-mode", d.mode);
  });
})();
