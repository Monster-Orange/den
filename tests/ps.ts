/**
 * `ps`'s whole output for a test. den#143: a whole-machine list with
 * commands passes Node's default 1 MiB on a busy machine; the read then
 * threw ENOBUFS, an error that holds itself (`error.error`), which jest's
 * worker cannot send, so the suite showed only "failed to run".
 */
import { execFileSync } from "child_process";
import { PS_MAX_BUFFER } from "../src/shared/process/ps-buffer.js";

export function psOut(args: string[]): string {
  return execFileSync("ps", args, {
    encoding: "utf-8",
    maxBuffer: PS_MAX_BUFFER,
  });
}
