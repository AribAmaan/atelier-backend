// Relationship level shown on the chat screen's progress bar.
//
// This used to be computed entirely client-side, from `messages.length` of
// whatever the frontend currently had loaded, plus a flat +15 if the
// roleplay-preferences toggle *currently* had explicit mode on. Two
// problems with that: (1) `messages.length` was only ever as fresh as the
// last fetch/local update, and (2) the +15 was based on the toggle's
// present state, not history — so switching the toggle instantly (and
// retroactively) changed the level, and reloading on another device lost it
// entirely since nothing was ever persisted.
//
// Both inputs here now come straight from data Postgres/CockroachDB already
// has for other reasons — a message count and one boolean flag — so this
// costs a DB read, never an LLM call/token.
export function computeRelationshipLevel(totalMessages: number, explicitEverUsed: boolean): number {
  let level = Math.min(100, Math.floor((totalMessages / 50) * 100));
  if (explicitEverUsed) level = Math.min(100, level + 15);
  return level;
}
