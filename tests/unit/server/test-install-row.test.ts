/**
 * Issue 823: Settings › Access › Test install, one state at a time.
 *  - Not a test install: the row names the first missing condition in
 *    plain words and says what to do (the launcher's flag in this
 *    distribution's own prefix, sent by the server). No button.
 *  - A test install, test person not set up: Set up test person.
 *  - Set up: the state, plainly, with no primary button; a secondary
 *    Set up again.
 */
import { describe, expect, it } from "@jest/globals";
import { testInstallHtml } from "../../../src/ui/server/public/settings-registry.js";

const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const notTest = (why: string, extra: Record<string, unknown> = {}) =>
  testInstallHtml({
    ok: true,
    testInstall: false,
    ready: false,
    why,
    ...extra,
  });

describe("not a test install: the missing condition, and what to do", () => {
  it("no_mark: the mark, set by hand in the distribution config", () => {
    const h = notTest("no_mark");
    expect(h).toContain('data-why="no_mark"');
    expect(text(h)).toMatch(/mark is missing/);
    expect(text(h)).toContain("web.test_install: true");
    expect(h).not.toContain("<button");
  });

  it("no_launch_flag: the exact variable, in this distribution's prefix", () => {
    const h = notTest("no_launch_flag", { launchFlag: "ACME_TEST_INSTALL" });
    expect(h).toContain('data-why="no_launch_flag"');
    expect(text(h)).toContain("ACME_TEST_INSTALL=1");
    expect(text(h)).not.toContain("DEN_TEST_INSTALL");
    expect(text(h)).not.toContain("web.test_install");
    expect(h).not.toContain("<button");
  });

  it("default_state_dir: a state folder of its own", () => {
    const h = notTest("default_state_dir");
    expect(h).toContain('data-why="default_state_dir"');
    expect(text(h)).toMatch(/default state folder/);
    expect(text(h)).toMatch(/state folder of its own/);
    expect(h).not.toContain("<button");
  });

  it("owned: an owner or another person is signed in, not you; they sign out", () => {
    const h = notTest("owned");
    expect(h).toContain('data-why="owned"');
    expect(text(h)).toMatch(/owner or another person \(not you\) is signed in/);
    expect(text(h)).toMatch(/sign out/);
    expect(h).not.toContain("<button");
  });

  it("an older server's answer, with no reason: the general words", () => {
    const h = testInstallHtml({ ok: true, testInstall: false, ready: false });
    expect(text(h)).toMatch(/^ ?Not a test install/);
    expect(h).not.toContain("<button");
  });
});

describe("a test install", () => {
  it("not set up: says so, with Set up test person as the button", () => {
    const h = testInstallHtml({ ok: true, testInstall: true, ready: false });
    expect(h).toContain('data-ready="no"');
    expect(text(h)).toMatch(/isn't set up yet/);
    expect(h).toMatch(
      /<button[^>]*class="btn primary"[^>]*id="set-test-person"/,
    );
    expect(text(h)).toContain("Set up test person");
    expect(h).not.toContain("set-test-person-again");
  });

  it("set up: the state plainly, no primary button, a secondary Set up again", () => {
    const h = testInstallHtml({ ok: true, testInstall: true, ready: true });
    expect(h).toContain('data-ready="yes"');
    expect(text(h)).toMatch(
      /This is a test install\. The test person is set up\./,
    );
    expect(h).not.toContain('id="set-test-person"');
    expect(h).not.toContain("primary");
    expect(h).toMatch(/<button[^>]*class="btn"[^>]*id="set-test-person-again"/);
    expect(text(h)).toContain("Set up again");
  });
});
