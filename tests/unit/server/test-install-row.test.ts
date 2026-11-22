/**
 * Issue 823: Settings › Access › Test install names the first condition
 * missing (the mark, the launcher's flag with this distribution's name, its
 * own state folder, no owner), and once the test person is set up, says so
 * plainly: no primary button, only a secondary Set up again.
 */
import { describe, expect, it } from "@jest/globals";
import { testInstallHtml } from "../../../src/ui/server/public/settings-registry.js";

const t = (k: string, _en: string, v?: Record<string, string>) =>
  k + (v ? JSON.stringify(v) : "");
const base = { configFile: "config/acme.yml", launchFlag: "ACME_TEST_INSTALL" };

describe("not a test install: the row names what is missing", () => {
  it("no mark: says the mark, in this distribution's config file", () => {
    const h = testInstallHtml(
      { ...base, testInstall: false, ready: false, why: "no_mark" },
      t,
    );
    expect(h).toContain("set.ui.testInstallNoMark");
    expect(h).toContain("config/acme.yml");
    expect(h).not.toContain("set.ui.testInstallNo{");
    expect(h).not.toContain("set-test-person");
  });

  it("no launch flag: says the flag by this distribution's name", () => {
    const h = testInstallHtml(
      { ...base, testInstall: false, ready: false, why: "no_launch_flag" },
      t,
    );
    expect(h).toContain("set.ui.testInstallNoFlag");
    expect(h).toContain("ACME_TEST_INSTALL");
    expect(h).not.toContain("set.ui.testInstallNoMark");
  });

  it("default state folder: says so", () => {
    const h = testInstallHtml(
      { ...base, testInstall: false, ready: false, why: "default_state_dir" },
      t,
    );
    expect(h).toContain("set.ui.testInstallDefaultDir");
    expect(h).not.toContain("set.ui.testInstallNoMark");
  });

  it("owned: says it has an owner or another person signed in", () => {
    const h = testInstallHtml(
      { ...base, testInstall: false, ready: false, why: "owned" },
      t,
    );
    expect(h).toContain("set.ui.testInstallOwned");
    expect(h).not.toContain("set.ui.testInstallNoMark");
  });
});

describe("a test install", () => {
  it("not set up: Set up test person, the primary button", () => {
    const h = testInstallHtml({ ...base, testInstall: true, ready: false }, t);
    expect(h).toContain("set.ui.testPersonMissing");
    expect(h).toMatch(
      /<button[^>]*class="btn primary"[^>]*data-test-person="setup"[^>]*>set.ui.testPersonSetUp</,
    );
    expect(h).not.toContain("set.ui.testPersonAgain");
  });

  it("set up: says so plainly, no primary button, Set up again secondary", () => {
    const h = testInstallHtml({ ...base, testInstall: true, ready: true }, t);
    expect(h).toContain("set.ui.testPersonReady");
    expect(h).toContain('data-test-state="ready"');
    expect(h).not.toContain("primary");
    expect(h).not.toContain("set.ui.testPersonSetUp");
    expect(h).toMatch(
      /<button[^>]*class="btn sm"[^>]*data-test-person="again"[^>]*>set.ui.testPersonAgain</,
    );
  });
});
