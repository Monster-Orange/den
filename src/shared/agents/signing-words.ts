/**
 * Issue 523: the words Den says when an agent's commit would sign with
 * someone else's key, in each language the UI ships (a test keeps the
 * three even, placeholders too). The bell's own lines are in the UI
 * catalogs (shell.js "bell.m.pinSigning*").
 *
 * Placeholders: {repo} the repo's folder, {settings} the git settings
 * that decided it, in git's own notation ("gpg.format=openpgp (global)"),
 * {fix} the line that gives the repo the agents' key, {title} the
 * product, {source} and {path} a clone's source and folder, {why} git's
 * own reason.
 */
import type { UiLanguage } from "../../ui/server/ui-language.js";

export type SigningWord =
  | "noKey"
  | "notAgentsKey"
  | "cloneSetFailed"
  | "cloneDetail"
  | "doctor.head"
  | "doctor.unsigned"
  | "doctor.thenSet"
  | "doctor.reposHead";

export const SIGNING_WORDS: Readonly<
  Record<UiLanguage, Readonly<Record<SigningWord, string>>>
> = {
  en: {
    noKey:
      "{repo}: signing is still on ({settings}) and there is no agents signing key, so the commit would be signed with someone else's key. Agents' commits stay unsigned until agents.git.signing_key is set.",
    notAgentsKey:
      "{repo}: its signing key isn't the agents' key ({settings}). An agent's commit is never signed with anyone else's key. Give the repo the agents' key: {fix}",
    cloneSetFailed:
      "Cloned {source} into {path}, but couldn't give it the agents' signing key: {why}",
    cloneDetail:
      "Its own git config gets the agents' signing key (gpg.format ssh), so commits there never use your key.",
    "doctor.head": "{title} doctor: agents' commit signing",
    "doctor.unsigned": "agent commits are unsigned; set an agents signing key",
    "doctor.thenSet":
      "then agents.git.signing_key: ~/.ssh/den_agents in config/local/user.yml",
    "doctor.reposHead":
      "{title} doctor: agent repos that don't sign with the agents' key",
  },
  es: {
    noKey:
      "{repo}: la firma sigue activada ({settings}) y no hay clave de firma de los agentes, así que el commit se firmaría con la clave de otra persona. Los commits de los agentes quedan sin firmar hasta que se configure agents.git.signing_key.",
    notAgentsKey:
      "{repo}: su clave de firma no es la de los agentes ({settings}). Un commit de un agente nunca se firma con la clave de otra persona. Dale al repo la clave de los agentes: {fix}",
    cloneSetFailed:
      "Se clonó {source} en {path}, pero no se le pudo dar la clave de firma de los agentes: {why}",
    cloneDetail:
      "Su propia configuración de git recibe la clave de firma de los agentes (gpg.format ssh), así que los commits ahí nunca usan tu clave.",
    "doctor.head": "{title} doctor: firma de los commits de los agentes",
    "doctor.unsigned":
      "los commits de los agentes no se firman; configura una clave de firma de los agentes",
    "doctor.thenSet":
      "después agents.git.signing_key: ~/.ssh/den_agents en config/local/user.yml",
    "doctor.reposHead":
      "{title} doctor: repos de agentes que no firman con la clave de los agentes",
  },
  ja: {
    noKey:
      "{repo}: 署名が有効のままです（{settings}）。エージェント用の署名鍵がないため、このコミットは他の人の鍵で署名されてしまいます。agents.git.signing_key を設定するまで、エージェントのコミットは署名なしのままです。",
    notAgentsKey:
      "{repo}: 署名鍵がエージェントの鍵ではありません（{settings}）。エージェントのコミットが他の人の鍵で署名されることはありません。リポジトリにエージェントの鍵を設定してください: {fix}",
    cloneSetFailed:
      "{source} を {path} にクローンしましたが、エージェントの署名鍵を設定できませんでした: {why}",
    cloneDetail:
      "このリポジトリ自身の git 設定にエージェントの署名鍵（gpg.format ssh）が入るため、ここでのコミットにあなたの鍵が使われることはありません。",
    "doctor.head": "{title} doctor: エージェントのコミット署名",
    "doctor.unsigned":
      "エージェントのコミットは署名されていません。エージェント用の署名鍵を設定してください",
    "doctor.thenSet":
      "その後 config/local/user.yml に agents.git.signing_key: ~/.ssh/den_agents を追加",
    "doctor.reposHead":
      "{title} doctor: エージェントの鍵で署名しないエージェントのリポジトリ",
  },
};

/** One line in `lang` (en when it lacks one), its placeholders filled. */
export function signingWord(
  lang: UiLanguage,
  key: SigningWord,
  vars: Record<string, string | number> = {},
): string {
  const s =
    (SIGNING_WORDS[lang] ?? SIGNING_WORDS.en)[key] ?? SIGNING_WORDS.en[key];
  return s.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in vars ? String(vars[k]) : m,
  );
}
