/**
 * Issue 786 clause 3: the bell's item for each state file Den couldn't read
 * and kept in <state>/backup (src/shared/state-backup.ts). One item per file
 * (its subject names the file), updated when the same file breaks again.
 * Files kept while no server ran (a CLI, the sessions host) are told at the
 * server's start; each note is told once.
 */
import {
  type KeptFile,
  markKeptTold,
  onKept,
  readKept,
} from "../../shared/state-backup.js";
import type { NotificationStore } from "../../shared/notifications.js";

type Bell = Pick<NotificationStore, "add">;

export function noteStateKept(store: Bell, k: KeptFile): void {
  store.add({
    kind: "service",
    subject: `record:state-kept:${k.file}`,
    scope: "workspace/den-server",
    text: `A state file couldn't be read: ${k.file}. A copy is kept in backup/${k.saved}, and it started fresh`,
    msg: { key: "bell.m.stateKept", vars: { file: k.file, saved: k.saved } },
    link: "/settings",
  });
}

/**
 * Tell the bell of the notes not yet told, then of each file kept from now
 * on. Returns the way to stop listening.
 */
export function startStateKeptBell(
  stateDir: string,
  store: () => Bell,
): () => void {
  const tell = (notes: readonly KeptFile[]) => {
    if (!notes.length) return;
    try {
      const s = store();
      for (const k of notes) noteStateKept(s, k);
      markKeptTold(
        stateDir,
        notes.map((k) => k.saved),
      );
    } catch {
      /* the bell is best effort: the copy and doctor's row stay */
    }
  };
  tell(readKept(stateDir).filter((k) => !k.told));
  return onKept((k) => tell([k]));
}
