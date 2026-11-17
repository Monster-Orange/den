/**
 * Issue 334, server keys (embed-server-keys.ts) and what the state route
 * says (embed-routes.ts embedStateView):
 *
 *   - only the key's hash is stored; the key is returned once, at create;
 *   - a near miss, another key or none grants nothing; a revoked key says
 *     key_revoked;
 *   - last-used is kept, written at most once a minute;
 *   - the state: stopped, busy, idle, or waiting with what it waits on.
 *
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ServerKeys } from "../../../src/ui/server/embed-server-keys.js";
import { embedStateView } from "../../../src/ui/server/embed-routes.js";

const grant = {
  project: "north",
  agent: "scout",
  origin: "http://127.0.0.1:5173",
  label: "staging app",
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function store(now?: () => number): { keys: ServerKeys; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-sk-"));
  dirs.push(dir);
  return {
    keys: ServerKeys.at(dir, now),
    file: path.join(dir, "embed", "server-keys.json"),
  };
}

describe("server keys", () => {
  it("stores only the hash, 0600; the key is given once", () => {
    const { keys, file } = store();
    const { key, view } = keys.create(grant);
    expect(key).toMatch(/^den_sk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw).not.toContain(key);
    expect(raw).not.toContain(key.slice(24));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(keys.list())).not.toContain(key);
    expect(keys.list()[0]).not.toHaveProperty("hash");
    expect(view).toMatchObject({ ...grant, id: key.slice(7, 23) });
    expect(keys.check(key)).toEqual({ ok: true, key: keys.list()[0] });
  });

  it("a near miss, another key or none grants nothing", () => {
    const { keys } = store();
    const { key } = keys.create(grant);
    const other = keys.create({ ...grant, agent: "pilot" }).key;
    for (const k of [
      key.slice(0, -1),
      `${key}x`,
      `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`,
      // Another key's secret under this key's id.
      `${key.slice(0, 24)}${other.slice(24)}`,
      "den_sk_",
      "den_ek_abc",
      "",
      undefined,
      ["x"],
    ])
      expect(keys.check(k)).toEqual({ ok: false, code: "bad_key" });
    expect(keys.check(other).ok).toBe(true);
  });

  it("revoked: 401 key_revoked at once; revoking twice is nothing", () => {
    const { keys } = store();
    const { key, view } = keys.create(grant);
    expect(keys.revoke(view.id)?.revokedAt).toBeTruthy();
    expect(keys.check(key)).toEqual({ ok: false, code: "key_revoked" });
    expect(keys.revoke(view.id)).toBeNull();
    expect(keys.revoke("nope")).toBeNull();
    expect(keys.list()[0].revokedAt).toBeTruthy();
  });

  it("last used: kept, written at most once a minute", () => {
    let now = Date.parse("2026-11-17T18:00:00Z");
    const { keys } = store(() => now);
    const { view } = keys.create(grant);
    keys.touch(view.id);
    expect(keys.get(view.id)?.lastUsedAt).toBe("2026-11-17T18:00:00.000Z");
    now += 30_000;
    keys.touch(view.id);
    expect(keys.get(view.id)?.lastUsedAt).toBe("2026-11-17T18:00:00.000Z");
    now += 30_000;
    keys.touch(view.id);
    expect(keys.get(view.id)?.lastUsedAt).toBe("2026-11-17T18:01:00.000Z");
  });

  it("a broken file: no key works, and nothing throws", () => {
    const { keys, file } = store();
    const { key } = keys.create(grant);
    fs.writeFileSync(file, "{not json");
    expect(keys.check(key)).toEqual({ ok: false, code: "bad_key" });
    expect(keys.list()).toEqual([]);
  });
});

describe("the state an app's server reads", () => {
  it("stopped, busy and idle as the agent is", () => {
    expect(embedStateView("stopped", null)).toEqual({
      running: false,
      state: "stopped",
    });
    expect(embedStateView("missing", null).state).toBe("stopped");
    expect(embedStateView("busy", null)).toEqual({
      running: true,
      state: "busy",
    });
    expect(embedStateView("idle", null)).toEqual({
      running: true,
      state: "idle",
    });
  });

  it("waiting on its person: waiting, with what it waits on", () => {
    const w = {
      why: "permission",
      what: "Bash: npm publish",
      since: "2026-11-17T18:00:00.000Z",
    };
    expect(embedStateView("busy", w)).toEqual({
      running: true,
      state: "waiting",
      waiting: w,
    });
    // A stopped agent waits on nobody.
    expect(embedStateView("stopped", w)).toEqual({
      running: false,
      state: "stopped",
    });
  });
});
