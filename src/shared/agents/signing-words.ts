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

/** A language these words come in (the CLI names it without a server import). */
export type SigningLanguage = UiLanguage;

export type SigningWord =
  | "noKey"
  | "notAgentsKey"
  | "cloneSetFailed"
  | "doctor.head"
  | "doctor.unsigned"
  | "doctor.thenSet"
  | "doctor.reposHead"
  | "doctor.repoMain"
  | "doctor.repoNote";

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
    "doctor.head": "{title} doctor: agents' commit signing",
    "doctor.unsigned": "agent commits are unsigned; set an agents signing key",
    "doctor.thenSet":
      "then agents.git.signing_key: ~/.ssh/den_agents in config/local/user.yml",
    "doctor.reposHead":
      "{title} doctor: agent repos that don't sign with the agents' key",
    "doctor.repoMain":
      "{repo}: commits there sign with a key that isn't the agents' key ({settings}). It's the repo's main checkout, so Den leaves its config alone: give the agents a worktree of their own (git worktree add).",
    "doctor.repoNote":
      "{repo}: its own config doesn't name the agents' key ({settings}), but it signs nothing, so no commit there signs with another key. Agents sign there with the agents' key, which Den sets for each agent.",
  },
  es: {
    noKey:
      "{repo}: la firma sigue activada ({settings}) y no hay clave de firma de los agentes, así que el commit se firmaría con la clave de otra persona. Los commits de los agentes quedan sin firmar hasta que se configure agents.git.signing_key.",
    notAgentsKey:
      "{repo}: su clave de firma no es la de los agentes ({settings}). Un commit de un agente nunca se firma con la clave de otra persona. Dale al repo la clave de los agentes: {fix}",
    cloneSetFailed:
      "Se clonó {source} en {path}, pero no se le pudo dar la clave de firma de los agentes: {why}",
    "doctor.head": "{title} doctor: firma de los commits de los agentes",
    "doctor.unsigned":
      "los commits de los agentes no se firman; configura una clave de firma de los agentes",
    "doctor.thenSet":
      "después agents.git.signing_key: ~/.ssh/den_agents en config/local/user.yml",
    "doctor.reposHead":
      "{title} doctor: repos de agentes que no firman con la clave de los agentes",
    "doctor.repoMain":
      "{repo}: los commits ahí se firman con una clave que no es la de los agentes ({settings}). Es la copia principal del repo, así que Den no cambia su configuración: dale a los agentes su propio worktree (git worktree add).",
    "doctor.repoNote":
      "{repo}: su configuración no indica la clave de los agentes ({settings}), pero no firma nada, así que ningún commit ahí se firma con otra clave. Los agentes firman ahí con la clave de los agentes, que Den configura para cada agente.",
  },
  ja: {
    noKey:
      "{repo}: 署名が有効のままです（{settings}）。エージェント用の署名鍵がないため、このコミットは他の人の鍵で署名されてしまいます。agents.git.signing_key を設定するまで、エージェントのコミットは署名なしのままです。",
    notAgentsKey:
      "{repo}: 署名鍵がエージェントの鍵ではありません（{settings}）。エージェントのコミットが他の人の鍵で署名されることはありません。リポジトリにエージェントの鍵を設定してください: {fix}",
    cloneSetFailed:
      "{source} を {path} にクローンしましたが、エージェントの署名鍵を設定できませんでした: {why}",
    "doctor.head": "{title} doctor: エージェントのコミット署名",
    "doctor.unsigned":
      "エージェントのコミットは署名されていません。エージェント用の署名鍵を設定してください",
    "doctor.thenSet":
      "その後 config/local/user.yml に agents.git.signing_key: ~/.ssh/den_agents を追加",
    "doctor.reposHead":
      "{title} doctor: エージェントの鍵で署名しないエージェントのリポジトリ",
    "doctor.repoMain":
      "{repo}: ここでのコミットはエージェントの鍵ではない鍵で署名されます（{settings}）。リポジトリのメインのチェックアウトなので、Den はその設定を変更しません。エージェント専用の worktree を作成してください（git worktree add）。",
    "doctor.repoNote":
      "{repo}: 自身の設定にエージェントの鍵が指定されていません（{settings}）が、何も署名しないため、ここで他の鍵で署名されるコミットはありません。エージェントは Den がエージェントごとに設定するエージェントの鍵で署名します。",
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
