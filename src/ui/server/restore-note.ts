/**
 * Issue 1225: the bell's item after a restart, once services.restore_on_boot
 * has run: how many services came back, and each one that didn't, with its
 * reason. One item (the same subject updates the unread one), in the
 * person's language through `msg`; `text` is the English.
 */
import type { NotificationStore } from "../../shared/notifications.js";
import {
  restoreSummary,
  type RestoreResult,
} from "../../shared/environment-manager/restore-on-boot.js";

export const RESTORE_NOTE_SUBJECT = "record:den-services-restored";

export function restoreNote(
  store: Pick<NotificationStore, "add">,
  r: Pick<RestoreResult, "brought" | "failedServices">,
): void {
  const s = restoreSummary(r);
  if (!s) return;
  const failed = r.failedServices
    .map((f) => `${f.address} (${f.why})`)
    .join(", ");
  const one = s.count === 1;
  const key = failed
    ? one
      ? "bell.m.serviceBackFailed"
      : "bell.m.servicesBackFailed"
    : one
      ? "bell.m.serviceBack"
      : "bell.m.servicesBack";
  store.add({
    kind: "service",
    subject: RESTORE_NOTE_SUBJECT,
    scope: "workspace/den-server",
    text: s.text,
    msg: {
      key,
      vars: failed ? { n: String(s.count), failed } : { n: String(s.count) },
    },
    link: "/services",
  });
}
