/**
 * Issue 227: a person's restart from the page (POST /api/web/restart: the
 * update pill's Reload, Restart Den in the menu or in Settings) writes one
 * audit row, as an agent's held restart does: who (the credential's
 * person), when, and from which page action. An action the page doesn't
 * name is "the page", never the caller's own words.
 *
 * A temp audit file; nothing restarts.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AUDIT_FILE, setAuditFile } from "../../../src/ui/server/audit.js";
import {
  PAGE_RESTART_FROM,
  recordPageRestart,
} from "../../../src/ui/server/server-restart.js";
import { readSettingsSources } from "./helpers/settings-sources.js";

const tmps: string[] = [];
afterEach(() => {
  setAuditFile(null);
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function auditFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-page-restart-"));
  tmps.push(dir);
  const f = path.join(dir, AUDIT_FILE);
  setAuditFile(f);
  return f;
}

const rows = (f: string) =>
  fs
    .readFileSync(f, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("a person's restart from the page (issue 227)", () => {
  it.each([
    ["update-pill", "Reload in the update pill"],
    ["menu", "Restart Den in the menu"],
    ["settings", "Restart Den in Settings"],
  ])("from %s: one row, who, when and the action", (from, words) => {
    const f = auditFile();
    const before = Date.now();
    recordPageRestart({ from }, null, "person:ada");
    const r = rows(f);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      actor: "user",
      principal: "person:ada",
      verb: "server-restart",
      detail: `asked by the person from the page: ${words}`,
    });
    const at = Date.parse(String(r[0].ts));
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("an action the page doesn't name is the page, never the caller's words", () => {
    const f = auditFile();
    recordPageRestart({ from: "rm -rf\n/" }, null, "person:ada");
    recordPageRestart(undefined, null, undefined);
    const r = rows(f);
    expect(r.map((x) => x.detail)).toEqual([
      "asked by the person from the page",
      "asked by the person from the page",
    ]);
    expect(r[1].principal).toBeUndefined();
  });

  it("POST /api/web/restart records it, and each page action names itself", () => {
    const src = (p: string) =>
      fs.readFileSync(
        path.join(__dirname, "../../../src/ui/server", p),
        "utf-8",
      );
    const route = src("index.ts").split('pathname === "/api/web/restart"')[1];
    expect(route.slice(0, 1200)).toMatch(/recordPageRestart\(/);
    expect(src("public/restart-den.js")).toMatch(/\{ from \} : \{\}/);
    expect(src("public/header.js")).toMatch(
      /restartDen\(\{[^}]*from: "update-pill"/,
    );
    expect(src("public/appearance.js")).toMatch(
      /restartDen\(\{ from: "menu" \}\)/,
    );
    expect(readSettingsSources()).toMatch(
      /restartDen\(\{ from: "settings" \}\)/,
    );
  });

  it("every restartDen call on the page names its action (a restart that posts nothing is the only exception)", () => {
    const dir = path.join(__dirname, "../../../src/ui/server/public");
    const files = fs
      .readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".js") && f !== "restart-den.js");
    const unnamed: string[] = [];
    let calls = 0;
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), "utf-8");
      const all = text.match(/restartDen\(/g)?.length ?? 0;
      const read = [...text.matchAll(/restartDen\((\{[^}]*\})?\)/g)].length;
      if (read !== all)
        unnamed.push(
          `${f}: ${all - read} restartDen call(s) the scan can't read`,
        );
      for (const m of text.matchAll(/restartDen\((\{[^}]*\})?\)/g)) {
        calls++;
        const args = m[1] ?? "";
        if (/post: false/.test(args)) continue;
        const from = /from: "([^"]+)"/.exec(args)?.[1];
        if (!from || !Object.hasOwn(PAGE_RESTART_FROM, from))
          unnamed.push(`${f}: ${m[0]}`);
      }
    }
    expect(calls).toBeGreaterThan(3);
    expect(unnamed).toEqual([]);
  });
});
