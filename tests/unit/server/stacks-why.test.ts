/**
 * MCP-2.4: `stacks: []` came back with no reason, and an agent took it for
 * a broken docker. /api/stacks says why an empty list is empty: nothing in
 * the org config's `stacks:`, and no repo of the workspace with a
 * `compose:` block (or no such workspace at all).
 */
import { describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { emptyStacksReason } from "../../../src/shared/stacks/status.js";
import {
  defaultReadonlyRouteDeps,
  handleReadonlyRoutes,
} from "../../../src/ui/server/readonly-routes.js";

describe("emptyStacksReason", () => {
  it("names the org config and the workspace's manifests", () => {
    expect(
      emptyStacksReason({
        workspace: "north",
        workspaceExists: true,
        configStacks: 0,
      }),
    ).toMatch(
      /^no stacks: the org config \(\S+\) declares no stacks:, and no repo of workspace "north" has a compose: block in its \S+$/,
    );
  });

  it("a workspace that does not exist: no manifest was read", () => {
    expect(
      emptyStacksReason({
        workspace: "default",
        workspaceExists: false,
        configStacks: 0,
      }),
    ).toMatch(/^no stacks: workspace "default" does not exist here/);
  });
});

describe("/api/stacks serves the reason", () => {
  it("passes `why` through with the empty list", async () => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handleReadonlyRoutes(req, res, url.pathname, url, {
        ...defaultReadonlyRouteDeps,
        workspaceExists: () => true,
        stacks: ({ workspace }) => ({
          workspace: workspace ?? "north",
          stackWorkspace: "north",
          stacks: [],
          why: emptyStacksReason({
            workspace: workspace ?? "north",
            workspaceExists: true,
            configStacks: 0,
          }),
        }),
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/api/stacks?workspace=north&health=0",
            agent: false,
            headers: { Connection: "close" },
          },
          (res) => {
            let b = "";
            res.setEncoding("utf8");
            res.on("data", (c: string) => (b += c));
            res.on("end", () => resolve(b));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(JSON.parse(body)).toMatchObject({
        workspace: "north",
        stacks: [],
        why: expect.stringMatching(/^no stacks: /),
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
