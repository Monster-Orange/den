/**
 * A fake bed for gate/503.mjs: terminals open and close through the API,
 * doctor --json has the Terminals row, and readBed answers the installed
 * @lydell/node-pty, the lockfile and Den's config reader, as a working Den
 * does, unless `broken` names one part to break:
 *   leak   a closed terminal keeps its PTY (the issue 503 bug)
 *   doctor no Terminals row in doctor
 *   keys   the config reader lacks the sessions.pty_* keys
 *   pty    another node-pty version is installed
 *   reason the cap's refusal has no reason
 * `cap` is sessions.max_concurrent; `capIn` is where the bed sets it:
 * "den.yml", or "default" (only Den's default in den-config).
 */
export const PTY = "1.2.0-beta.18";
export const INTEGRITY =
  "sha512-ryy4liRcw6QBBKWDIbJgTW7Pw8NI2xjri/5s/LZg/jJ8ZVg8MgA1xI/vjpT5qTvDvPjUpU5NybJBrKRgK/QvlA==";

export function fakeBed({ broken = null, cap = 8, capIn = "den.yml" } = {}) {
  let host = 3;
  let machine = 40;
  let next = 0;
  const open = new Set();
  const json = (status, body) => ({ status, body: JSON.stringify(body) });
  const ctx = {
    async fetch(p, init = {}) {
      const method = init.method ?? "GET";
      if (p === "/api/sessions" && method === "GET")
        return json(200, { sessions: [], workspaces: ["north"] });
      if (p === "/api/workspaces/north/sessions" && method === "POST") {
        if (open.size >= cap)
          return json(
            429,
            broken === "reason"
              ? { ok: false, code: "cap" }
              : {
                  ok: false,
                  error: `${cap} sessions are running (sessions.max_concurrent is ${cap})`,
                  code: "cap",
                  hints: [
                    "Stop a session first, or raise sessions.max_concurrent.",
                  ],
                },
          );
        const id = `t${++next}`;
        open.add(id);
        host++;
        machine++;
        return json(201, { session: { id } });
      }
      const m = /^\/api\/sessions\/([^/]+)\/close$/.exec(p);
      if (m && method === "POST") {
        if (open.delete(decodeURIComponent(m[1])) && broken !== "leak") {
          host--;
          machine--;
        }
        return json(200, { ok: true });
      }
      return json(404, { ok: false });
    },
    cli(args) {
      if (args[0] !== "doctor") return { code: 2, out: "", err: "" };
      const checks =
        broken === "doctor"
          ? []
          : [
              {
                id: "terminal_host_ptys",
                status: "ok",
                detail: `the terminal host holds ${host} PTYs (✗ above 400, sessions.pty_warn_above); the machine uses ${machine} of 511`,
              },
            ];
      return { code: 0, out: JSON.stringify({ ok: true, checks }), err: "" };
    },
    readBed(rel) {
      if (rel === "node_modules/@lydell/node-pty/package.json")
        return JSON.stringify({
          name: "@lydell/node-pty",
          version: broken === "pty" ? "1.2.0-beta.17" : PTY,
        });
      if (rel === "package-lock.json")
        return JSON.stringify({
          packages: {
            "node_modules/@lydell/node-pty": {
              version: broken === "pty" ? "1.2.0-beta.17" : PTY,
              integrity: broken === "pty" ? "sha512-other" : INTEGRITY,
            },
          },
        });
      if (rel === "den.yml")
        return capIn === "den.yml"
          ? `name: bed\nsessions:\n  close_grace_seconds: 5\n  max_concurrent: ${cap}\nagents:\n  max_concurrent: 4\n`
          : "name: bed\nagents:\n  max_concurrent: 4\n";
      if (rel === "node_modules/@monster-orange/den/src/shared/den-config.ts")
        return (
          (broken === "keys"
            ? 'const KEYS = ["close_grace_seconds"];'
            : 'const KEYS = ["close_grace_seconds", "pty_close_seconds", "pty_warn_above", "pty_machine_warn_percent"];') +
          `\nexport const DEFAULT_SESSIONS_MAX_CONCURRENT = ${capIn === "default" ? cap : 8};`
        );
      return null;
    },
    async until(fn, _ms) {
      for (let i = 0; i < 3; i++) if (await fn()) return 0;
      return null;
    },
    notes: [],
    log(...a) {
      this.notes.push(a.join(" "));
    },
    async sleep() {},
    openNow: () => open.size,
  };
  return { ctx };
}
