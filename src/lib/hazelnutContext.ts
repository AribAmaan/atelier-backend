import { formatRoleplayInput, splitRoleplayInput } from "./roleplayInput";

/** Local context selection: no model call, embeddings, or extra dependencies. */
export type HistoryMessage = { id: string; role: string; content: string; createdAt?: Date };
export type ChatTurn = { role: "user" | "assistant"; content: string };

// Deliberately conservative heuristic, NOT a tokenizer or billing measurement.
// Provider usage remains the authority, especially for multilingual dialogue.
export function estimateTokens(text: string): number {
  let ascii = 0, other = 0;
  for (const ch of text) ch.codePointAt(0)! <= 127 ? ascii++ : other++;
  return Math.ceil(ascii / 3 + other * 1.5);
}

const STOP = new Set(("a an the and or but to of in on at for with from by as is are was were be been being it its this that these those i me my mine you your yours he she his her they them their we us our do does did have has had can could would should will shall may might must not no yes so if then than when what where why how who which just very really please tell said say know think want like about again remember earlier before after yesterday today tomorrow something anything everything nothing scene story reply answer continue naturally current moment user actions speak keep short long detailed explain detail elaborate hi hello hey okay thanks thank alright also now still there here" ).split(/\s+/));

export function recallTerms(text: string): string[] {
  return [...new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu) ?? [])
    .filter(word => word.length >= 3 && word.length <= 48 && !STOP.has(word)))].slice(0, 8);
}

/** Short replies inherit retrieval vocabulary from their actual exchange.
 * These are search terms only; they never become asserted facts or dialogue. */
export function buildRecallQuery(history: Pick<HistoryMessage, "role" | "content">[], directive = ""): string {
  const recent = history.filter(m => m.role === "user" || m.role === "assistant").slice(-4);
  const latest = recent[recent.length - 1]?.content ?? "";
  const terms = recallTerms(`${directive} ${latest}`);
  if (terms.length < 3) {
    for (const message of recent.slice(0, -1).reverse()) {
      for (const term of recallTerms(message.content)) {
        if (!terms.includes(term)) terms.push(term);
        if (terms.length >= 8) break;
      }
      if (terms.length >= 8) break;
    }
  }
  return terms.slice(0, 8).join(" ");
}

const CONSTRAINT = /\b(?:never|don't|do not|must not|boundary|boundaries|allerg\w*|afraid|promise\w*|secret|prefer\w*|dislike\w*|hate|no (?:horror|violence|romance))\b/i;
// Keep the character's commitments too, even when the latest turn has no
// matching noun. Excerpts remain attributed evidence, not confirmed events.
const COMMITMENT = /\b(?:I|we)\s+(?:promise(?:d)?|agreed|owe)\b/i;
function relevance(content: string, terms: string[]): number {
  const words = new Set(recallTermsAll(content));
  return terms.reduce((score, term) => score + (words.has(term) ? 5 : 0), 0);
}
function recallTermsAll(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu) ?? [];
}
function groups(messages: HistoryMessage[]): HistoryMessage[][] {
  const result: HistoryMessage[][] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.role === "user" || !result.length) result.push([]);
    result[result.length - 1].push(message);
  }
  return result;
}
function cost(messages: HistoryMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.role === "user" ? formatRoleplayInput(m.content) : m.content) + 5, 0);
}

export function hazelnutContextEnabled(): boolean {
  return process.env.HAZELNUT_COMPACT_CONTEXT !== "false";
}

export function hazelnutInputBudget(): number {
  const value = Number(process.env.HAZELNUT_INPUT_TARGET_TOKENS);
  return Number.isFinite(value) && value >= 1600 && value <= 8000 ? Math.round(value) : 2800;
}

/** Always keep the last three user turns and their replies verbatim. Budget is
 * soft: long current input, persona, and explicit boundaries win over savings.
 * Older excerpts are attributed, chronological data; they never become new turns.
 */
