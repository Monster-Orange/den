/**
 * #70: the process on the other end of a loopback connection, and
 * whether it runs inside a process tree. Real processes on this machine
 * (a child that calls a server here, its own child); and Linux's /proc,
 * as a fake tree, wherever the test runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as http from "http";
import type { AddressInfo } from "net";
import * as net from "net";
import {
  descendsFrom,
  loopbackPeerLine,
  loopbackPeerPid,
} from "../../../src/shared/peer-process.js";

const real = process.platform === "darwin" || process.platform === "linux";

let server: http.Server;
let port = 0;
/** What the server saw per request: the caller's pid, by the header it sent. */
const seen = new Map<string, number | null>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.set(
      String(req.headers["x-who"]),
      loopbackPeerPid(req.socket.remotePort ?? 0, {}, req.socket.localPort),
    );
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

/** A node child that calls the server (once, as `who`), then waits for stdin to end. */
function caller(
  who: string,
  grandchild = false,
): {
  child: ChildProcess;
  pids: Promise<{ parent: number; caller: number }>;
} {
  const call = `fetch("http://127.0.0.1:${port}/",{headers:{"x-who":${JSON.stringify(who)}}}).then(r=>r.text()).then(()=>{console.log("P"+process.pid);process.stdin.resume()})`;
  const code = grandchild
    ? `const c=require("child_process").spawn(process.execPath,["-e",${JSON.stringify(call)}],{stdio:["pipe","pipe","inherit"]});c.stdout.on("data",d=>process.stdout.write(d));process.stdin.on("end",()=>c.stdin.end());process.stdin.resume()`
    : call;
  const child = spawn(process.execPath, ["-e", code], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pids = new Promise<{ parent: number; caller: number }>((resolve) => {
    child.stdout!.on("data", (d: Buffer) => {
      const m = /P(\d+)/.exec(d.toString());
      if (m) resolve({ parent: child.pid!, caller: Number(m[1]) });
    });
  });
  return { child, pids };
}

describe("the caller of a loopback connection (this machine)", () => {
  it("is the process that opened it; and it runs under its parent, not under another", async () => {
    if (!real) return;
    const a = caller("a", true);
    const b = caller("b");
    const pa = await a.pids;
    const pb = await b.pids;
    try {
      // The grandchild made the call: its own pid, not its parent's.
      expect(seen.get("a")).toBe(pa.caller);
      expect(pa.caller).not.toBe(pa.parent);
      expect(seen.get("b")).toBe(pb.caller);
      expect(descendsFrom(pa.caller, pa.parent)).toBe(true);
      expect(descendsFrom(pa.caller, pa.caller)).toBe(true);
      // Another tree: not under a's.
      expect(descendsFrom(pb.caller, pa.parent)).toBe(false);
      expect(descendsFrom(pa.parent, pa.caller)).toBe(false);
    } finally {
      a.child.stdin!.end();
      b.child.stdin!.end();
    }
  }, 30_000);

  it("issue 242: found as it connects, without holding the loop, with its line of parents", async () => {
    if (!real) return;
    const srv = net.createServer();
    const lines: Promise<number[] | null>[] = [];
    srv.on("connection", (sock) => {
      lines.push(loopbackPeerLine(sock.remotePort ?? 0, sock.localPort));
      sock.on("error", () => undefined);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const p = (srv.address() as AddressInfo).port;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const s=require("net").connect(${p},"127.0.0.1",()=>{console.log("P"+process.pid);process.stdin.on("end",()=>s.destroy());process.stdin.resume()})`,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    try {
      const pid = await new Promise<number>((resolve) =>
        child.stdout!.on("data", (d: Buffer) => {
          const m = /P(\d+)/.exec(d.toString());
          if (m) resolve(Number(m[1]));
        }),
      );
      const line = await lines[0];
      expect(line?.[0]).toBe(pid);
      // Its parent is this process: the line reaches it.
      expect(line).toContain(process.pid);
    } finally {
      child.stdin!.end();
      await new Promise((r) => srv.close(r));
    }
  }, 30_000);

  it("no such connection, or a bad port: null", () => {
    expect(loopbackPeerPid(0)).toBeNull();
    expect(loopbackPeerPid(70_000)).toBeNull();
    if (real) expect(loopbackPeerPid(1)).toBeNull();
  });
});

describe("Linux: /proc, as a fake tree", () => {
  // 127.0.0.1:0xCE2A (52778) → 127.0.0.1:0x1F40, ESTABLISHED, inode 4242.
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1F40 0100007F:CE2A 01 00000000:00000000 00:00000000 00000000   501        0 4141 1",
    "   1: 0100007F:CE2A 0100007F:1F40 01 00000000:00000000 00:00000000 00000000   501        0 4242 1",
  ].join("\n");
  const files: Record<string, string> = {
    "/proc/net/tcp": tcp,
    "/proc/300/stat": "300 (claude) S 200 300 300 0",
    "/proc/400/stat": "400 (node (mcp) x) S 300 300 300 0",
    "/proc/200/stat": "200 (den-pty) S 1 200 200 0",
    "/proc/500/stat": "500 (other) S 1 500 500 0",
  };
  const links: Record<string, string> = {
    "/proc/100/fd/3": "socket:[4141]",
    "/proc/400/fd/7": "socket:[4242]",
    "/proc/500/fd/1": "/dev/null",
  };
  const d = {
    platform: "linux" as const,
    self: 100,
    read: (p: string) => {
      if (p in files) return files[p];
      throw new Error("ENOENT");
    },
    readdir: (p: string) =>
      p === "/proc"
        ? ["100", "400", "500", "self", "net"]
        : Object.keys(links)
            .filter((k) => k.startsWith(p + "/"))
            .map((k) => k.slice(p.length + 1)),
    readlink: (p: string) => {
      if (p in links) return links[p];
      throw new Error("ENOENT");
    },
  };

  it("finds the pid holding the client end (never this process)", () => {
    expect(loopbackPeerPid(0xce2a, d)).toBe(400);
    expect(loopbackPeerPid(0x1234, d)).toBeNull();
  });

  it("issue 242: the async lookup gives the caller and its parents", async () => {
    expect(await loopbackPeerLine(0xce2a, undefined, d)).toEqual([
      400, 300, 200, 1,
    ]);
    expect(await loopbackPeerLine(0x1234, undefined, d)).toBeNull();
  });

  it("walks the parents, a comm with spaces and parens too", () => {
    expect(descendsFrom(400, 200, d)).toBe(true);
    expect(descendsFrom(400, 300, d)).toBe(true);
    expect(descendsFrom(500, 200, d)).toBe(false);
    // A parent it can't read: not proved.
    expect(descendsFrom(999, 200, d)).toBe(false);
  });

  it("a lookup that fails or races refuses, never allows", () => {
    // The caller's parent exits mid-walk (its stat is gone): not proved.
    const gone = {
      ...d,
      read: (p: string) => {
        if (p === "/proc/300/stat") throw new Error("ENOENT");
        return d.read(p);
      },
    };
    expect(descendsFrom(400, 200, gone)).toBe(false);
    // A stat that doesn't parse: not proved.
    const junk = {
      ...d,
      read: (p: string) => (p.endsWith("/stat") ? "garbage" : d.read(p)),
    };
    expect(descendsFrom(400, 200, junk)).toBe(false);
    // The socket's inode is in no process's fds (it closed): no pid.
    const closed = {
      ...d,
      readlink: () => {
        throw new Error("ENOENT");
      },
    };
    expect(loopbackPeerPid(0xce2a, closed)).toBeNull();
    // /proc/net/tcp unreadable: no pid.
    const noNet = {
      ...d,
      read: () => {
        throw new Error("EACCES");
      },
    };
    expect(loopbackPeerPid(0xce2a, noNet)).toBeNull();
  });
});

describe("issue 196: a client port shared with another loopback connection", () => {
  // Linux reuses an ephemeral port for a connect() to another destination:
  // 127.0.0.1:0xCE2A → :0x1F40 (our server, pid 400) and → :0x2328 (another
  // server, pid 500), both ESTABLISHED. The server's own port picks ours.
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:CE2A 0100007F:1F40 01 00000000:00000000 00:00000000 00000000   501        0 4242 1",
    "   1: 0100007F:CE2A 0100007F:2328 01 00000000:00000000 00:00000000 00000000   501        0 4343 1",
  ].join("\n");
  const links: Record<string, string> = {
    "/proc/400/fd/7": "socket:[4242]",
    "/proc/500/fd/9": "socket:[4343]",
  };
  const d = {
    platform: "linux" as const,
    self: 100,
    read: (p: string) => {
      if (p === "/proc/net/tcp") return tcp;
      throw new Error("ENOENT");
    },
    readdir: (p: string) =>
      p === "/proc"
        ? ["100", "400", "500"]
        : Object.keys(links)
            .filter((k) => k.startsWith(p + "/"))
            .map((k) => k.slice(p.length + 1)),
    readlink: (p: string) => {
      if (p in links) return links[p];
      throw new Error("ENOENT");
    },
  };

  it("Linux: the row to this server's port is the caller's", () => {
    expect(loopbackPeerPid(0xce2a, d, 0x1f40)).toBe(400);
    expect(loopbackPeerPid(0xce2a, d, 0x2328)).toBe(500);
    // A server port no row goes to: no pid.
    expect(loopbackPeerPid(0xce2a, d, 0x1234)).toBeNull();
  });

  it("macOS: the row whose remote end is this server's port", () => {
    const run = () =>
      "p100\nn127.0.0.1:8000->127.0.0.1:52921\np400\nn127.0.0.1:52921->127.0.0.1:8000\np500\nn127.0.0.1:52921->127.0.0.1:9000\n";
    expect(
      loopbackPeerPid(52921, { platform: "darwin", self: 100, run }, 8000),
    ).toBe(400);
  });
});

describe("macOS: lsof's rows", () => {
  it("the row whose local end is the caller's port; this process's own row never", () => {
    const run = () =>
      "p100\nf13\nn127.0.0.1:8000->127.0.0.1:52921\np400\nf12\nn127.0.0.1:52921->127.0.0.1:8000\n";
    expect(loopbackPeerPid(52921, { platform: "darwin", self: 100, run })).toBe(
      400,
    );
    // Two processes on it (a shared socket): can't tell.
    const two = () =>
      "p400\nn[::1]:52921->[::1]:8000\np401\nn[::1]:52921->[::1]:8000\n";
    expect(
      loopbackPeerPid(52921, { platform: "darwin", self: 100, run: two }),
    ).toBeNull();
  });

  it("issue 242: the async lookup asks lsof, then ps, never holding the loop", async () => {
    const asked: string[] = [];
    const run = async (cmd: string) => {
      asked.push(cmd);
      return cmd.endsWith("lsof")
        ? "p400\nn127.0.0.1:52921->127.0.0.1:8000\n"
        : "  400   300\n  300   200\n  200     1\n";
    };
    expect(
      await loopbackPeerLine(52921, 8000, {
        platform: "darwin",
        self: 100,
        run,
      }),
    ).toEqual([400, 300, 200, 1]);
    expect(asked).toEqual(["/usr/sbin/lsof", "/bin/ps"]);
  });

  it("an unknown platform: null and false", () => {
    expect(loopbackPeerPid(5, { platform: "win32" })).toBeNull();
    expect(descendsFrom(5, 4, { platform: "win32" })).toBe(false);
  });
});
