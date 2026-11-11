/**
 * D47: a service agents may reach only through its API. Den's PreToolUse
 * hook (guardrails/pretooluse.mjs --api-only <rules> --audit <file>), run
 * as Claude Code runs it, denies a call that goes around the API: into the
 * service's containers or volumes, its data paths, or its OrbStack
 * machine. It is a guardrail: it reads the command's words.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const HOOK = path.resolve("src/shared/agents/guardrails/pretooluse.mjs");
const dir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-apionly-")),
);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const home = path.join(dir, "home");
const repo = path.join(dir, "repos", "vault");
const other = path.join(dir, "repos", "shop");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(other, { recursive: true });
const data = path.join(repo, "var", "db");

const rules = path.join(dir, "api-only.json");
const auditFile = path.join(dir, "audit", "api-only.jsonl");
fs.writeFileSync(
  rules,
  JSON.stringify({
    services: [
      {
        name: "vault",
        project: "vault",
        containers: ["vaultdb"],
        volumes: ["vault-store"],
        composeServices: ["api", "db"],
        composeVolumes: ["data"],
        paths: [data],
        machine: "vaultvm",
      },
    ],
  }),
);

function run(
  input: unknown,
  args: string[] = ["--api-only", rules, "--audit", auditFile],
  env: Record<string, string> = {},
): { code: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK, ...args], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
  });
  return { code: r.status, stderr: r.stderr };
}
const bash = (command: string, cwd = other, env: Record<string, string> = {}) =>
  run({ tool_name: "Bash", tool_input: { command }, cwd }, undefined, env);
const tool = (tool_name: string, tool_input: Record<string, unknown>) =>
  run({ tool_name, tool_input, cwd: other });

describe("D47: around the API is denied, with the API offered", () => {
  it.each([
    // Into its containers, in any spelling.
    "docker exec vault-api-1 sqlite3 /data/db.sqlite .dump",
    "docker exec -it vault-api-1 sh",
    "docker exec -u root -w /data vault-api-1 ls",
    "docker container exec vault-api-1 ls",
    "docker exec vaultdb psql",
    "docker attach vault-api-1",
    "docker export vault-api-1",
    "docker cp vault-api-1:/data/db.sqlite /tmp/x",
    "docker cp ./x vault-api-1:/data/",
    "docker --context default exec vault-api-1 ls",
    // Its volumes.
    "docker run --rm -v vault_data:/d alpine cat /d/db",
    "docker run --rm --volume=vault-store:/d alpine ls /d",
    "docker run --rm --mount type=volume,source=vault_data,target=/d alpine ls",
    "docker create --volumes-from vault-api-1 alpine",
    "docker volume inspect vault_data",
    "docker volume rm vault-store",
    // Its compose project.
    "docker compose -p vault exec api sh",
    "docker compose --project-name=vault cp api:/data/db .",
    "docker-compose -p vault run api sh",
    "COMPOSE_PROJECT_NAME=vault docker compose exec api sh",
    // Wrapped.
    'sh -c "docker exec vault-api-1 ls"',
    "bash -lc 'docker exec vault-api-1 ls'",
    "sudo -u root docker exec vault-api-1 ls",
    "env FOO=1 docker exec vault-api-1 ls",
    "timeout 5 docker exec vault-api-1 ls",
    'echo "$(docker exec vault-api-1 cat /data/x)"',
    "ls && docker exec vault-api-1 ls",
    "eval docker exec vault-api-1 ls",
    // Its data paths.
    `cat ${data}/main.sqlite`,
    `sqlite3 ${data}/main.sqlite .dump`,
    `cp ${data}/main.sqlite /tmp/`,
    `docker run -v ${data}:/d alpine ls /d`,
    // Its machine.
    "orb -m vaultvm sqlite3 /data/db",
    "orbctl run -m vaultvm ls",
    "orb shell vaultvm",
    "orb sh",
    "ssh vaultvm@orb",
    "ssh root@vaultvm.orb.local cat /data/db",
    "scp vaultvm.orb.local:/data/db .",
    "docker --context vaultvm ps",
    "DOCKER_CONTEXT=vaultvm docker ps",
    "docker -H ssh://root@vaultvm.orb.local ps",
    "cat ~/OrbStack/vaultvm/data/db",
    "ls ~/.orbstack/run",
  ])("%s", (command) => {
    const r = bash(command);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(
      /goes around vault, which agents may reach only through its API/,
    );
    expect(r.stderr).toMatch(/Use its API or its MCP tools instead/);
  });

  it("a compose call is matched by its project, as compose picks it, never by where it runs", () => {
    // A folder named for the project, with no -p: compose's own default.
    const named = path.join(dir, "elsewhere", "vault");
    fs.mkdirSync(named, { recursive: true });
    expect(bash("docker compose exec api sh", named).code).toBe(2);
    // The service's checkout, its compose file naming another project.
    fs.writeFileSync(
      path.join(repo, "compose.yaml"),
      "name: vault-dev\nservices: {}\n",
    );
    expect(bash("docker compose exec api sh", repo).code).toBe(0);
    expect(bash("docker compose -p vault exec api sh", repo).code).toBe(2);
    fs.rmSync(path.join(repo, "compose.yaml"));
    expect(bash("docker compose exec api sh", other).code).toBe(0);
  });

  it("another instance that shares the prefix (vault-dev) is not it", () => {
    for (const c of [
      "docker exec vault-dev-api-1 sh",
      "docker compose -p vault-dev exec api sh",
      "docker run --rm -v vault-dev_data:/d alpine ls",
      "docker volume inspect vault-dev_data",
    ])
      expect([c, bash(c).code]).toEqual([c, 0]);
  });

  it("DOCKER_CONTEXT from the agent's own environment counts", () => {
    expect(bash("docker ps", other, { DOCKER_CONTEXT: "vaultvm" }).code).toBe(
      2,
    );
  });

  it.each([
    ["Read", { file_path: `${data}/main.sqlite` }],
    ["Write", { file_path: `${data}/x`, content: "y" }],
    ["Edit", { file_path: `${data}/x`, old_string: "a", new_string: "b" }],
    ["Grep", { pattern: "x", path: data }],
    ["Glob", { pattern: "*", path: path.join(home, "OrbStack") }],
  ])("%s of its data", (name, input) => {
    expect(tool(name, input).code).toBe(2);
  });
});

describe("D47: the API, and everything else, passes", () => {
  it.each([
    "docker ps",
    "docker logs vault-api-1",
    "docker inspect vault-api-1",
    "docker exec shop-api-1 ls",
    "docker run --rm -v shop_data:/d alpine ls /d",
    "docker volume ls",
    "docker compose -p shop exec api sh",
    "curl -s http://vault.localhost/api/items",
    "orb list",
    "orb -m othervm ls",
    "ssh othervm@orb",
    `ls ${repo}/src`,
    "git status",
    "echo vault-api-1",
  ])("%s", (command) => {
    expect(bash(command).code).toBe(0);
  });

  it("a Read of the service's code passes", () => {
    expect(
      tool("Read", { file_path: path.join(repo, "src", "a.ts") }).code,
    ).toBe(0);
  });

  it("with no rules file, nothing D47 is denied", () => {
    const r = run(
      {
        tool_name: "Bash",
        tool_input: { command: "docker exec vault-api-1 ls" },
        cwd: other,
      },
      ["--api-only", path.join(dir, "none.json")],
    );
    expect(r.code).toBe(0);
  });

  it("--no-guardrails: only D47, not the log and sleep checks", () => {
    const args = ["--api-only", rules, "--no-guardrails"];
    expect(
      run(
        { tool_name: "Bash", tool_input: { command: "sleep 30" }, cwd: other },
        args,
      ).code,
    ).toBe(0);
    expect(
      run(
        {
          tool_name: "Bash",
          tool_input: { command: "docker exec vault-api-1 ls" },
          cwd: other,
        },
        args,
      ).code,
    ).toBe(2);
  });
});

describe("D47: a denial is audited, without the command", () => {
  it("writes when, which agent, which tool and service, and what", () => {
    fs.rmSync(auditFile, { force: true });
    const r = bash(
      "docker exec vault-api-1 sh -c 'TOKEN=s3cr3t-value curl x'",
      other,
      { DEN_CLAUDE_ID: "planner" },
    );
    expect(r.code).toBe(2);
    const lines = fs.readFileSync(auditFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(rec).toMatchObject({
      kind: "api_only.denied",
      agent: "planner",
      tool: "Bash",
      service: "vault",
      what: "docker exec vault-api-1",
    });
    expect(lines[0]).not.toContain("s3cr3t");
    expect(fs.statSync(auditFile).mode & 0o777).toBe(0o600);
  });
});
