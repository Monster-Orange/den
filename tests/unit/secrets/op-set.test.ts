/**
 * 1Password writes never put the secret in argv (0.4.26). Any process on
 * the machine can read another's command line (ps), so `set` sends the
 * value only on op's stdin, as the item's JSON: `op item edit <id>` for an
 * item that exists, `op item create -` for a new one.
 *
 * A fake `op` sits first on PATH: it logs every argv and keeps items in a
 * JSON file. The real op is never run. Invented names only.
 */
import { afterAll, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OnePasswordProvider } from "../../../src/shared/secrets/onepassword.js";

const SECRET = "s3cr3t-TESTONLY-value-9b1";
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), "op-set-bin-"));
const STORE = path.join(BIN, "items.json");
const ARGV = path.join(BIN, "argv.log");

fs.writeFileSync(
  path.join(BIN, "op"),
  `#!${process.execPath}
const fs = require("fs");
const [store, log] = [${JSON.stringify(STORE)}, ${JSON.stringify(ARGV)}];
const a = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(a) + "\\n");
const items = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf-8")) : {};
const save = () => fs.writeFileSync(store, JSON.stringify(items));
const stdin = () => fs.readFileSync(0, "utf-8");
// The old way: an assignment in argv (label[type]=value), no stdin.
const asg = a.find((x) => /^[^-][^=]*\\[[a-z]+\\]=/.test(x));
const fromAsg = () => { const m = /^([^\\[]+)\\[[a-z]+\\]=(.*)$/s.exec(asg); return { label: m[1], type: "CONCEALED", value: m[2] }; };
// Failure modes: a file next to the fake holds op's stderr for that verb.
const failFile = (verb) => require("path").join(require("path").dirname(store), "fail-" + verb);
for (const verb of ["get", "create", "edit"])
  if (a[1] === verb && fs.existsSync(failFile(verb))) {
    process.stderr.write(fs.readFileSync(failFile(verb), "utf-8"));
    process.exit(1);
  }
if (a[0] === "item" && a[1] === "get") {
  const it = Object.values(items).find((i) => i.title === a[2] || i.id === a[2]);
  if (!it) { process.stderr.write('"' + a[2] + '" isn\\'t an item.\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(it));
} else if (asg && a[1] === "edit") {
  const it = Object.values(items).find((i) => i.title === a[2] || i.id === a[2]);
  if (!it) process.exit(1);
  const f = fromAsg(); const old = it.fields.find((x) => x.label === f.label);
  if (old) old.value = f.value; else it.fields.push(f);
  save();
} else if (asg && a[1] === "create") {
  const t = a[a.indexOf("--title") + 1];
  items["id9"] = { id: "id9", title: t, fields: [fromAsg()] }; save();
} else if (a[0] === "item" && a[1] === "edit") {
  const it = JSON.parse(stdin());
  if (!items[a[2]]) process.exit(1);
  items[a[2]] = it; save();
} else if (a[0] === "item" && a[1] === "create" && a.includes("-")) {
  const it = JSON.parse(stdin());
  it.id = "id" + (Object.keys(items).length + 1);
  items[it.id] = it; save();
} else process.exit(2);
`,
  { mode: 0o755 },
);

const savedPath = process.env.PATH;
beforeEach(() => {
  process.env.PATH = `${BIN}:/usr/bin:/bin`;
  for (const f of [STORE, ARGV, ...["get", "create", "edit"].map(fail)])
    fs.rmSync(f, { force: true });
});
afterAll(() => {
  process.env.PATH = savedPath;
  fs.rmSync(BIN, { recursive: true, force: true });
});

const fail = (verb: string) => path.join(BIN, `fail-${verb}`);
const failWith = (verb: string, stderr: string) =>
  fs.writeFileSync(fail(verb), stderr);
const op = () =>
  new OnePasswordProvider({
    tokenDeps: { env: {} } as never,
    timeoutMs: 10_000,
  });
