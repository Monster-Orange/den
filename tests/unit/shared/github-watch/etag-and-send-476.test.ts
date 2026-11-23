/**
 * Issue 476: the reviewer's GitHub calls share the watcher's gh path. A GET
 * may send If-None-Match with the ETag it last saw, so an unchanged list
 * costs a 304 and no body. Writes (the review, the check run, the status
 * comment) send their JSON on stdin, never in argv.
 */
import { describe, expect, it } from "@jest/globals";
import { ghGet, ghSend } from "../../../../src/shared/github-watch/gh-http.js";

type Run = (
  args: string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

describe("a conditional GET", () => {
  it("sends If-None-Match when given an ETag, and reads a 304 as unchanged", async () => {
    const calls: string[][] = [];
    const run: Run = async (args) => {
      calls.push(args);
      return {
        code: 1,
        stdout: 'HTTP/2.0 304 Not Modified\r\nEtag: W/"abc"\r\n\r\n',
        stderr: "",
      };
    };
    const r = await ghGet(run)("repos/o/r/pulls?state=open", {
      etag: 'W/"abc"',
    });
    expect(calls[0]).toEqual([
      "api",
      "-i",
      "-H",
      'If-None-Match: W/"abc"',
      "repos/o/r/pulls?state=open",
    ]);
    expect(r.status).toBe(304);
    expect(r.headers.etag).toBe('W/"abc"');
  });

  it("without an ETag it asks plainly, as before", async () => {
    const calls: string[][] = [];
    const run: Run = async (args) => {
      calls.push(args);
      return { code: 0, stdout: "HTTP/2.0 200 OK\r\n\r\n[]", stderr: "" };
    };
    await ghGet(run)("repos/o/r/pulls");
    expect(calls[0]).toEqual(["api", "-i", "repos/o/r/pulls"]);
  });

  it("an ETag that could inject a header is refused", async () => {
    const run: Run = async () => ({ code: 0, stdout: "", stderr: "" });
    await expect(
      ghGet(run)("repos/o/r/pulls", { etag: 'x"\r\nAuthorization: y' }),
    ).rejects.toThrow();
  });
});

describe("a write", () => {
  it("sends the method and the JSON on stdin", async () => {
    let seen: { args: string[]; stdin?: string } | null = null;
    const run: Run = async (args, stdin) => {
      seen = { args, stdin };
      return {
        code: 0,
        stdout:
          'HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n{"id":7}',
        stderr: "",
      };
    };
    const r = await ghSend(run)("POST", "repos/o/r/issues/3/comments", {
      body: "hi --method DELETE",
    });
    expect(seen).toEqual({
      args: [
        "api",
        "-i",
        "--method",
        "POST",
        "repos/o/r/issues/3/comments",
        "--input",
        "-",
      ],
      stdin: '{"body":"hi --method DELETE"}',
    });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: 7 });
  });

  it("a path that isn't a plain REST path is refused", async () => {
    const run: Run = async () => ({ code: 0, stdout: "", stderr: "" });
    for (const bad of ["--method=DELETE", "/repos/o/r", "repos/o/r?x=\n"])
      await expect(ghSend(run)("POST", bad, {})).rejects.toThrow();
  });
});
