import * as fs from "fs";

const version = fs.readFileSync(process.env.FAKE_VERSION_FILE, "utf-8").trim();
if (version === "broken") process.exit(3);
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let buf = "";
let inits = 0;
process.stdin.on("data", (c) => {
  buf += c;
  for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") {
      inits++;
      out({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: m.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version },
        },
      });
    } else if (m.method === "tools/call") {
      const ms = m.params?.arguments?.ms ?? 0;
      if (m.params?.arguments?.crash) process.exit(4);
      setTimeout(
        () =>
          out({
            jsonrpc: "2.0",
            id: m.id,
            result: {
              content: [
                { type: "text", text: `version=${version} pid=${process.pid} inits=${inits}` },
              ],
            },
          }),
        ms,
      );
    } else if (m.method === "tools/list") {
      out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: `tool_${version}`, inputSchema: { type: "object" } }] } });
    } else if (m.id !== undefined && m.method) {
      out({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
