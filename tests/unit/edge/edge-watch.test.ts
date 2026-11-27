import { describe, expect, it } from "@jest/globals";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import {
  EDGE_EVENTS_ARGS,
  edgeEventLost,
  watchEdgeContainer,
  type SpawnWatch,
} from "../../../src/shared/edge/watch.js";

const ID = "a".repeat(64);
const OTHER = "b".repeat(64);

const ev = (o: Record<string, unknown>) => JSON.stringify(o);
const container = (Action: string, id = ID) =>
  ev({ Type: "container", Action, Actor: { ID: id, Attributes: {} } });
const disconnect = (id = ID) =>
  ev({
    Type: "network",
    Action: "disconnect",
    Actor: { ID: "net1", Attributes: { container: id } },
  });

function fakeSpawn() {
  const calls: { cmd: string; args: string[]; opts: unknown }[] = [];
  const kids: (EventEmitter & {
    stdout: PassThrough;
    killed: boolean;
    kill: () => void;
    unref: () => void;
  })[] = [];
  const spawn: SpawnWatch = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const k = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      killed: false,
      kill() {
        k.killed = true;
        k.emit("exit", null, "SIGTERM");
      },
      unref() {},
    });
    kids.push(k);
    return k;
  };
  return { spawn, calls, kids };
}

const lines = async (k: { stdout: PassThrough }, ...ls: string[]) => {
  k.stdout.write(ls.join("\n") + "\n");
  await new Promise((r) => setImmediate(r));
};

describe("which events take the edge's trust away", () => {
  it("die, stop, kill, destroy of the edge's own container, and its network disconnect", () => {
    for (const a of ["die", "stop", "kill", "destroy"])
      expect(edgeEventLost(container(a), ID)).toBe(true);
    expect(edgeEventLost(disconnect(), ID)).toBe(true);
  });

  it("another container's events, other actions, or a line that isn't an event: nothing", () => {
    for (const a of ["die", "stop", "kill", "destroy"])
      expect(edgeEventLost(container(a, OTHER), ID)).toBe(false);
    expect(edgeEventLost(disconnect(OTHER), ID)).toBe(false);
    for (const a of ["start", "exec_create", "health_status: healthy"])
      expect(edgeEventLost(container(a), ID)).toBe(false);
    for (const bad of ["", "{", "null", "[]", ev({ Type: "container" })])
      expect(edgeEventLost(bad, ID)).toBe(false);
    expect(edgeEventLost(container("die", ID.slice(0, 12)), ID)).toBe(false);
  });
});

describe("watchEdgeContainer", () => {
  it("runs docker events with no shell and fixed args, filtered by the edge's ID and the events that matter", () => {
    const f = fakeSpawn();
    watchEdgeContainer(ID, { lost() {}, ended() {} }, f.spawn);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].cmd).toBe("docker");
    expect(f.calls[0].args).toEqual([
      "events",
      "--format",
      "{{json .}}",
      "--filter",
      "type=container",
      "--filter",
      "type=network",
      "--filter",
      "event=die",
      "--filter",
      "event=stop",
      "--filter",
      "event=kill",
      "--filter",
      "event=destroy",
      "--filter",
      "event=disconnect",
    ]);
    expect(f.calls[0].opts).toMatchObject({ shell: false });
  });

  it("since: Docker replays events from then (--since, whole seconds), so none in the gap before it connects are missed", () => {
    const f = fakeSpawn();
    watchEdgeContainer(
      ID,
      { lost() {}, ended() {} },
      f.spawn,
      1_764_000_000_900,
    );
    expect(f.calls[0].args.slice(-2)).toEqual(["--since", "1764000000"]);
    expect(f.calls[0].args.slice(0, -2)).toEqual([...EDGE_EVENTS_ARGS]);
  });

  it("a since that isn't a time is never passed: ended at once", () => {
    for (const bad of [NaN, -1, Infinity]) {
      const f = fakeSpawn();
      let ended = 0;
      watchEdgeContainer(ID, { lost() {}, ended: () => ended++ }, f.spawn, bad);
      expect(f.calls).toHaveLength(0);
      expect(ended).toBe(1);
    }
  });

  it("the edge's die: lost; another container's: nothing", async () => {
    const f = fakeSpawn();
    let lost = 0;
    watchEdgeContainer(ID, { lost: () => lost++, ended() {} }, f.spawn);
    await lines(f.kids[0], container("die", OTHER), disconnect(OTHER));
    expect(lost).toBe(0);
    await lines(f.kids[0], container("die"));
    expect(lost).toBe(1);
  });

  it("it exits or errors: ended, once", async () => {
    for (const how of ["exit", "error"] as const) {
      const f = fakeSpawn();
      let ended = 0;
      watchEdgeContainer(ID, { lost() {}, ended: () => ended++ }, f.spawn);
      if (how === "exit") f.kids[0].emit("exit", 1, null);
      else f.kids[0].emit("error", new Error("spawn docker ENOENT"));
      f.kids[0].emit("exit", 1, null);
      expect(ended).toBe(1);
    }
  });

  it("it can't start at all (spawn throws): ended", () => {
    let ended = 0;
    watchEdgeContainer(ID, { lost() {}, ended: () => ended++ }, () => {
      throw new Error("EAGAIN");
    });
    expect(ended).toBe(1);
  });

  it("stop(): killed, and not ended", () => {
    const f = fakeSpawn();
    let ended = 0;
    const stop = watchEdgeContainer(
      ID,
      { lost() {}, ended: () => ended++ },
      f.spawn,
    );
    stop();
    expect(f.kids[0].killed).toBe(true);
    expect(ended).toBe(0);
  });

  it("an ID that isn't a full container ID is never watched: ended at once", () => {
    const f = fakeSpawn();
    let ended = 0;
    watchEdgeContainer(
      "abc; rm -rf /",
      { lost() {}, ended: () => ended++ },
      f.spawn,
    );
    expect(f.calls).toHaveLength(0);
    expect(ended).toBe(1);
  });
});
