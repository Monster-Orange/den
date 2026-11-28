import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HubCallError } from "../../../src/shared/hub.js";
import {
  HubAgentTokens,
  liveAgentTokenProblems,
  readAgentHubToken,
  readAgentTokenProblems,
  unbindAgentHubToken,
} from "../../../src/shared/hub-agent-tokens.js";
import { writeRecord } from "../../../src/shared/agents/records.js";

const made: string[] = [];
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "htp-"));
  made.push(d);
  return d;
};

const HUB = { url: "https://hub.example.test", token: "hubi_TESTONLY_install" };

async function failedMint(stateDir: string, id: string): Promise<void> {
  const t = new HubAgentTokens({
    stateDir: () => stateDir,
    settings: () => ({ enabled: true, retrySeconds: 600, maxAgeDays: 0 }),
    mint: async () => {
      throw new HubCallError("refused", "busy", "busy", 503);
    },
    log: () => undefined,
  });
  await t.tokenFor(HUB, { id, name: id, workspace: "north" });
}

describe("a removed agent's Hub token problem goes with it", () => {
  it("removing an agent whose mint failed (no token file) clears its problem record", async () => {
    const stateDir = tmp();
    await failedMint(stateDir, "ada");
    expect(readAgentHubToken(stateDir, "ada")).toBeNull();
    expect(readAgentTokenProblems(stateDir).map((p) => p.agentId)).toEqual([
      "ada",
    ]);
    await unbindAgentHubToken(
      () => stateDir,
      async () => HUB,
      "ada",
    );
    expect(readAgentTokenProblems(stateDir)).toEqual([]);
  });

  it("doctor's rows skip a problem record whose agent no longer exists", async () => {
    const stateDir = tmp();
    await failedMint(stateDir, "ada");
    await failedMint(stateDir, "bob");
    writeRecord(stateDir, {
      id: "bob",
      persona: "tester",
      runtime: "den-claude",
      workspace: "north",
    } as never);
    expect(liveAgentTokenProblems(stateDir).map((p) => p.agentId)).toEqual([
      "bob",
    ]);
  });
});