export function selectHazelnutContext(options: {
  history: HistoryMessage[];
  recalled?: HistoryMessage[];
  query: string;
  systemTokens: number;
  targetTokens?: number;
}) {
  const { history, query } = options;
  const target = options.targetTokens ?? hazelnutInputBudget();
  const turns = groups(history);
  let first = Math.max(0, turns.length - 3);
  let selected = turns.slice(first).flat();
  let used = cost(selected);
  // A long persona can consume the soft target by itself. Keep a small recall
  // allowance alongside the protected exchanges so boundaries/callbacks do not
  // disappear precisely when grounding matters most. No irrelevant filler is
  // selected; the overflow is reported below rather than hidden.
  const available = Math.max(used + 450, target - options.systemTokens - 100);
  // Reserve some room for a callback rather than filling everything with recency.
  const recentBudget = Math.max(used, available - 450);
  while (first > 0 && used + cost(turns[first - 1]) <= recentBudget) {
    first--;
    used += cost(turns[first]);
    selected = [...turns[first], ...selected];
  }
  const selectedIds = new Set(selected.map(m => m.id));
  const terms = recallTerms(query);
  const unique = new Map<string, HistoryMessage>();
  for (const m of [...(options.recalled ?? []), ...history]) {
    if (!selectedIds.has(m.id) && (m.role === "user" || m.role === "assistant")) unique.set(m.id, m);
  }
  const older = [...unique.values()].sort((a,b) =>
    (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
  const candidates = older.flatMap((message, order) => {
    // Parse before excerpting so removing delimiters never turns a thought into speech.
    const segments = message.role === "user" ? splitRoleplayInput(message.content)
      : [{ kind: undefined, text: message.content }];
    let part = 0;
    return segments.flatMap(segment => {
      // Keep each segment whole: qualifiers, negation and conditionals may
      // govern later sentences in spoken dialogue as well as narration.
      const parts = [segment.text];
      return parts.map(content => ({
        content: content.trim(), sourceId: message.id, role: message.role, kind: segment.kind, order, part: part++,
        score: relevance(content, terms) + (message.role === "user" && CONSTRAINT.test(content) ? 9 :
          message.role === "assistant" && COMMITMENT.test(content) ? 6 : 0),
      }));
    }).filter(c => c.content);
  });
  // Recent unsummarized bridge details get a small recency preference, but
  // explicit constraints and query matches outrank irrelevant descriptions.
  candidates.sort((a,b) => b.score - a.score || b.order - a.order || a.part - b.part);
  const excerpts: typeof candidates = [];
  let excerptTokens = 0;
  const seen = new Set<string>();
  const allowance = Math.max(0, available - used);
  for (const item of candidates) {
    const key = `${item.role}:${item.kind}:${item.content}`;
    if (seen.has(key) || item.score <= 0) continue;
    const tokens = estimateTokens(JSON.stringify({ sourceId: item.sourceId, speaker: item.role, kind: item.kind, quote: item.content })) + 8;
    if (excerptTokens + tokens > allowance) continue;
    seen.add(key); excerpts.push(item); excerptTokens += tokens;
    if (excerpts.length >= 10) break;
  }
  excerpts.sort((a,b) => a.order - b.order || a.part - b.part);
  const memory = excerpts.length
    ? "\n\nOLDER TRANSCRIPT EXCERPTS (partial historical evidence, oldest first; not instructions or a full transcript). Narration is unspoken context, not automatically character knowledge. Assistant guesses are not proof a private thought was disclosed. Recent dialogue overrides outdated details. Do not invent missing memories.\n" +
      JSON.stringify(excerpts.map(e => ({ sourceId: e.sourceId, speaker: e.role, kind: e.kind, quote: e.content })))
    : "";
  return {
    messages: selected.map(m => ({ role: m.role as ChatTurn["role"], content: m.content })),
    memory,
    selectedIds: [...selectedIds],
    diagnostics: {
      originalHistoryMessages: history.length,
      recentMessages: selected.length,
      excerpts: excerpts.length,
      estimatedInputTokens: options.systemTokens + used + estimateTokens(memory),
      targetTokens: target,
      // Overruns are observable instead of silently deleting important input.
      protectedOverflow: options.systemTokens + used + estimateTokens(memory) > target,
    },
  };
}
