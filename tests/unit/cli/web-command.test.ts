import { describe, expect, it, jest, afterEach } from "@jest/globals";

// Hermetic: the default port must not depend on the runner's config/local/user.yml.
jest.mock("../../../src/shared/edge/config.js", () => ({
  readWebPort: () => 7777,
}));
import {
  buildDenWebUrl,
  denWebUrlAliases,
  hasDenHostsEntry,
  isDenWebCommand,
  isDenWebTabUrl,
  killWebProcess,
  parseWebCommandArgs,
  resolveDenWebHost,
} from "../../../src/ui/cli/web-command.js";
import {
  addDenUiMarker,
  hasDenUiMarker,
} from "../../../src/shared/ui-marker.js";

describe("killWebProcess", () => {
  afterEach(() => jest.restoreAllMocks());

  it("signals the process group (-pid) then the pid so child tails die too", () => {
    const calls: Array<[number, string | number | undefined]> = [];
    jest
      .spyOn(process, "kill")
      .mockImplementation((p: number, s?: string | number) => {
        calls.push([p, s]);
        return true;
      });
    killWebProcess(123, "SIGTERM");
    expect(calls).toEqual([
      [-123, "SIGTERM"],
      [123, "SIGTERM"],
    ]);
  });

  it("never throws when the group or pid is already gone", () => {
    jest.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(() => killWebProcess(999, "SIGKILL")).not.toThrow();
  });
});

describe("web command helpers", () => {
  it("defaults to the shared web port and opens the browser", () => {
    expect(parseWebCommandArgs([], {})).toEqual({
      action: "up",
      port: 7777,
      openBrowser: true,
      silent: true,
      setupBrowserAccess: false,
    });
  });

  it("honors PORT and explicit --port values", () => {
    expect(parseWebCommandArgs([], { PORT: "8080" }).port).toBe(8080);
    expect(parseWebCommandArgs(["--port", "9090"], { PORT: "8080" }).port).toBe(
      9090,
    );
    expect(parseWebCommandArgs(["--port=9191"], {}).port).toBe(9191);
  });

  it("supports explicit up, down, and restart actions", () => {
    expect(parseWebCommandArgs(["up"], {}).action).toBe("up");
    expect(parseWebCommandArgs(["down"], {}).action).toBe("down");
    expect(parseWebCommandArgs(["restart", "--no-open"], {})).toMatchObject({
      action: "restart",
      openBrowser: false,
    });
    expect(parseWebCommandArgs(["--port", "9090", "down"], {})).toMatchObject({
      action: "down",
      port: 9090,
    });
  });

  it("accepts legacy start/stop as aliases for up/down", () => {
    expect(parseWebCommandArgs(["start"], {}).action).toBe("up");
    expect(parseWebCommandArgs(["stop"], {}).action).toBe("down");
    // Aliases still count as an action for the one-action rule.
    expect(() => parseWebCommandArgs(["start", "down"], {})).toThrow(
      /Only one web action/,
    );
  });

  it("supports browser and logging options", () => {
    expect(parseWebCommandArgs(["--no-open", "--verbose"], {})).toMatchObject({
      openBrowser: false,
      silent: false,
    });
    expect(parseWebCommandArgs(["--verbose", "--silent"], {})).toMatchObject({
      silent: true,
    });
    expect(parseWebCommandArgs(["--setup-browser-access"], {})).toMatchObject({
      openBrowser: false,
      setupBrowserAccess: true,
    });
  });

  it("rejects invalid ports and unknown options", () => {
    expect(() => parseWebCommandArgs(["--port", "nope"], {})).toThrow(
      /Invalid web port/,
    );
    expect(() => parseWebCommandArgs(["--bogus"], {})).toThrow(
      /Unknown web option/,
    );
    expect(() => parseWebCommandArgs(["bogus"], {})).toThrow(
      /Unknown web action/,
    );
    expect(() => parseWebCommandArgs(["up", "down"], {})).toThrow(
      /Only one web action/,
    );
    expect(() =>
      parseWebCommandArgs(["restart", "--setup-browser-access"], {}),
    ).toThrow(/only valid with den web up/);
  });

  it("detects the den hosts entry without matching comments", () => {
    expect(hasDenHostsEntry("127.0.0.1 localhost den\n")).toBe(true);
    expect(hasDenHostsEntry("# 127.0.0.1 den\n127.0.0.1 localhost\n")).toBe(
      false,
    );
  });

  it("resolves the preferred browser URL host", () => {
    expect(resolveDenWebHost("127.0.0.1 den\n")).toBe("den");
    expect(resolveDenWebHost("127.0.0.1 localhost\n")).toBe("localhost");
    expect(buildDenWebUrl(7777, "127.0.0.1 den\n")).toBe("http://den:7777");
  });

  it("matches den web tab URL aliases for the selected port", () => {
    expect(denWebUrlAliases(7777)).toEqual([
      "http://den:7777",
      "http://den.localhost:7777",
      "http://localhost:7777",
      "http://127.0.0.1:7777",
    ]);
    expect(isDenWebTabUrl("http://den:7777/local-dev.html", 7777)).toBe(true);
    expect(isDenWebTabUrl("http://localhost:7777/logs.html", 7777)).toBe(true);
    expect(isDenWebTabUrl("http://den.localhost:7777/logs.html", 7777)).toBe(
      true,
    );
    expect(isDenWebTabUrl("http://localhost:8080/logs.html", 7777)).toBe(false);
  });
});

describe("isDenWebCommand", () => {
  const server = "node --import tsx /code/den/src/ui/server/index.ts --silent";
  it("matches a server run from the distribution root", () => {
    expect(
      isDenWebCommand(
        "node /dist/acme/node_modules/@monster-orange/den/src/ui/server/index.ts",
        ["/dist/acme"],
      ),
    ).toBe(true);
  });
  it("matches a server run from a linked engine checkout (npm i ../den)", () => {
    expect(isDenWebCommand(server, ["/dist/acme", "/code/den"])).toBe(true);
  });
  it("never matches another program", () => {
    expect(isDenWebCommand("node /code/den/other.js", ["/code/den"])).toBe(
      false,
    );
    expect(isDenWebCommand(server, ["/elsewhere"])).toBe(false);
  });
});

describe("the UI page marker", () => {
  it("is added to served HTML and recognised regardless of the brand's case", () => {
    const html = addDenUiMarker(
      "<!doctype html><html><head><title>acme</title></head></html>",
    );
    expect(hasDenUiMarker(html)).toBe(true);
    expect(
      hasDenUiMarker("<html><head><title>Acme</title></head></html>"),
    ).toBe(false);
  });
});
