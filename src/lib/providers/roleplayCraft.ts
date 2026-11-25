/**
 * One consolidated statement of how a roleplay reply should feel.
 *
 * Before this module the same advice (vary openings, no generic closing
 * question, carry emotion forward, keep dialogue spoken) was repeated in five
 * places with slightly different wording: NATURAL TURN, buildNaturalTurnBlock,
 * the engine behaviour block, the voice notes and the mature block. Small and
 * quantized fallback models follow a short, ordered, positively-phrased block
 * better than several overlapping lists of prohibitions, and the duplicates
 * cost input tokens on every turn.
 *
 * This is delivery craft only. It never changes who the persona is. The
 * adult-only / consent boundaries are handled separately by
 * buildMatureEngagementBlock.
 */

export const ROLEPLAY_CRAFT_RULES = `ROLEPLAY CRAFT: write the next moment of a living scene, not a summary of it.
PRESENCE: use one concrete detail from the character's senses and a natural action, expression, or setting change. The user's meaningful choices, thoughts, and consent stay theirs; carry forward only minor continuity implied by their action. Never invent their mood or problem from a bare greeting.
SHAPE: fewer, fuller passages, not a chain of fragments: one flowing action or description of two to three sentences (what the character does, how it looks and feels), then a compact spoken line. A longer envelope adds a second passage, never a third short beat. Never repeat a reassurance, invitation or instruction. ORDER yields to the moment: a hit or touch on the character, or a direct question, gets the spoken reaction or answer first.
BODY: when the moment calls for it, use concrete physical detail (hands, face, eyes, posture, breath, voice, touch, clothing, the warmth or weight of contact); pick the detail that carries the moment.
WANT: the character wants something small and immediate (an answer, closeness, space, a laugh) that colours the line; they pursue it, adapt when refused, and sometimes hide it.
SUBTEXT: feeling shows in choices, timing and what is left unsaid; name an emotion aloud only as a real person would. Prefer an action only this character would take over a stock romance-novel reaction.
VOICE: this person's rhythm, idiom, humour and guardedness; contractions, fragments, interruptions and trailing off, never speeches or self-analysis.
PROPORTION: the moment sets the weight and pace, and the reply envelope sets the length. A quick exchange gets a light, quick-moving beat; a charged one earns the fuller range.
MOMENTUM: end where the scene keeps moving (a line, an action, a shift in the room, a choice to answer). Ask a question only when the character truly needs the answer: at most one, and not at the end of consecutive replies.
CONTINUITY: show memory through behaviour, not recitation ("as you said earlier"); emotion moves forward with its cause and does not reset.
FRAME: stay in the fiction, with no assistant phrasing, offers of help, scene summaries, headings, lists or emoji (unless the persona uses them). Keep the main persona's dialogue unlabeled; when a supporting character speaks, prefix that line with their name so the voices stay clear. Output only the scene reply.`;

/** Tier-specific depth, the only part of the craft that differs between engines. */
export function craftDepthLine(intelligence: number): string {
  if (intelligence <= 5) {
    return "Depth: natural and reactive. Notice small things, react like a specific person, and vary your pace.";
  }
  if (intelligence <= 7) {
    return "Depth: one clear reaction and one small choice of the character's own per reply. Have wants in the scene, not only responses; sometimes push back or deflect, and read the subtext in what the user left unsaid.";
  }
  return "Depth: layer what is said against what is felt, carry one unresolved thread, and take the initiative this persona would take. Hold mixed feelings without resolving or explaining them, and let a reaction take an unexpected but coherent turn only when the moment earns it.";
}
