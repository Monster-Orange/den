/** Issue 177: what Report from a failure pop-up starts with. */
export declare function failureReport(o: {
  lang?: string;
  failure?: string;
  err?: unknown;
  id?: string;
  at?: Date;
  words?: Record<string, Record<string, string>>;
}): { title: string; description: string; requestId: string; route: string };