const argvs = (): string[][] =>
  fs
    .readFileSync(ARGV, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
const items = () =>
  JSON.parse(fs.readFileSync(STORE, "utf-8")) as Record<
    string,
    { title: string; fields: { label?: string; id?: string; value?: string }[] }
  >;

describe("op set: the value never in argv", () => {
  it("a new item is created from JSON on stdin (op item create -)", async () => {
    await op().set(
      { vault: "Private", item: "Acme Hub", field: "token" },
      SECRET,
    );
    const calls = argvs();
    expect(calls.flat().join(" ")).not.toContain(SECRET);
    expect(calls.at(-1)).toEqual(["item", "create", "--vault", "Private", "-"]);
    const made = Object.values(items())[0];
    expect(made.title).toBe("Acme Hub");
    expect(made.fields.find((f) => f.label === "token")?.value).toBe(SECRET);
  });

  it("an existing item is edited from its JSON on stdin; its other fields stay", async () => {
    fs.writeFileSync(
      STORE,
      JSON.stringify({
        i1: {
          id: "i1",
          title: "Acme admin password",
          fields: [
            { id: "username", label: "username", value: "pat" },
            { id: "password", label: "password", value: "old" },
          ],
        },
      }),
    );
    await op().set(
      { vault: "", item: "Acme admin password", field: "password" },
      SECRET,
    );
    expect(argvs().flat().join(" ")).not.toContain(SECRET);
    expect(argvs().at(-1)).toEqual(["item", "edit", "i1"]);
    const f = items().i1.fields;
    expect(f.find((x) => x.label === "password")?.value).toBe(SECRET);
    expect(f.find((x) => x.label === "username")?.value).toBe("pat");
  });

  it("a field the item doesn't have yet is added", async () => {
    fs.writeFileSync(
      STORE,
      JSON.stringify({ i1: { id: "i1", title: "Keys", fields: [] } }),
    );
    await op().set({ vault: "", item: "Keys", field: "HUB_TOKEN" }, SECRET);
    expect(argvs().flat().join(" ")).not.toContain(SECRET);
    expect(items().i1.fields.find((x) => x.label === "HUB_TOKEN")?.value).toBe(
      SECRET,
    );
  });
});

describe("op set: only a missing item is created; op's own reason otherwise (0.4.27)", () => {
  const one = {
    i1: {
      id: "i1",
      title: "Acme admin password",
      fields: [{ id: "password", label: "password", value: "old" }],
    },
  };
  const ref = {
    vault: "Private",
    item: "Acme admin password",
    field: "password",
  };

  it("a get that fails for another reason (a timeout) creates nothing and says why, without op's [ERROR] prefix", async () => {
    fs.writeFileSync(STORE, JSON.stringify(one));
    failWith("get", "[ERROR] 2026/11/10 12:00:00 Request timed out\n");
    await expect(op().set(ref, SECRET)).rejects.toThrow(/^Request timed out$/);
    expect(argvs().some((x) => x[1] === "create")).toBe(false);
    expect(Object.keys(items())).toEqual(["i1"]);
  });

  it("two items by that title: no third one", async () => {
    failWith(
      "get",
      '[ERROR] 2026/11/10 12:00:00 More than one item matches "Acme admin password".\n',
    );
    await expect(op().set(ref, SECRET)).rejects.toThrow(/More than one item/);
    expect(argvs().some((x) => x[1] === "create")).toBe(false);
  });

  it("a missing item whose create fails shows create's reason, not get's", async () => {
    failWith(
      "create",
      '[ERROR] 2026/11/10 12:00:00 Vault "Private" is not available.\n',
    );
    const e = (await op()
      .set(ref, SECRET)
      .catch((x: unknown) => x)) as Error;
    expect(e.message).toBe('Vault "Private" is not available.');
    expect(e.message).not.toContain(SECRET);
  });

  it("a failed edit says op's reason, without the value", async () => {
    fs.writeFileSync(STORE, JSON.stringify(one));
    failWith(
      "edit",
      "[ERROR] 2026/11/10 12:00:00 You do not have permission\n",
    );
    const e = (await op()
      .set(ref, SECRET)
      .catch((x: unknown) => x)) as Error;
    expect(e.message).toBe("You do not have permission");
  });
});
