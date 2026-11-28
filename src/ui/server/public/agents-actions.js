import { st, t } from "/agents-core.js";

/**
 * D28: a relaunch Den did by itself since the last look: a toast saying
 * so, and that the old conversation is kept. The first look only notes
 * what is there.
 */
function toastAutoRelaunches(rows) {
  const seen = (st.rotSeen ??= new Map());
  const first = !st.rotLooked;
  st.rotLooked = true;
  for (const r of rows) {
    const last = r.kind === "agent" ? r.lastRotation : undefined;
    if (!last) continue;
    const key = `${r.workspace}/${r.agent}`;
    if (seen.get(key) === last.at) continue;
    seen.set(key, last.at);
    if (first || !last.auto) continue;
    window.denShell?.toast?.(
      t("ag.rc.autoRelaunched", {
        id: r.agent,
        why:
          last.reason === "pr-merged"
            ? t("ag.rot.merged")
            : t(
                last.compactions === 1
                  ? "ag.rot.compactions.one"
                  : "ag.rot.compactions",
                { n: last.compactions },
              ),
        old: last.conversation ?? "?",
      }),
    );
  }
}

export { toastAutoRelaunches };
