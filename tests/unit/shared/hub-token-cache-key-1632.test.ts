import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  newHubTokenCache,
  readHubToken,
  type HubConfig,
} from "../../../src/shared/hub.js";

const cfgFor = (file: string) =>
  ({
    url: "https://hub.example.test",
    tokenSource: { kind: "file", path: file },
    tokenFrom: "hub.token",
  }) as unknown as HubConfig;

describe("issue 1632: the kept Hub token follows the token's own file", () => {
  it("a token named by another file is read from that file, never the one kept for the last", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-tok-"));
    const a = path.join(dir, "token-aaaaaaaaaa");
    const b = path.join(dir, "token-bbbbbbbbbb");
    fs.writeFileSync(a, "hubi_TESTONLY_first", { mode: 0o600 });
    fs.writeFileSync(b, "hubi_TESTONLY_second", { mode: 0o600 });
    const cache = newHubTokenCache();
    const provider = () => {
      throw new Error("no store in this test");
    };
    expect(await readHubToken(cfgFor(a), provider, cache)).toBe(
      "hubi_TESTONLY_first",
    );
    expect(await readHubToken(cfgFor(b), provider, cache)).toBe(
      "hubi_TESTONLY_second",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
