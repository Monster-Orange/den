/**
 * Issue 500: a terminal host stand-in that is stuck. It holds the socket
 * (connections are accepted) and answers nothing, and it wrote its
 * sessions.host.json as a real host does:
 * `node stuck-sessions-host.mjs <socket> <info file> <den version>`.
 * Its file name has "sessions" in it, as a real host's command line does.
 */
import * as fs from "fs";
import * as net from "net";

const [socket, info, den] = process.argv.slice(2);
const startedAt = new Date().toISOString();
const held = [];
const server = net.createServer((c) => {
  held.push(c); // read nothing, answer nothing
  c.on("error", () => undefined);
});
server.listen(socket, () => {
  fs.writeFileSync(
    info,
    JSON.stringify({ pid: process.pid, startedAt, den, code: null }) + "\n",
  );
  process.stdout.write("listening\n");
});
// The test's temp dir goes: so does this stand-in.
setInterval(() => {
  if (!fs.existsSync(info) && !fs.existsSync(socket)) process.exit(0);
}, 1000);
