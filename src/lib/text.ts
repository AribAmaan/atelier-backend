/**
 * Length-limits a string without splitting a surrogate pair or a multi-part
 * emoji. String.prototype.slice counts UTF-16 code units, so slicing at a
 * field limit can leave a lone surrogate, which MySQL's utf8mb4 rejects.
 * Uses grapheme clusters when available (keeps ZWJ emoji sequences whole),
 * otherwise falls back to code points.
 */
const segmenter: { segment(input: string): Iterable<{ segment: string }> } | null =
  typeof (Intl as any).Segmenter === "function"
    ? new (Intl as any).Segmenter(undefined, { granularity: "grapheme" })
    : null;

export function truncateGraphemes(value: string, max: number): string {
  if (value.length <= max) {
    // Fast path: even the UTF-16 length fits, so no unit count can exceed it.
    // (Grapheme count <= code unit count.)
    return value;
  }
  const units = segmenter ? Array.from(segmenter.segment(value), s => s.segment) : Array.from(value);
  return units.slice(0, max).join("");
}

/**
 * Truncates so the result is at most `max` UTF-16 code units (the unit most
 * VARCHAR limits in this schema are validated against upstream) but never
 * ends mid-character.
 */
export function truncateUnits(value: string, max: number): string {
  if (value.length <= max) return value;
  let out = value.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1); // dangling high surrogate
  return out;
}

/** Strips unpaired surrogates, which MySQL utf8mb4 refuses to store. */
export function stripLoneSurrogates(value: string): string {
  return value.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
}
