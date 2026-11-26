import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { lastUpdate } from "../../../src/ui/server/den-update.js";
import {
  backMessage,
  type RestartMarker,
} from "../../../src/ui/server/server-restart.js";
import { pinAgentLine } from "../../../src/ui/server/pin-commit.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1745-tells-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (name: string, v: unknown) => {
  const f = path.join(dir, "server-agent", "update", name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v));
};

const stranded = {
  version: "0.4.41",
  state: "push_failed",
  sha: "0123456789abcdef0123456789abcdef01234567",
  branch: "den/pin-0.4.41",
  why: "git push to origin den/pin-0.4.41: ! [remote rejected] (directory file conflict)",
  noted: true,
  at: "2026-11-20T10:00:00.000Z",
};

const marker = (o: Partial<RestartMarker> = {}): RestartMarker => ({
  id: "a1",
  reason: "Den 0.4.42 is out",
  fromVersion: "0.4.41",
  fromPid: 111,
  at: "2026-11-20T11:00:00.000Z",
  ...o,
});

describe("issue 1745: a pin that wasn't pushed is said where the server agent looks", () => {
  it("release_status's update record carries the pin step", () => {
    put("state.json", {
      state: "good",
      from: "0.4.41",
      to: "0.4.42",
      at: "2026-11-20T11:00:00.000Z",
    });
    put("pin.json", stranded);
    expect(lastUpdate(dir)).toMatchObject({
      to: "0.4.42",
      pin: {
        version: "0.4.41",
        state: "push_failed",
        branch: "den/pin-0.4.41",
        why: expect.stringMatching(/directory file conflict/),
      },
    });
    expect(JSON.stringify(lastUpdate(dir))).not.toMatch(/noted/);
  });

  it("no pin record: no pin field", () => {
    put("state.json", {
      state: "good",
      from: "0.4.41",
      to: "0.4.42",
      at: "2026-11-20T11:00:00.000Z",
    });
    expect(lastUpdate(dir)).not.toHaveProperty("pin");
  });

  it("the back-on line names an earlier pin that is still not pushed, and that only the latest is kept", () => {
    const update = {
      state: "good" as const,
      from: "0.4.41",
      to: "0.4.42",
      at: "2026-11-20T11:00:00.000Z",
      pin: stranded as never,
    };
    for (const m of [marker({ by: "den" }), marker({ agent: "server" })]) {
      const text = backMessage(m, "0.4.42", 222, update);
      expect(text).toMatch(
        /Den 0\.4\.41's pin was not pushed: git push to origin den\/pin-0\.4\.41: .*directory file conflict/,
      );
      expect(text).toMatch(
        /Only the latest pin is kept and tried again: 0\.4\.42's pin replaces it/,
      );
    }
  });

  it("a pin that is pushed, or the running version's, adds nothing to the back-on line", () => {
    const base = {
      state: "good" as const,
      from: "0.4.41",
      to: "0.4.42",
      at: "2026-11-20T11:00:00.000Z",
    };
    for (const pin of [
      { ...stranded, state: "pushed" },
      {
        ...stranded,
        state: "pr_opened",
        url: "https://example.invalid/pull/7",
      },
    ])
      expect(
        backMessage(marker({ by: "den" }), "0.4.42", 222, {
          ...base,
          pin: pin as never,
        }),
      ).not.toMatch(/pin was not pushed/);
  });

  it("a failed pin push gives the server agent one line, with its reason; a done step gives none", () => {
    expect(
      pinAgentLine(
        {
          did: "push_failed",
          version: "0.4.42",
          sha: stranded.sha,
          why: "git push to origin den-pin-0.4.42: offline",
          first: true,
        },
        "Den",
      ),
    ).toBe(
      "Den 0.4.42's pin couldn't be pushed: git push to origin den-pin-0.4.42: offline. Den tries again at its next update check; the person has it in the bell.",
    );
    expect(
      pinAgentLine(
        {
          did: "push_failed",
          version: "0.4.42",
          sha: stranded.sha,
          why: "offline",
          first: false,
        },
        "Den",
      ),
    ).toBeNull();
    expect(
      pinAgentLine(
        { did: "pushed", version: "0.4.42", sha: stranded.sha },
        "Den",
      ),
    ).toBeNull();
  });

  it("the push output in that line is redacted and has no control characters", () => {
    const token = "ghp_" + "A".repeat(36);
    const typed = pinAgentLine(
      {
        did: "push_failed",
        version: "0.4.42",
        sha: stranded.sha,
        why: `remote: https://x:${token}@github.com\x1b[31m denied\r\nnext`,
        first: true,
      },
      "Den",
    );
    expect(typed).not.toContain(token);
    expect(typed).toContain("[REDACTED");
    const codes = [...(typed ?? "")].map((c) => c.charCodeAt(0));
    expect(codes.filter((n) => n < 32 || (n >= 127 && n <= 159))).toEqual([]);
  });
});
