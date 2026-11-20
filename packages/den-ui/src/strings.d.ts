/** The kit's words: every key starts `kit.`; en, es and ja hold the same keys. */
export type Words = Record<string, string>;
export declare const en: Words;
export declare const es: Words;
export declare const ja: Words;
export declare const STRINGS: { en: Words; es: Words; ja: Words };
/** The name `{product}` fills in. */
export declare function setProduct(name: string): void;
/** A product's own words, or its versions of the kit's, for a language. */
export declare function addStrings(lang: string, table: Words): void;
/** The word for `key` in `lang` (else en, else the key), vars filled in. */
export declare function kitT(
  lang: string | undefined,
  key: string,
  vars?: Record<string, string | number>,
): string;
/** HTML-escaped text. */
export declare function esc(v: unknown): string;
/** A shared verb's name: "kit.verb.<name>" in every table. */
export type Verb = "save" | "cancel" | "delete" | "close" | "retry";
/** The shared verbs: Save, Cancel, Delete, Close, Try again. */
export declare const VERBS: readonly Verb[];
/** A shared verb in `lang` (else en). */
export declare function kitVerb(lang: string | undefined, verb: Verb): string;
/** A host's words: its own text, or { key, vars } in the kit's tables. */
export type HostWords =
  | string
  | { key: string; vars?: Record<string, string | number> };
/** A host's words in `lang` ("" for null). */
export declare function hostWords(
  w: HostWords | null | undefined,
  lang?: string,
): string;
