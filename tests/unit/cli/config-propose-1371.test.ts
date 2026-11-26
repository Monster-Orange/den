/**
 * Issue 1371: `config propose <key>=<value> --reason "<why>"` asks Den for
 * the held write setting_change, as the MCP tool does: the value parsed as
 * YAML (null for Den's default), a refusal printed as it comes back.
 */
import { describe, expect, it } from "@jest/globals";
import {
  proposeSetting,
  type ConfigApi,
} from "../../../src/ui/cli/config-command.js";

function fake(answer: { status: number; data: Record<string, unknown> }) {
  const calls: { path: string; body: unknown }[] = [];
  const api: ConfigApi = async (_m, path, body) => {
    calls.push({ path, body });
    return answer;
  };
  return { api, calls };
}

describe("config propose (issue 1371)", () => {
  it("asks for setting_change with the key, the parsed value and the reason", async () => {
    const { api, calls } = fake({
      status: 202,
      data: { id: "a1", state: "pending" },
    });
    const out: string[] = [];
    const code = await proposeSetting(
      ["sessions.max_concurrent=14", "--reason", "more terminals"],
      api,
      (s) => out.push(s),
    );
    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        path: "/api/approvals",
        body: {
          action: "setting_change",
          args: {
            key: "sessions.max_concurrent",
            value: 14,
            reason: "more terminals",
          },
        },
      },
    ]);
    expect(out.join("")).toMatch(/Waiting for the person's Allow.*a1/);
  });

  it("null asks for Den's default; a refusal is printed and exits 1", async () => {
    const { api, calls } = fake({
      status: 400,
      data: { error: "agents.max_concurent is not a setting Den reads" },
    });
    const out: string[] = [];
    const code = await proposeSetting(
      ["agents.max_concurent=null", "--reason", "r"],
      api,
      (s) => out.push(s),
    );
    expect(code).toBe(1);
    expect(
      (calls[0]!.body as { args: { value: unknown } }).args.value,
    ).toBeNull();
    expect(out.join("")).toMatch(/✗ agents\.max_concurent is not a setting/);
  });

  it("without a reason or an = it prints the usage and asks nothing", async () => {
    const { api, calls } = fake({ status: 202, data: {} });
    for (const args of [
      ["sessions.max_concurrent=3"],
      ["sessions.max_concurrent", "--reason", "r"],
    ])
      expect(await proposeSetting(args, api, () => undefined)).toBe(2);
    expect(calls).toEqual([]);
  });
});
