/**
 * Journeys resource ledger — descriptor-based tracking of resources a
 * journey creates, so the caller-orchestrated teardown can delete exactly
 * what was created (and nothing it merely guesses at).
 *
 * Two feeds share this module: the scoped HTTP tool records its own calls
 * directly, and the browser toolset's network-interception feed (next
 * packet) reuses the same pure `matchResourceCreation` matcher.
 *
 * Data-minimization contract: ledger entries and warnings retain ONLY
 * {method, sanitized path (query/fragment/origin stripped), status,
 * extracted descriptor id, source tag}. Bodies are inspected transiently
 * for id extraction and discarded; headers, cookies, and credential
 * material never enter this module's stored state.
 */

/** Feed that produced a ledger record. */
export type LedgerSource = "http-tool" | "browser";

/** HTTP methods the matcher distinguishes. */
export type HttpMethod =
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

const MUTATING_METHODS: ReadonlySet<HttpMethod> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** Explicit cleanup request bound to a recorded resource. */
export interface CleanupRequest {
  method: HttpMethod;
  path: string;
}

/**
 * An observed API call, as seen by either feed. `body` is the parsed
 * response body; it is read transiently for id extraction and never stored.
 */
export interface ObservedCall {
  method: HttpMethod;
  /** Raw path or absolute URL; sanitized before matching/storage. */
  pathOrUrl: string;
  status: number;
  /** Parsed response body (transient — id extraction only). */
  body?: unknown;
}

/**
 * Registry entry describing one recognized resource-creating endpoint and
 * how to clean the resource up afterwards.
 */
export interface ResourceDescriptor {
  resourceType: string;
  creation: {
    method: HttpMethod;
    /** Matched against the sanitized path (origin + query stripped). */
    pathPattern: RegExp;
  };
  /** Extract the created resource's id from the observed call. */
  extractId: (call: ObservedCall) => string | undefined;
  /** Build the exact cleanup request for a created resource. */
  cleanup: (id: string) => CleanupRequest;
}

/**
 * Registry the matcher runs against: recognized creations plus known
 * action-POST patterns (RPC-style endpoints that mutate nothing we must
 * track — never recorded as resources NOR as unmanaged warnings).
 */
export interface LedgerRegistry {
  descriptors: ResourceDescriptor[];
  actionPatterns: RegExp[];
}

/** Result of matching one observed call against the registry. */
export type ResourceMatch =
  | {
      kind: "resource";
      resourceType: string;
      id: string;
      cleanup: CleanupRequest;
    }
  | { kind: "unmanaged-mutation" }
  | { kind: "ignored" };

/** A recorded, cleanup-bound resource creation (data-minimized). */
export interface LedgerEntry {
  resourceType: string;
  id: string;
  method: HttpMethod;
  path: string;
  status: number;
  source: LedgerSource;
  cleanup: CleanupRequest;
}

/**
 * A successful mutation on an endpoint with no registered descriptor —
 * reported for humans to review, never guessed-deleted (data-minimized).
 */
export interface UnmanagedMutationWarning {
  method: HttpMethod;
  path: string;
  status: number;
  source: LedgerSource;
}

/**
 * Strip origin, query string, and fragment from a path or absolute URL so
 * matching and storage only ever see the bare path (data minimization:
 * query strings can carry tokens).
 */
export function sanitizePath(pathOrUrl: string): string {
  // Absolute URLs parse directly; bare paths get a placeholder origin.
  const url = new URL(pathOrUrl, "http://placeholder.invalid");
  return url.pathname;
}

/**
 * The registry comes from the app under test (`journeys.app.resources` and
 * `journeys.app.actions` in the spec-hosting repo's manifest): see
 * ledgerRegistryFromApp in ../app-config.ts. The engine ships none of its
 * own; this empty registry reports every successful mutation as unmanaged.
 */
export function emptyLedgerRegistry(): LedgerRegistry {
  return { descriptors: [], actionPatterns: [] };
}

/**
 * Pure matcher shared by both feeds (HTTP tool now, browser network
 * interception in the next packet). Rules:
 * - non-mutating methods and non-2xx responses are ignored;
 * - known action POSTs are ignored (proven-by-test never recorded);
 * - a registered creation with an extractable id becomes a resource match
 *   carrying the descriptor's exact cleanup request;
 * - any other successful mutation — including a registered creation whose
 *   id cannot be extracted — is an unmanaged mutation (reported, never
 *   guessed-deleted).
 */
