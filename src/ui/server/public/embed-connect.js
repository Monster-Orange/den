/**
 * Issue 103: the embedded pane's pop-up, for a browser on another
 * computer. The pane's frame carries no cookie; this page is a Den page
 * of its own (signed in, as any other), so the person can let the listed
 * web app use the agent. Allow mints the key (POST /api/embed/keys) and
 * hands it to the frame that opened this window, with postMessage to
 * Den's own origin only: no other page can read it. Then it closes.
 */
const sh = () => window.denShell;
const t = (key, vars) => sh()?.t?.(key, vars) ?? key;

const q = new URLSearchParams(location.search);
const project = q.get("project") ?? "";
const agent = q.get("agent") ?? "";
const origin = q.get("origin") ?? "";
const $ = (id) => document.getElementById(id);

function say(text, tone) {
  const el = $("emc-msg");
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function start() {
  $("emc-what").textContent = t("emc.what", { origin, agent, project });
  if (!window.opener) {
    say(t("emc.noOpener"), "err");
    $("emc-allow").disabled = true;
  }
  $("emc-cancel").addEventListener("click", () => window.close());
  // BUSY-1: Allow goes through the working pop-up (this page mounts the
  // shell). A quick refusal comes back here and is said on the page.
  $("emc-allow").addEventListener("click", async () => {
    const button = $("emc-allow");
    try {
      const j = await sh().busyAction(
        "allow-web-app",
        (headers) =>
          sh().api(
            "POST",
            "/api/embed/keys",
            { project, agent, origin },
            { headers },
          ),
        { button, quietFail: true, inlineError: true, toastFast: false },
      );
      // Closed after a failure: nothing was minted; Allow is back.
      if (!j) return;
      window.opener?.postMessage({ type: "den:key", ...j }, location.origin);
      say(t("emc.done"));
      setTimeout(() => window.close(), 400);
    } catch (err) {
      say(t("emb.failed", { e: err?.message || String(err) }), "err");
      button.disabled = false;
    }
  });
}

if (sh()) start();
else window.addEventListener("den-shell:ready", start, { once: true });
