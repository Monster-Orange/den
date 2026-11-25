/**
 * Issue 1243: page_view's link is a localhost link on purpose (it opens on
 * this machine only, as the agent). The tool says so, and says the link is
 * never given to a person; the answer carries the same note beside `url`.
 */
import { describe, expect, it } from "@jest/globals";
import { assertAllowedRequest, type DenApi } from "../../../src/ui/mcp/api.js";
import { callTool, toolsFor } from "../../../src/ui/mcp/tools.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";
import { AGENT_VIEW_LINK_NOTE } from "../../../src/shared/agent-view-note.js";

const cfg = (): ResolvedMcpConfig => ({
  actions: [],
  runTestsEnvs: ["local"],
  logsRemote: false,
  approvals: true,
});

describe("issue 1243: page_view says its link is the agent's own", () => {
  it("the description says the link is for the agent's own browser and is never given to a person", () => {
    const t = toolsFor(cfg()).find((x) => x.name === "page_view");
    expect(t).toBeDefined();
    const d = String(t?.description);
    expect(d).toMatch(/your own browser on this machine/);
    expect(d).toMatch(/never give it to a person/i);
    expect(d).toMatch(/web\.url/);
    // One text: the description carries the answer's note, word for word.
    expect(d).toContain(AGENT_VIEW_LINK_NOTE);
  });

  it("the answer's note reaches the agent beside the url, unchanged", async () => {
    const note =
      "This link is for your own browser on this machine. Never give it to a person.";
    const api: DenApi = {
      baseUrl: "http://localhost:7000",
      async get(path, query = {}, method = "GET") {
        assertAllowedRequest(method, path, query);
        return {
          ok: true,
          url: "http://localhost:7000/auth?agent_view=abc",
          linkSeconds: 60,
          minutes: 10,
          note,
        };
      },
      async stream() {
        throw new Error("no stream here");
      },
    };
    const r = await callTool("page_view", {}, { api, cfg: cfg(), cli: "acme" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ note });
  });
});
