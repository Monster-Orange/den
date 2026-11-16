/**
 * A running agent's Den token must survive a session record caught
 * mid-write. The host rewrites `<id>.json` on every prompt; a check that
 * read it half-written took "unreadable" for "ended" and revoked the
 * token for good, so a running agent lost Hub ("its session ended").
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bindActorSession,
  checkActorToken,
  mintActorToken,
  revokeActorToken,
} from "../../../src/shared/actor-token.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-at-read-"));
});

function running(id: string, body: string): void {
  const d = sessionPaths(dir).dir;
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${id}.json`), body);
}

describe("an agent token and its session record", () => {
  it("a record caught mid-write refuses this call but never revokes the token", () => {
    const { token, key } = mintActorToken(dir, {
      agentId: "scout",
      workspace: "north",
      sessionName: "den-scout",
    });
    bindActorSession(dir, key, "s-1");
    running("s-1", "");
    expect(checkActorToken(dir, token)).toBeNull();
    running("s-1", '{"id":"s-1","na');
    expect(checkActorToken(dir, token)).toBeNull();
    // The write finishes: the same token works again.
    running("s-1", JSON.stringify({ id: "s-1", name: "den-scout" }));
    expect(checkActorToken(dir, token)).toMatchObject({ actor: "agent:scout" });
  });

  it("a session that ended (exited, or its record gone) still ends the token", () => {
    const a = mintActorToken(dir, {
      agentId: "scout",
      workspace: "north",
      sessionName: "den-scout",
    });
    bindActorSession(dir, a.key, "s-2");
    running("s-2", JSON.stringify({ id: "s-2", exited: true }));
    expect(checkActorToken(dir, a.token)).toBeNull();
    running("s-2", JSON.stringify({ id: "s-2" }));
    expect(checkActorToken(dir, a.token)).toBeNull();
    const b = mintActorToken(dir, {
      agentId: "lookout",
      workspace: "north",
      sessionName: "den-lookout",
    });
    bindActorSession(dir, b.key, "s-3");
    expect(checkActorToken(dir, b.token)).toBeNull();
    running("s-3", JSON.stringify({ id: "s-3" }));
    expect(checkActorToken(dir, b.token)).toBeNull();
  });

  it("issue 215: a start that fails never takes the running agent's token", () => {
    const a = mintActorToken(dir, {
      agentId: "scout",
      workspace: "north",
      sessionName: "den-scout",
    });
    bindActorSession(dir, a.key, "s-1");
    running("s-1", JSON.stringify({ id: "s-1" }));
    // A second start: minted, then its start fails and it is revoked.
    const b = mintActorToken(dir, {
      agentId: "scout",
      workspace: "north",
      sessionName: "den-scout",
    });
    revokeActorToken(dir, b.key);
    expect(checkActorToken(dir, a.token)).toMatchObject({
      actor: "agent:scout",
    });
  });

  it("issue 215: once the new session is bound, the older token ends", () => {
    const a = mintActorToken(dir, {
      agentId: "scout",
      workspace: "north",
      sessionName: "den-scout",
    });
    bindActorSession(dir, a.key, "s-1");
    running("s-1", JSON.stringify({ id: "s-1" }));
    const b = mintActorToken(dir, {
      agentId: "scout",
      workspace: "north",
      sessionName: "den-scout",
    });
    bindActorSession(dir, b.key, "s-2");
    running("s-2", JSON.stringify({ id: "s-2" }));
    expect(checkActorToken(dir, a.token)).toBeNull();
    expect(checkActorToken(dir, b.token)).toMatchObject({
      actor: "agent:scout",
    });
  });
});
