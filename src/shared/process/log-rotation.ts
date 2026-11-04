/**
 * Size-capped rotation for service logs.
 *
 * Service logs are written by DETACHED child processes that inherited an
 * O_APPEND file descriptor (see spawnDaemon): den opens the file, hands the
 * fd to the child, then closes its own copy. Nothing can make that child
 * reopen — the command is arbitrary shell with no SIGHUP contract — and it
 * outlives den. A chatty service therefore grows the file forever; a
 * localstack tail was measured at 8.6 GB.
 *
 * That single fact rules out the usual strategies, and is why no logging
 * library helps here (they all rotate a stream THEY own):
 *
 *  - RENAME (`mv x.log x.log.1`) is silently fatal. The child's fd follows the
 *    inode, so it keeps writing into the renamed file while `x.log` stays
 *    empty — and every reader tails by name, so live logs stop forever with no
 *    error anywhere.
 *  - TRUNCATE-HEAD (keep the last N bytes at offset 0) makes `tail -F` notice
 *    the file shrank and restart from the beginning, re-flooding every viewer
 *    with the whole retained tail. It also shifts every byte offset, so the
 *    history pager silently renders the wrong page.
 *
 * What works is copy-then-truncate-to-ZERO: copy the tail into `<name>.log.1`,
 * then truncate the live file in place. The inode never moves, so the child's
 * fd stays valid and O_APPEND puts its next write at the new EOF. Readers cope:
 * `tail -F` restarts at offset 0 and finds one banner line rather than a flood,
 * and a stale history cursor clamps to a tiny file and ends paging cleanly.
 *
 * INVARIANT: the child's fd must stay O_APPEND. With plain O_WRONLY the kernel
 * keeps the old offset and truncation produces a multi-gigabyte sparse hole of
 * NULs. spawn-streaming opens with "a"; a test pins it.
 */

import * as fs from "fs";
import * as path from "path";
import { MAX_LOG_BYTES, ROTATED_KEEP_BYTES } from "../constants.js";

import { product } from "../product.js";
/** Where a rotated generation is kept — one only, overwritten each time. */
export function rotatedPathFor(logPath: string): string {
  return `${logPath}.1`;
}

/**
 * Rotate `logPath` when it exceeds `maxBytes`. Returns true when it rotated.
 *
 * Best-effort by design: a log that cannot be rotated must never break the
 * service that writes to it, so every failure degrades to "left as-is".
 */
export function rotateIfOversized(
  logPath: string,
  maxBytes: number = MAX_LOG_BYTES,
  keepBytes: number = ROTATED_KEEP_BYTES,
): boolean {
  let size: number;
  try {
    const st = fs.statSync(logPath);
    if (!st.isFile()) return false;
    size = st.size;
  } catch {
    return false; // no log yet
  }
  if (size <= maxBytes) return false;

  try {
    copyTail(logPath, rotatedPathFor(logPath), Math.min(keepBytes, size));
    // Truncate to ZERO, not to a retained tail — see the module docstring.
    fs.truncateSync(logPath, 0);
    fs.appendFileSync(
      logPath,
      `\n─── ${product().cli} rotated ${new Date().toISOString()} — earlier output in ${path.basename(rotatedPathFor(logPath))} ───\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the last `bytes` of `from` into `to`, starting at the first line break
 * so the rotated file doesn't open mid-line. Streams in chunks — the whole
 * point is that these files are too big to hold in memory.
 */
function copyTail(from: string, to: string, bytes: number): void {
  const src = fs.openSync(from, "r");
  try {
    const size = fs.fstatSync(src).size;
    let start = Math.max(0, size - bytes);
    if (start > 0) {
      // Snap forward to just past the next newline.
      const probe = Buffer.alloc(Math.min(64 * 1024, size - start));
      const read = fs.readSync(src, probe, 0, probe.length, start);
      const nl = probe.subarray(0, read).indexOf(0x0a);
      if (nl !== -1) start += nl + 1;
    }
    const dst = fs.openSync(to, "w");
    try {
      const buf = Buffer.alloc(1024 * 1024);
      let pos = start;
      for (;;) {
        const read = fs.readSync(src, buf, 0, buf.length, pos);
        if (read <= 0) break;
        fs.writeSync(dst, buf, 0, read);
        pos += read;
      }
    } finally {
      fs.closeSync(dst);
    }
  } finally {
    fs.closeSync(src);
  }
}

/**
 * Rotate every oversized `*.log` under a log root (`<root>/<repo>/<name>.log`).
 * Returns the paths rotated. Never throws — a sweep failure must not take the
 * server down.
 */
export function sweepLogs(
  logRoot: string,
  maxBytes: number = MAX_LOG_BYTES,
): string[] {
  const rotated: string[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(logRoot, { withFileTypes: true });
  } catch {
    return rotated; // no logs yet
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const sub = path.join(logRoot, dir.name);
    let files: string[];
    try {
      files = fs.readdirSync(sub);
    } catch {
      continue;
    }
    for (const file of files) {
      // `.log.1` is the rotated generation — capping it again would discard it.
      if (!file.endsWith(".log")) continue;
      const full = path.join(sub, file);
      if (rotateIfOversized(full, maxBytes)) rotated.push(full);
    }
  }
  return rotated;
}
