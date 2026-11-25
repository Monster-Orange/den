/**
 * Issue 1417: two agent limits' defaults, in a leaf module so den-config's
 * one lookup of a limit in force (limitInForce) and the code that uses
 * them read the same constant. Imports nothing.
 */

/** Issue 218: agents.lock_wait_minutes when unset. */
export const LOCK_WAIT_MINUTES_DEFAULT = 30;

/** D39: agents.turn_read_max_mb when unset, in bytes (8 MB). */
export const TURN_READ_MAX_BYTES = 8 * 1024 * 1024;
