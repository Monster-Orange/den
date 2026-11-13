/** #63: an MCP tool's error text carries the request id, to find the log line. */
import { describe, expect, it } from "@jest/globals";
import { errorText } from "../../../src/ui/mcp/api.js";

describe("errorText", () => {
  it("says the request id from the JSON body", () => {
    expect(
      errorText(
        JSON.stringify({ ok: false, error: "no", requestId: "abcd1234" }),
      ),
    ).toBe("no (request id abcd1234)");
  });
  it("adds the header's id to a body without one", () => {
    expect(errorText("Bad Gateway", "4bf92f3577b34da6a3ce929d0e0e4736")).toBe(
      "Bad Gateway (request id 4bf92f3577b34da6a3ce929d0e0e4736)",
    );
    expect(errorText("plain")).toBe("plain");
    expect(
      errorText(
        JSON.stringify({ ok: false, error: "no", requestId: "ab" }),
        "ab",
      ),
    ).toBe("no (request id ab)");
  });
});
