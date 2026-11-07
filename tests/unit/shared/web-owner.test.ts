/**
 * SEC-2a: the owner's GitHub identity, `<state dir>/web-owner.json`: mode
 * 0600, `github:<numeric id>` plus the login for display, and never a
 * token. readWebOwner refuses a file that isn't one.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  clearWebOwner,
  readWebOwner,
  webOwnerPath,
  writeWebOwner,
} from "../../../src/shared/web-owner.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-owner-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the owner file", () => {
  it("stores github:<id> and the login, 0600, and nothing else", () => {
    const rec = writeWebOwner(
      { id: 4242, login: "octo-owner" },
      dir,
      new Date("2026-11-06T12:00:00Z"),
    );
    expect(rec).toEqual({
      owner: "github:4242",
      login: "octo-owner",
      linkedAt: "2026-11-06T12:00:00.000Z",
    });
    const file = webOwnerPath(dir);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(
      Object.keys(JSON.parse(fs.readFileSync(file, "utf-8"))).sort(),
    ).toEqual(["linkedAt", "login", "owner", "v"]);
    expect(readWebOwner(dir)).toEqual(rec);
  });

  it("refuses an id or login that isn't one", () => {
    expect(() => writeWebOwner({ id: 0, login: "x" }, dir)).toThrow();
    expect(() => writeWebOwner({ id: 1.5, login: "x" }, dir)).toThrow();
    expect(() => writeWebOwner({ id: 1, login: "a b" }, dir)).toThrow();
  });

  it("reads a malformed or foreign file as no owner", () => {
    const file = webOwnerPath(dir);
    for (const bad of [
      "nope",
      "{}",
      JSON.stringify({ owner: "github:abc", login: "x" }),
      JSON.stringify({ owner: "google:1", login: "x" }),
      JSON.stringify({ owner: "github:1", login: "<script>" }),
    ]) {
      fs.writeFileSync(file, bad);
      expect([bad, readWebOwner(dir)]).toEqual([bad, null]);
    }
  });

  it("clear removes it and says who it was", () => {
    writeWebOwner({ id: 4242, login: "octo-owner" }, dir);
    expect(clearWebOwner(dir)?.login).toBe("octo-owner");
    expect(fs.existsSync(webOwnerPath(dir))).toBe(false);
    expect(clearWebOwner(dir)).toBeNull();
  });
});
