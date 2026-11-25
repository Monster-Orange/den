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
    }
  };
  tell(readKept(stateDir).filter((k) => !k.told));
  return onKept((k) => tell([k]));
}
