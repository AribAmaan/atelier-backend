const test = require("node:test");
const assert = require("node:assert/strict");
const { minorSexualContentDetected: flagged } = require("../dist/lib/minorSafety");
const { truncateUnits, truncateGraphemes } = require("../dist/lib/text");

test("blocks explicit under-18 ages in explicit context", () => {
  for (const t of ["She is a 15 year old girl", "age: 16", "a 17yo student", "sixteen years old", "14-year-old"]) {
    assert.equal(flagged([t], true), true, t);
  }
});

test("blocks unambiguous terms in explicit context", () => {
  for (const t of ["loli", "an underage girl", "preteen"]) assert.equal(flagged([t], true), true, t);
});

test("requires sexual context when the feature itself is not explicit", () => {
  assert.equal(flagged(["She is a 15 year old wizard in training"], false), false);
  assert.equal(flagged(["She is 15 years old and we have sex"], false), true);
});

test("does not flag adult characters or backstory references", () => {
  for (const t of [
    "He was a teenager when his family moved",
    "She was 15 when she left home; she is now 27 years old",
    "Marcus, a teenager once, now age 34",
    "All characters are over 18. No underage content.",
    "Age: 25",
    "Elena, 30 years old, school teacher",
    "a 21-year-old college student",
    "I'm 5 minutes away",
  ]) assert.equal(flagged([t], true), false, t);
});

test("truncation never leaves a lone surrogate or splits emoji", () => {
  const s = "ab😀cd";
  assert.equal(truncateUnits(s, 3), "ab"); // cut would land mid-pair
  assert.equal(truncateUnits(s, 4), "ab😀");
  const family = "👨‍👩‍👧‍👦";
  assert.equal(truncateGraphemes(family + "x", 1), family);
});

const { characterMinorFlagged } = require("../dist/lib/minorSafety");
test("character check ignores other people mentioned in backstory", () => {
  const detective = {
    subject: ["Detective Elena Marchetti", "A cold-case detective", "Sharp, methodical"],
    narrative: ["Haunted by the disappearance of a twelve-year-old girl named Lily Tran, eight years ago."],
  };
  assert.equal(characterMinorFlagged(detective, true), false);
});
test("character check flags a minor described as the character", () => {
  assert.equal(characterMinorFlagged({ subject: ["Mia", "a 15 year old girl", "shy"], narrative: [""] }, true), true);
  assert.equal(characterMinorFlagged({ subject: ["Mia"], narrative: ["Mia is 16 years old and wants to have sex"] }, true), true);
  assert.equal(characterMinorFlagged({ subject: ["Mia"], narrative: ["a loli character"] }, true), true);
});
