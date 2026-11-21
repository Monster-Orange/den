/**
 * Issue 819: new sign-in requests are limited per client address (a
 * Setting, web.pair_requests_per_minute). The shared test sign-in
 * (helpers/signed-in.ts) makes one request per sign-in, all from this one
 * address, far faster than a person: past the limit it raises the Setting
 * as the approving person, then signs in. Here the limit is 2 a minute and
 * five sign-ins in a row all work. Invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { signedIn } from "./helpers/signed-in.js";

let s: AgentsPageServer;
beforeAll(async () => {
  s = await startAgentsPageServer();
}, 60_000);
afterAll(async () => {
  await s?.stop();
});

describe("the test sign-in, past the new-request limit", () => {
  it("five sign-ins in a row work with a limit of 2 a minute", async () => {
    const yml = path.join(s.tmp, "dist", "config", "local", "user.yml");
    const before = fs.existsSync(yml) ? fs.readFileSync(yml, "utf-8") : "";
    fs.writeFileSync(
      yml,
      /^web:/m.test(before)
        ? before.replace(/^web:\n/m, "web:\n  pair_requests_per_minute: 2\n")
        : `${before}\nweb:\n  pair_requests_per_minute: 2\n`,
    );
    const got: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const me = await signedIn(s.stateDir, s.base);
      const r = await fetch(`${s.base}/api/session`, {
        headers: { cookie: me.cookie },
      });
      got.push(((await r.json()) as { signedIn?: boolean }).signedIn === true);
    }
    expect(got).toEqual([true, true, true, true, true]);
  }, 60_000);
});
