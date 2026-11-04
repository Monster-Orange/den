import { afterEach, describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("../../src/shared/terminal/tabs.js", () => ({
  tabExists: jest.fn(),
}));

const tmpRoots: string[] = [];

function makeTempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-tabs-"));
  tmpRoots.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  delete process.env.DEN_CLI_TABS_FILE;
  jest.resetAllMocks();
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("cli tab sidecar", () => {
  it("records, looks up, and forgets a tab", async () => {
    const file = makeTempFile("cli-tabs.json");
    process.env.DEN_CLI_TABS_FILE = file;
    const { recordTab, lookupTab, forgetTab } =
      await import("../../src/shared/cli-tabs.js");

    recordTab("shop/api", {
      terminalApp: "iterm2",
      tabId: "tab-1",
      cwd: "/repos/shop",
      command: "make up",
    });

    expect(lookupTab("shop/api")?.tabId).toBe("tab-1");
    expect(fs.readFileSync(file, "utf-8")).toContain("shop/api");

    forgetTab("shop/api");

    expect(lookupTab("shop/api")).toBeNull();
  });

  it("cleans up stale tabs when the terminal reports they no longer exist", async () => {
    const file = makeTempFile("cli-tabs.json");
    process.env.DEN_CLI_TABS_FILE = file;
    const { tabExists } = await import("../../src/shared/terminal/tabs.js");
    const mockTabExists = tabExists as jest.MockedFunction<typeof tabExists>;
    mockTabExists.mockReturnValue(false);
    const { recordTab, cleanupStaleTabs, lookupTab } =
      await import("../../src/shared/cli-tabs.js");

    recordTab("shop/api", {
      terminalApp: "terminal",
      tabId: "/dev/ttys001",
    });
    cleanupStaleTabs();

    expect(lookupTab("shop/api")).toBeNull();
  });
});
