#!/usr/bin/env node
/**
 * mcp-smoke: start `<bin> mcp`, send initialize then tools/list over stdio,
 * and check both answer with every stdout line a JSON-RPC message. The web
 * server need not run: neither request reaches it.
 *
 *   node scripts/mcp-smoke.mjs ./bin/acme
 *
 * Prints the tool names; exits non-zero on any failure.
 */
import { spawn } from "node:child_process";

const bin = process.argv[2];
if (!bin) {
  console.error("usage: mcp-smoke.mjs <bin>");
  process.exit(2);
}

const child = spawn(bin, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
const waiting = new Map();
const bad = [];
let buf = "";
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      bad.push(line);
      continue;
    }
    if (msg.jsonrpc !== "2.0") bad.push(line);
    waiting.get(msg.id)?.(msg);
  }
});

const ask = (id, method, params = {}) =>
  new Promise((resolve) => {
    waiting.set(id, resolve);
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });

const timer = setTimeout(() => {
  console.error(`mcp-smoke: timed out\n${stderr}`);
  child.kill();
  process.exit(1);
}, 30_000);

const init = await ask(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "mcp-smoke", version: "1.0.0" },
});
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
    "\n",
);
const list = await ask(2, "tools/list");
clearTimeout(timer);
child.kill();

const names = (list.result?.tools ?? []).map((t) => t.name);
const fails = [];
if (!init.result?.serverInfo?.name) fails.push("initialize: no serverInfo");
if (!names.includes("status") || !names.includes("stacks"))
  fails.push(`tools/list: read tools missing (${names.join(", ")})`);
if (bad.length)
  fails.push(`non-protocol stdout: ${bad.slice(0, 3).join(" | ")}`);
if (fails.length) {
  console.error(`mcp-smoke: ${fails.join("; ")}\n${stderr}`);
  process.exit(1);
}
console.log(`server ${init.result.serverInfo.name}: ${names.join(" ")}`);
