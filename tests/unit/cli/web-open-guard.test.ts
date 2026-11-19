/**
 * No test, and no CI run, opens a real browser (0.4.48). Test runs left
 * tens of sign-in tabs in a person's browser: `DEN_NO_OPEN=1` was set by
 * many tests, but nothing read it.
 *
 * - `DEN_NO_OPEN=1` is `--no-open`.
 * - Under Jest (JEST_WORKER_ID) or CI, Den never opens or focuses a
 *   browser unless DEN_ALLOW_OPEN=1 says so.
 * - The guard is in the opener itself, so every path through it holds; a
 *   refused open mints no sign-in link.
 *
 * Stubbed openers only: nothing here reaches a browser.
 */
import { describe, expect, it } from "@jest/globals";
import { browserOpenRefusal } from "../../../src/shared/browser-open.js";
import {
  openOrFocusDenWebUrl,
  parseWebCommandArgs,
} from "../../../src/ui/cli/web-command.js";

describe("browserOpenRefusal", () => {
  it("refuses under DEN_NO_OPEN, Jest or CI; DEN_ALLOW_OPEN lets a test or CI run open", () => {
    expect(browserOpenRefusal({})).toBeNull();
    expect(browserOpenRefusal({ DEN_NO_OPEN: "1" })).toBe("DEN_NO_OPEN=1");
    expect(browserOpenRefusal({ JEST_WORKER_ID: "3" })).toBe("a test run");
    expect(browserOpenRefusal({ CI: "true" })).toBe("CI");
    expect(
      browserOpenRefusal({ JEST_WORKER_ID: "3", DEN_ALLOW_OPEN: "1" }),
    ).toBeNull();
    expect(browserOpenRefusal({ DEN_NO_OPEN: "1", DEN_ALLOW_OPEN: "1" })).toBe(
      "DEN_NO_OPEN=1",
    );
  });

  it("this test run sets DEN_NO_OPEN for every test (tests/setup.ts)", () => {
    expect(process.env.DEN_NO_OPEN).toBe("1");
  });
});

describe("web up's browser", () => {
  it("DEN_NO_OPEN=1 is --no-open", () => {
    expect(parseWebCommandArgs(["up"], { DEN_NO_OPEN: "1" }).openBrowser).toBe(
      false,
    );
    expect(parseWebCommandArgs(["up"], {}).openBrowser).toBe(true);
  });

  it("under a test run the opener is never called, and no sign-in link is minted", () => {
    const calls: string[] = [];
    const deps = {
      focus: () => {
        calls.push("focus");
        return { status: "not-found" as const };
      },
      open: (u: string) => {
        calls.push(`open ${u}`);
        return { status: "opened" as const };
      },
    };
    let minted = 0;
    const link = () => {
      minted++;
      return "http://den.test/auth?c=x";
    };
    const r = openOrFocusDenWebUrl(link, 4000, true, {
      ...deps,
      env: { JEST_WORKER_ID: "1" },
    });
    expect(r).toEqual({ status: "skipped", why: "a test run" });
    expect(calls).toEqual([]);
    expect(minted).toBe(0);
    // Outside a test (a person's own `web up`): it opens.
    const ok = openOrFocusDenWebUrl(link, 4000, true, { ...deps, env: {} });
    expect(ok).toEqual({ status: "opened" });
    expect(calls).toEqual(["focus", "open http://den.test/auth?c=x"]);
  });
});

describe("web up with a tab already open (sign-in on this machine too)", () => {
  it("sends the open tab to a fresh one-time link, back to the page it was on", () => {
    const calls: string[] = [];
    const nexts: (string | undefined)[] = [];
    const link = (next?: string) => {
      nexts.push(next);
      return `http://den.test/auth?c=x&next=${encodeURIComponent(next ?? "/")}`;
    };
    const r = openOrFocusDenWebUrl(link, 4000, true, {
      env: {},
      focus: () => ({
        status: "focused" as const,
        app: "Google Chrome",
        url: "http://den.test/agents?p=demo",
      }),
      navigate: (app: string, u: string) => {
        calls.push(`navigate ${app} ${u}`);
        return true;
      },
      open: (u: string) => {
        calls.push(`open ${u}`);
        return { status: "opened" as const };
      },
    });
    expect(r).toEqual({ status: "focused", app: "Google Chrome" });
    expect(nexts).toEqual(["/agents?p=demo"]);
    expect(calls).toEqual([
      `navigate Google Chrome http://den.test/auth?c=x&next=${encodeURIComponent("/agents?p=demo")}`,
    ]);
  });

  it("opens the link in a new tab when the open tab can't be sent there", () => {
    const calls: string[] = [];
    const r = openOrFocusDenWebUrl(
      () => "http://den.test/auth?c=x",
      4000,
      true,
      {
        env: {},
        focus: () => ({
          status: "focused" as const,
          app: "Safari",
          url: "http://den.test/",
        }),
        navigate: () => false,
        open: (u: string) => {
          calls.push(`open ${u}`);
          return { status: "opened" as const };
        },
      },
    );
    expect(r).toEqual({ status: "opened" });
    expect(calls).toEqual(["open http://den.test/auth?c=x"]);
  });
});
