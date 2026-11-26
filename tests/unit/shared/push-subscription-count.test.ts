/** Issue 1334: doctor's push row counts subscriptions without the server. */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  PUSH_SUBSCRIPTIONS_FILE,
  pushSubscriptionCount,
} from "../../../src/shared/push-subscription-count.js";
import { SUBSCRIPTIONS_FILE } from "../../../src/ui/server/web-push.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-count-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (body: string) =>
  fs.writeFileSync(path.join(dir, PUSH_SUBSCRIPTIONS_FILE), body);

describe("pushSubscriptionCount (issue 1334)", () => {
  it("is the server's file", () => {
    expect(SUBSCRIPTIONS_FILE).toBe(PUSH_SUBSCRIPTIONS_FILE);
  });
  it("no file: 0; entries with an endpoint counted; unreadable: undefined", () => {
    expect(pushSubscriptionCount(dir)).toBe(0);
    write(
      JSON.stringify([{ endpoint: "https://push.example.test/a" }, { x: 1 }]),
    );
    expect(pushSubscriptionCount(dir)).toBe(1);
    write("not json");
    expect(pushSubscriptionCount(dir)).toBeUndefined();
    write("{}");
    expect(pushSubscriptionCount(dir)).toBeUndefined();
  });
});
