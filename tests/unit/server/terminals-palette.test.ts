/**
 * Issue 482 (Den Design, 11-18): in the command palette a terminal reads
 * "Terminals › <project> / <name>" and opens on Terminals; "Agents › …"
 * is for agents only. And exited terminals stay on Terminals for 7 days
 * by default (the mock's row "exited 3 days ago"), not 10 minutes.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import { sessionPaletteSpot } from "../../../src/ui/server/public/topbar.js";
import { rowActions } from "../../../src/ui/server/public/terminals-list.js";
import { DEFAULT_EXITED_SHELL_MINUTES } from "../../../src/shared/den-config.js";
import { leaveExitedShells } from "../../../src/ui/server/session-routes.js";
import type { SessionInfo } from "../../../src/shared/sessions/types.js";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");

function catalogs(): Record<string, Record<string, string>> {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang: "en" },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"])
    try {
      vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), "utf-8"), ctx);
    } catch {
      // shell.js stops at its first DOM use; its catalog is set before it.
    }
  return window.denMessages as Record<string, Record<string, string>>;
}

describe("issue 482: the palette names a terminal under Terminals", () => {
  it("a plain terminal: Terminals › …, kind Terminal, opens on Terminals", () => {
    expect(
      sessionPaletteSpot({ id: "ab12", kind: "session", workspace: "north" }),
    ).toEqual({
      kind: "terminal",
      key: "tm.pal",
      path: "/terminals?open=ab12",
    });
  });

  it("an agent: Agents › …, on Agents", () => {
    expect(
      sessionPaletteSpot({ id: "cd34", kind: "agent", workspace: "north" }),
    ).toEqual({ kind: "agent", key: "ag.pal", path: "/agents?open=cd34" });
  });

  it("the words, in en, es and ja", () => {
    const m = catalogs();
    expect(m.en!["tm.pal"]).toBe("Terminals › {ws} / {name}");
    expect(m.en!["kind.terminal"]).toBe("Terminal");
    for (const lang of ["es", "ja"]) {
      expect(m[lang]!["tm.pal"]).toMatch(/\{ws\} \/ \{name\}/);
      expect(m[lang]!["tm.pal"]).not.toBe(m[lang]!["ag.pal"]);
      expect(m[lang]!["kind.terminal"]).toBeTruthy();
    }
  });
});

describe("issue 482: exited terminals stay 7 days by default", () => {
  const DAY = 24 * 60 * 60_000;
  const now = new Date("2026-11-18T12:00:00.000Z");
  const exitedAgo = (ms: number): SessionInfo =>
    ({
      ref: { backend: "den-pty", id: `t${ms}` },
      name: "acme-north:shell",
      exited: true,
      exitedAt: new Date(now.getTime() - ms).toISOString(),
    }) as unknown as SessionInfo;

  async function left(ms: number): Promise<boolean> {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-482-"));
    const forgot: string[] = [];
    const s = exitedAgo(ms);
    const out = await leaveExitedShells(
      { forget: async (id: string) => void forgot.push(id) },
      [s],
      {
        stateDir: () => stateDir,
        exitedShellMinutes: () => DEFAULT_EXITED_SHELL_MINUTES,
        now: () => now,
      },
    );
    fs.rmSync(stateDir, { recursive: true, force: true });
    return out.length === 0 && forgot.includes(s.ref.id);
  }

  it("the default is 7 days, in minutes", () => {
    expect(DEFAULT_EXITED_SHELL_MINUTES).toBe(7 * 24 * 60);
  });

  it("at 3 days it is still listed, with Restart", async () => {
    expect(await left(3 * DAY)).toBe(false);
    expect(rowActions({ exited: true })).toContain("restart");
  });

  it("at 7 days and a minute it leaves", async () => {
    expect(await left(7 * DAY + 60_000)).toBe(true);
  });
});
