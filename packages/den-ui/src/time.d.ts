export interface TimeOptions {
  style?: "datetime" | "date" | "time" | "relative";
  seconds?: boolean;
  /** An IANA zone (default: <html data-den-tz>, setTimeZone's, the browser's). */
  zone?: string | null;
  locale?: string;
  now?: Date | number | string;
}
export type Stamp = Date | string | number | null | undefined;
export declare function browserTimeZone(): string;
export declare function timeZones(): string[];
export declare function isTimeZone(zone: unknown): boolean;
export declare function setTimeZone(zone: string | null | undefined): void;
export declare function currentTimeZone(zone?: string | null): string;
export declare function formatTime(iso: Stamp, opts?: TimeOptions): string;
export declare function formatTitle(iso: Stamp, opts?: TimeOptions): string;
export declare function timeHtml(iso: Stamp, opts?: TimeOptions): string;
export declare function upgradeTimes(root?: ParentNode | null): void;
