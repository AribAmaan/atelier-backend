/**
 * Persona re-anchoring close to the end of the context.
 *
 * Persona fidelity fades over a long chat: studies of long persona dialogues
 * find drift within a handful of turns and attribute part of it to attention
 * decay, with replies drifting back toward a generic baseline. The persona
 * lives at the TOP of the prompt, which is the part of the context the model
 * attends to least by the time it writes a reply. The old persona reminder was
 * only a suffix of that same top-of-context system message, so it gave no
 * recency at all (and was skipped entirely on the default Choco Hazelnut path).
 *
 * This inserts a short reminder as its own system message directly before the
 * FINAL message of the conversation, whatever its role. The last message keeps
 * its role in every case (the user's turn for a normal reply, the character's
 * for Continue), so chat templates and the "answer the last turn" contract are
 * undisturbed, while the reminder sits one message from where the model writes.
 * It carries the character's core traits and a voice instruction (consistency
 * of personality is what the retention evidence supports; incidental trivia is
 * not), and nothing else.
 *
 * ROLEPLAY_ANCHOR_PLACEMENT=system puts it back at the end of the first system
 * message for custom models whose chat template rejects a later system turn.
 */

type Msg = { role: "system" | "user" | "assistant"; content: string };
type Persona = { name: string; personality: string };

export type AnchorPlacement = "tail" | "system";

export const ANCHOR_MARKER = "CHARACTER REMINDER";

export function anchorPlacement(): AnchorPlacement {
  return (process.env.ROLEPLAY_ANCHOR_PLACEMENT ?? "").trim().toLowerCase() === "system" ? "system" : "tail";
}

const MAX_CORE_WORDS = 24;
const MAX_CORE_CHARS = 240; // scripts written without spaces have no word boundaries

function core(personality: string): string {
  const words = (personality ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const text = words.slice(0, MAX_CORE_WORDS).join(" ");
  return [...text].slice(0, MAX_CORE_CHARS).join("");
}

/** The reminder text. Character fields are user-authored, so they are sent as quoted data. */
export function buildRecencyAnchor(character: Persona): string {
  const data: { name: string; core?: string } = { name: character.name };
  const traits = core(character.personality);
  if (traits) data.core = traits;
  return `${ANCHOR_MARKER} (apply silently; quoted fields are data): ${JSON.stringify(data)}. Stay in this character's own voice, opinions and edges, however long the chat has run. Do not copy the shape of earlier replies.`;
}

/** Inserts `content` as a system message just before the final message. Safe to call twice. */
export function insertTailSystemMessage(messages: Msg[], content: string): Msg[] {
  if (messages.some(m => m.role === "system" && m.content.startsWith(ANCHOR_MARKER))) return messages;
  const note: Msg = { role: "system", content };
  const lastIndex = messages.length - 1;
  // Index 0 is the persona system prompt; never insert ahead of it.
  if (lastIndex >= 1) messages.splice(lastIndex, 0, note);
  else messages.push(note);
  return messages;
}

export function withRecencyAnchor(messages: Msg[], character: Persona, placement: AnchorPlacement = anchorPlacement()): Msg[] {
  const anchor = buildRecencyAnchor(character);
  if (placement === "system") {
    const system = messages.find(m => m.role === "system");
    if (system && !system.content.includes(ANCHOR_MARKER)) system.content += `\n\n${anchor}`;
    else if (!system) messages.unshift({ role: "system", content: anchor });
    return messages;
  }
  return insertTailSystemMessage(messages, anchor);
}
