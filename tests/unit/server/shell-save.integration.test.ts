/**
 * Issue 394: POST /api/settings/shell, the rail's save, on a real server
 * (shell-prefs.ts, request-guard.ts).
 * The kit's saveShell sends it with keepalive, then with a beacon if the
 * page hides first; a beacon has no custom header, so no CSRF token.
 *
 *  - the beacon form (a text or JSON body, no CSRF header) from this
 *    install's own Origin is saved;
 *  - from another Origin, or with none, it is refused (403) and nothing is
 *    stored;
 *  - it takes { shell } only;
 *  - a key's save older than the stored one is ignored (answering ok);
 *    /api/settings keeps the stamps too.
 *
 * A real server on a throwaway distribution; no browser.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { denAuth } from "./helpers/den-auth.js";
import { signedIn } from "./helpers/signed-in.js";
import { startDenServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let userYml = "";
let port = 0;
let server: ChildProcess;
/** A signed-in browser's session cookie: a beacon carries it (no header). */
let cookie = "";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
/** A beacon's shape: POST, a Blob's content type, an Origin (or none). */
function beacon(
  body: unknown,
  o: { origin?: string; type?: string; url?: string } = {},
): Promise<{ status: number; text: string }> {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: o.url ?? "/api/settings/shell",
        headers: {
          host: `localhost:${port}`,
          "content-type": o.type ?? "application/json",
          "content-length": Buffer.byteLength(data),
          ...(o.origin !== undefined ? { origin: o.origin } : {}),
          ...(cookie ? { cookie } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    r.on("error", reject);
    r.end(data);
  });
}
/** The stored shell; a pin read as its item (issue 402's { item, project }). */
async function settings(): Promise<{
  shell: { pins: string[]; collapsed: boolean };
}> {
  const r = await fetch(`http://localhost:${port}/api/settings`, {
    headers: denAuth(path.join(tmp, "home", ".den")),
  });
  const b = (await r.json()) as {
    shell: { pins: { item: string }[]; collapsed: boolean };
  };
  return { shell: { ...b.shell, pins: b.shell.pins.map((p) => p.item) } };
}
async function postSettings(body: unknown): Promise<number> {
  const r = await fetch(`http://localhost:${port}/api/settings`, {
    method: "POST",
    headers: {
      ...denAuth(path.join(tmp, "home", ".den")),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return r.status;
}
const yml = () =>
  fs.existsSync(userYml) ? fs.readFileSync(userYml, "utf-8") : "";
const own = () => `http://localhost:${port}`;

beforeAll(async () => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-shell-save-")),
  );
  const root = path.join(tmp, "dist");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  userYml = path.join(root, "config", "local", "user.yml");
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_HOME: path.join(tmp, "home", ".den"),
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
  );
  server = started.server;
  port = started.port;
  // Sign-in is needed on loopback too: the page's beacon carries its cookie.
  cookie = (
    await signedIn(path.join(tmp, "home", ".den"), `http://localhost:${port}`)
  ).cookie;
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("issue 394: POST /api/settings/shell, the beacon form", () => {
  it("from another Origin: 403, and nothing is stored", async () => {
    const before = yml();
    for (const origin of [
      "https://evil.example",
      `http://localhost:${port + 1}`,
      "null",
    ]) {
      const r = await beacon(
        { shell: { pins: ["evil"], changedAt: Date.now() } },
        { origin, type: "text/plain;charset=UTF-8" },
      );
      expect(r.status).toBe(403);
    }
    expect(yml()).toBe(before);
    expect((await settings()).shell.pins).not.toContain("evil");
  });

  it("with no Origin: 403, and nothing is stored", async () => {
    const before = yml();
    const r = await beacon({
      shell: { pins: ["bare"], changedAt: Date.now() },
    });
    expect(r.status).toBe(403);
    expect(yml()).toBe(before);
  });

  it("from the install's own Origin (localhost or 127.0.0.1 on its port), no CSRF header: saved", async () => {
    const r = await beacon(
      { shell: { pins: ["garden"], changedAt: 1000 } },
      { origin: own() },
    );
    expect(`${r.status} ${r.text}`).toMatch(/^200 /);
    expect((await settings()).shell.pins).toEqual(["garden"]);
    const r2 = await beacon(
      { shell: { pins: ["orchard"], changedAt: 2000 } },
      { origin: `http://127.0.0.1:${port}`, type: "text/plain;charset=UTF-8" },
    );
    expect(r2.status).toBe(200);
    expect((await settings()).shell.pins).toEqual(["orchard"]);
  });

  it("takes { shell } only: another setting is refused (400), nothing stored", async () => {
    const before = yml();
    const r = await beacon(
      { shell: { collapsed: true, changedAt: 3000 }, editor: "evil" },
      { origin: own() },
    );
    expect(r.status).toBe(400);
    expect(yml()).toBe(before);
    expect((await beacon("not json", { origin: own() })).status).toBe(400);
  });

  it("an older changedAt doesn't overwrite a newer one (answering ok)", async () => {
    expect(
      (
        await beacon(
          { shell: { pins: [], changedAt: 5000 } },
          { origin: own() },
        )
      ).status,
    ).toBe(200);
    const late = await beacon(
      { shell: { pins: ["stale"], collapsed: true, changedAt: 4000 } },
      { origin: own() },
    );
    expect(late.status).toBe(200);
    expect(JSON.parse(late.text)).toMatchObject({
      ok: true,
      ignored: ["pins"],
    });
    const s = (await settings()).shell;
    expect(s.pins).toEqual([]);
    expect(s.collapsed).toBe(true);
  });

  it("/api/settings with a shell block keeps the stamps (newest still wins)", async () => {
    expect(
      await postSettings({ shell: { pins: ["a"], changedAt: 9000 } }),
    ).toBe(200);
    expect(await postSettings({ editor: "vim" })).toBe(200);
    expect(
      await postSettings({ shell: { pins: ["b"], changedAt: 8000 } }),
    ).toBe(200);
    expect((await settings()).shell.pins).toEqual(["a"]);
    expect(yml()).toContain("changedAt");
  });
});

describe("issue 394 review: the shell save's edges", () => {
  it("an inherited name ({ constructor: null }) is refused (400), and nothing is written", async () => {
    const before = yml();
    for (const k of ["constructor", "toString"]) {
      const r = await beacon(`{"shell":{"${k}":null,"changedAt":1}}`, {
        origin: own(),
      });
      expect(r.status).toBe(400);
    }
    expect(
      await postSettings(
        JSON.parse('{"shell":{"constructor":null,"changedAt":1}}'),
      ),
    ).toBe(400);
    expect(yml()).toBe(before);
  });

  it("a far-future changedAt, then a normal save: the normal save wins (the shell route)", async () => {
    expect(
      (
        await beacon(
          { shell: { collapsed: true, changedAt: 8.64e15 } },
          { origin: own() },
        )
      ).status,
    ).toBe(200);
    expect(yml()).not.toContain("8640000000000000");
    const r = await beacon(
      { shell: { collapsed: false, changedAt: Date.now() + 1000 } },
      { origin: own() },
    );
    expect(JSON.parse(r.text)).toMatchObject({ ok: true, ignored: [] });
    expect((await settings()).shell.collapsed).toBe(false);
  });

  it("a far-future changedAt, then a normal save: the normal save wins (POST /api/settings)", async () => {
    expect(
      await postSettings({ shell: { collapsed: true, changedAt: 8.64e15 } }),
    ).toBe(200);
    expect(
      await postSettings({
        shell: { collapsed: false, changedAt: Date.now() + 1000 },
      }),
    ).toBe(200);
    expect((await settings()).shell.collapsed).toBe(false);
  });

  it("the allowance is a Setting (web.shell_save_skew_seconds, default 300)", async () => {
    const got = async () =>
      (
        (await (
          await fetch(`http://localhost:${port}/api/settings`, {
            headers: denAuth(path.join(tmp, "home", ".den")),
          })
        ).json()) as { shell_save: { skewSeconds: number } }
      ).shell_save.skewSeconds;
    expect(await got()).toBe(300);
    expect(await postSettings({ shell_save: { skew_seconds: 60 } })).toBe(200);
    expect(await got()).toBe(60);
    expect(yml()).toContain("shell_save_skew_seconds: 60");
    expect(await postSettings({ shell_save: { skew_seconds: -1 } })).toBe(400);
    expect(await postSettings({ shell_save: { skew_seconds: null } })).toBe(
      200,
    );
    expect(await got()).toBe(300);
  });

  it("the body cap is a Setting (web.shell_save_max_kb, default 256, 16 to 4096): at 16, a 20 KB body gets 413", async () => {
    const got = async () =>
      (
        (await (
          await fetch(`http://localhost:${port}/api/settings`, {
            headers: denAuth(path.join(tmp, "home", ".den")),
          })
        ).json()) as { shell_save: { maxKb: number } }
      ).shell_save.maxKb;
    expect(await got()).toBe(256);
    for (const bad of [15, 4097, 1.5])
      expect(await postSettings({ shell_save: { max_kb: bad } })).toBe(400);
    expect(await postSettings({ shell_save: { max_kb: 16 } })).toBe(200);
    expect(await got()).toBe(16);
    expect(yml()).toContain("shell_save_max_kb: 16");
    const before = yml();
    const body = (kb: number) =>
      JSON.stringify({
        shell: { pins: [], changedAt: Date.now(), pad: "x".repeat(kb * 1024) },
      });
    expect((await beacon(body(20), { origin: own() })).status).toBe(413);
    expect(yml()).toBe(before);
    // Under the cap, the same (bad) body reaches the shell check: 400.
    expect((await beacon(body(8), { origin: own() })).status).toBe(400);
    expect(await postSettings({ shell_save: { max_kb: null } })).toBe(200);
    expect(await got()).toBe(256);
  });

  it("a body over the size cap is refused (413), and nothing is written", async () => {
    const before = yml();
    const big = JSON.stringify({
      shell: { pins: [], changedAt: Date.now(), pad: "x".repeat(300 * 1024) },
    });
    const r = await beacon(big, { origin: own() });
    expect(r.status).toBe(413);
    expect(yml()).toBe(before);
  });
});
