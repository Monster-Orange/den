/**
 * A fake bed for gate/503.mjs: terminals open and close through the CLI
 * (`sessions start` / `sessions kill`; the page's route answers 403
 * fixture_scope, as Den answers the fixture person),
 * doctor --json has the Terminals row, and readBed answers the installed
 * @lydell/node-pty, the lockfile and Den's config reader, as a working Den
 * does, unless `broken` names one part to break:
 *   leak   a closed terminal keeps its PTY (the issue 503 bug)
 *   doctor no Terminals row in doctor
 *   keys   the config reader lacks the sessions.pty_* keys
 *   pty    another node-pty version is installed
 *   reason the cap's refusal doesn't name sessions.max_concurrent
 *   nostart `sessions start` is refused before any terminal opens
 *   others another program on the machine opens 3 PTYs while the check runs
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
      if (/^\/api\/(workspaces\/[^/]+\/)?sessions/.test(p) && method !== "GET")
        return json(403, {
          ok: false,
          code: "fixture_scope",
          error:
            "The fixture person can only use the pages and the few writes live checks need: not this.",
        });
      return json(404, { ok: false });
    },
    cli(args) {
      if (args[0] === "sessions" && args[1] === "start") {
        const at = (f) => args[args.indexOf(f) + 1];
        if (at("--workspace") !== "north" || !args.includes("--"))
          return { code: 2, out: "", err: "✗ usage" };
        if (broken === "nostart")
          return { code: 1, out: "", err: "✗ the session host is not running" };
        if (open.size >= cap)
          return {
            code: 1,
            out: "",
            err:
              broken === "reason"
                ? "✗ cap"
                : `✗ ${cap} sessions are running (sessions.max_concurrent is ${cap})\n  Stop one first (\`den sessions kill <name>\`), or raise sessions.max_concurrent.`,
          };
        const name = at("--name");
        open.add(name);
        next++;
        host++;
        machine++;
        // As the real CLI: --json gives the record (issue 840).
        return {
          code: 0,
          out: args.includes("--json")
            ? JSON.stringify({
                session: {
                  name,
                  pid: 1000 + next,
                  ref: { id: `s${next}` },
                  startedAt: new Date(0).toISOString(),
                },
                dropped: [],
              })
            : `started ${name} (id s${next}, pid ${1000 + next})\n  attach: den sessions attach ${name}`,
          err: "",
        };
      }
      if (args[0] === "sessions" && args[1] === "kill") {
        if (open.delete(args[2]) && broken !== "leak") {
          host--;
          machine--;
        }
        if (broken === "others" && open.size === 0) machine += 3;
        return { code: 0, out: `stopped ${args[2]}`, err: "" };
      }
      if (args[0] !== "doctor") return { code: 2, out: "", err: "" };
      // Doctor always has rows: a broken one lacks only the PTY row.
      const checks =
        broken === "doctor"
          ? [{ id: "node", status: "ok", detail: "v24" }]
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
