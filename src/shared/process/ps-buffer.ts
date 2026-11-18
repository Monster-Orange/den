/**
 * den#143: how much `ps` output a synchronous read keeps. A whole-machine
 * list with commands (`ps -A -o …,command=`) passes Node's default 1 MiB on
 * a busy machine (1.07 MB with 1,582 processes on a build machine): past it
 * the read fails with ENOBUFS, and what came before is all a caller sees.
 * 32 MiB is far above any process table seen, and only ever held briefly.
 */
export const PS_MAX_BUFFER = 32 * 1024 * 1024;
