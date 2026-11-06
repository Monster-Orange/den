/**
 * A client process standing in for the web server: it starts a session on
 * the host at <stateDir>, attaches to it, prints "ready <id>" and stays
 * attached until it is killed.
 *
 *   node --import <tsx loader> start-client.ts <stateDir> <name>
 */
import { connectHost } from "../../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../../src/shared/sessions/paths.js";

async function main(): Promise<void> {
  const [stateDir, name] = process.argv.slice(2);
  const c = await connectHost(sessionPaths(stateDir).socket);
  const info = await c.start({
    name,
    cwd: process.cwd(),
    argv: ["sh", "-c", "echo first; while :; do sleep 0.1; echo tick; done"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    cols: 80,
    rows: 24,
  });
  const att = c.attach(info.ref.id, { onData: () => undefined });
  await att.ready;
  console.log(`ready ${info.ref.id}`);
  setInterval(() => undefined, 60_000);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
