/**
 * Issue 816: Settings › Access › Test installs on this computer. Each test
 * install announced here and waiting for its test person is listed by its
 * ~/ state folder and id, with Set up test person, which asks for the held
 * write test_person_setup (your own Allow). None: says so.
 */
import { describe, expect, it } from "@jest/globals";
import { testInstallsHereHtml } from "../../../src/ui/server/public/settings-registry.js";

const t = (k: string, _en: string, v?: Record<string, string>) =>
  k + (v ? JSON.stringify(v) : "");

describe("issue 816: test installs on this computer", () => {
  it("none waiting: says so, no button", () => {
    const h = testInstallsHereHtml([], t);
    expect(h).toContain("set.ui.testInstallsNone");
    expect(h).not.toContain("<button");
  });

  it("each is listed by its ~/ folder and id, with its own Set up test person", () => {
    const h = testInstallsHereHtml(
      [
        { id: "0123456789abcdef", where: "~/beds/a/state", port: 4100 },
        { id: "fedcba9876543210", where: "~/beds/b/state", port: 4200 },
      ],
      t,
    );
    expect(h).toContain("~/beds/a/state");
    expect(h).toContain("0123456789abcdef");
    expect(h).toMatch(
      /<button[^>]*data-test-install-setup="0123456789abcdef"[^>]*>set.ui.testPersonSetUp</,
    );
    expect(h).toMatch(/data-test-install-setup="fedcba9876543210"/);
  });

  it("escapes what it shows", () => {
    const h = testInstallsHereHtml(
      [{ id: "0123456789abcdef", where: "~/<b>x</b>", port: 4100 }],
      t,
    );
    expect(h).not.toContain("<b>x</b>");
  });
});
