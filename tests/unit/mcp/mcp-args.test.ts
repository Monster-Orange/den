/**
 * 0.4.8: `<cli> mcp` fails closed on an argument it doesn't take: exit 2
 * with its usage, never ignored (a typo like `--worksapce` must not start
 * an unscoped server).
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { runMcp, unknownMcpArg } from "../../../src/ui/mcp/server.js";

afterEach(() => {
  process.exitCode = undefined;
  jest.restoreAllMocks();
});

describe("the arguments `mcp` takes", () => {
  it("--port, --list and --call <tool> [json]; nothing else", () => {
    expect(unknownMcpArg([])).toBeNull();
    expect(unknownMcpArg(["--port", "7000"])).toBeNull();
    expect(unknownMcpArg(["--port=7000", "--list"])).toBeNull();
    expect(unknownMcpArg(["--call", "status"])).toBeNull();
    expect(unknownMcpArg(["--call", "status", '{"env":"local"}'])).toBeNull();
    expect(unknownMcpArg(["--worksapce", "north"])).toBe("--worksapce");
    expect(unknownMcpArg(["--list", "extra"])).toBe("extra");
    expect(unknownMcpArg(["--call", "status", "{}", "more"])).toBe("more");
  });

  it("an unknown one exits 2 with the usage, before anything starts", async () => {
    let err = "";
    jest.spyOn(process.stderr, "write").mockImplementation((s) => {
      err += String(s);
      return true;
    });
    await runMcp(["--bogus"]);
    expect(process.exitCode).toBe(2);
    expect(err).toMatch(/unknown argument "--bogus"/);
    expect(err).toMatch(/Usage: .* mcp/);
  });
});