export function matchResourceCreation(
  registry: LedgerRegistry,
  call: ObservedCall,
): ResourceMatch {
  if (!MUTATING_METHODS.has(call.method)) {
    return { kind: "ignored" };
  }
  if (call.status < 200 || call.status >= 300) {
    return { kind: "ignored" };
  }

  const path = sanitizePath(call.pathOrUrl);

  if (registry.actionPatterns.some((pattern) => pattern.test(path))) {
    return { kind: "ignored" };
  }

  for (const descriptor of registry.descriptors) {
    if (
      descriptor.creation.method === call.method &&
      descriptor.creation.pathPattern.test(path)
    ) {
      const id = descriptor.extractId(call);
      if (id === undefined) {
        // Recognized creation but no id — cleanup is impossible, so this
        // degrades to a reported warning instead of a guessed delete.
        return { kind: "unmanaged-mutation" };
      }
      return {
        kind: "resource",
        resourceType: descriptor.resourceType,
        id,
        cleanup: descriptor.cleanup(id),
      };
    }
  }

  return { kind: "unmanaged-mutation" };
}

/**
 * Observer notified the instant the ledger recognizes a resource creation,
 * an unmanaged mutation, or an interception failure — the observability
 * event bus subscribes here so bindings (the `{item_id}` question) surface
 * on the live stream and in events.jsonl, not just in the teardown section.
 * Data-minimized by construction: only the already-sanitized record fields
 * cross this boundary (no bodies/headers).
 */
export interface LedgerObserver {
  onResource?(entry: LedgerEntry): void;
  onUnmanagedMutation?(warning: UnmanagedMutationWarning): void;
  onInterceptionError?(message: string): void;
}

/**
 * Multi-feed run ledger. Records recognized resource creations with their
 * cleanup descriptors and collects unmanaged-mutation warnings; consumed by
 * the caller-orchestrated teardown executor (jrn-runner packet).
 */
export class RunLedger {
  private readonly registry: LedgerRegistry;
  private readonly recordedEntries: LedgerEntry[] = [];
  private readonly recordedWarnings: UnmanagedMutationWarning[] = [];
  private readonly recordedInterceptionErrors: string[] = [];
  private readonly observer?: LedgerObserver;

  constructor(registry: LedgerRegistry, observer?: LedgerObserver) {
    this.registry = registry;
    this.observer = observer;
  }

  /** Recorded resource creations, in creation order. */
  get entries(): readonly LedgerEntry[] {
    return this.recordedEntries;
  }

  /** Unmanaged-mutation warnings, in observation order. */
  get warnings(): readonly UnmanagedMutationWarning[] {
    return this.recordedWarnings;
  }

  /**
   * Interception-processing failures (review finding 7): a failed
   * response handler means a creation MAY have gone unrecorded, so the
   * failure is reported loudly instead of being swallowed.
   */
  get interceptionErrors(): readonly string[] {
    return this.recordedInterceptionErrors;
  }

  /** Record one interception-processing failure (message only — no bodies). */
  recordInterceptionError(message: string): void {
    this.recordedInterceptionErrors.push(message);
    this.observer?.onInterceptionError?.(message);
  }

  /**
   * Feed one observed call into the ledger. The call's body is only passed
   * through the matcher for id extraction; stored records are minimized to
   * method + sanitized path + status + id + source.
   */
  record(call: ObservedCall, source: LedgerSource): ResourceMatch {
    const match = matchResourceCreation(this.registry, call);
    const path = sanitizePath(call.pathOrUrl);

    if (match.kind === "resource") {
      const entry: LedgerEntry = {
        resourceType: match.resourceType,
        id: match.id,
        method: call.method,
        path,
        status: call.status,
        source,
        cleanup: match.cleanup,
      };
      this.recordedEntries.push(entry);
      this.observer?.onResource?.(entry);
    } else if (match.kind === "unmanaged-mutation") {
      const warning: UnmanagedMutationWarning = {
        method: call.method,
        path,
        status: call.status,
        source,
      };
      this.recordedWarnings.push(warning);
      this.observer?.onUnmanagedMutation?.(warning);
    }

    return match;
  }
}
