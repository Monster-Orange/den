/**
 * Issue 750: a group message to an agent whose Hub tools failed to load
 * is acked held (hub_tools_unavailable). Den reads that from issue 749's
 * record (mcpLoadFailures): this session's failed connect or listing.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  hubToolsFailed,
  noteHubMcpInit,
  noteHubMcpTools,
} from "../../../src/shared/agents/hub-mcp-connect.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-750-"));
  dirs.push(d);
  return d;
};

describe("issue 750: hubToolsFailed", () => {
  const rec = (startedAt: string) => ({ id: "planner", startedAt });

  it("a failed connect in this session: true", () => {
    const s = tmp();
    const start = new Date(Date.now() - 60_000).toISOString();
    noteHubMcpInit(s, "planner", { ok: false, error: "hub (503)" });
    expect(hubToolsFailed(s, rec(start))).toBe(true);
  });

  it("a listing that failed after a good connect: true", () => {
    const s = tmp();
    const start = new Date(Date.now() - 60_000).toISOString();
    noteHubMcpInit(s, "planner", { ok: true });
    noteHubMcpTools(s, "planner", { ok: false, error: "listing failed" });
    expect(hubToolsFailed(s, rec(start))).toBe(true);
  });

  it("tools loaded, no note, or a failure from before this session: false", () => {
    const s = tmp();
    const start = new Date(Date.now() - 60_000).toISOString();
    expect(hubToolsFailed(s, rec(start))).toBe(false);
    noteHubMcpInit(s, "planner", { ok: true });
    noteHubMcpTools(s, "planner", { ok: true });
    expect(hubToolsFailed(s, rec(start))).toBe(false);
    noteHubMcpInit(s, "planner", { ok: false, error: "old" });
    expect(
      hubToolsFailed(s, rec(new Date(Date.now() + 60_000).toISOString())),
    ).toBe(false);
  });
});
