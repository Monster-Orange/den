/**
 * A port for a server a test starts later, in another process (issue 658).
 *
 * A port from listen(0) is an ephemeral one: once released, the next
 * listen(0) anywhere on the machine (another test's server) may get it
 * before the child binds it. So `quietPort` picks at random in 12000-17999:
 * below every ephemeral range (Linux 32768+, macOS 49152+) and away from
 * the bands other tests pick from (18888, 19876+, 20000-31999). It takes a
 * port only when nothing answers a connect there and a bind succeeds.
 */
import * as net from "net";

export const QUIET_LOW = 12_000;
export const QUIET_HIGH = 17_999;

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect({ port, host: "127.0.0.1" });
    c.setTimeout(500);
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("timeout", () => {
      c.destroy();
      resolve(false);
    });
    c.once("error", () => resolve(false));
  });
}

function binds(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "localhost", () => s.close(() => resolve(true)));
  });
}

/** A random port in 12000-17999 that nothing answers on and that binds. */
export async function quietPort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port =
      QUIET_LOW + Math.floor(Math.random() * (QUIET_HIGH - QUIET_LOW + 1));
    if ((await answers(port)) || !(await binds(port))) continue;
    return port;
  }
  throw new Error(`no quiet port in ${QUIET_LOW}-${QUIET_HIGH}`);
}
