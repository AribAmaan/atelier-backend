# Model prompts and reply processing: enhancement and debugging

Date: 26 September 2026

Base: `RoliChat-Backend-Reliability-Debugged.zip`. This package retains that release's backend fixes and updates four source files: `src/lib/providers/index.ts`, `src/lib/providers/replyPolicy.ts`, `src/lib/providers/completeReply.ts`, and `src/routes/chat.ts`.

## Conversational improvements

The generic conversation instructions now emphasize answering the actual question before adding a useful choice or action, keeping independent preferences, and giving a reason for agreement, disagreement, praise, or uncertainty. Characters should carry emotions and their causes forward, acknowledge missing information, honor corrections, and follow through on unresolved details. They should avoid automatic compliance, hostility, repetitive gestures, filler, and generic questions that merely hand the turn back.

These instructions replace longer generic coaching. They apply to Hazelnut's compact and rollback paths, with shared guidance for the other tiers. Character data, authored voice notes, perception rules, and content-boundary instructions are preserved. Prompt cache revisions were updated.

## Fixed bugs

1. Premium streams could display part of a sentence that the final word cap then removed. All capped tiers now use the same sentence boundaries for streaming and final clipping. Unfinished sentences and open formatting spans are buffered, so text may arrive in sentence-sized batches.
2. A depth continuation ending at a token limit could be incorrectly labeled complete merely because it reached the minimum word count. Its incomplete status is now retained.
3. Clipping could turn a filtered completion into a normal stop. Filtered and unknown ending statuses are now preserved rather than triggering additional completion attempts.
4. Depth continuations were omitted from the continuation counter and could follow two cutoff-recovery calls. All continuation calls now count toward one two-call maximum within a provider attempt. Existing provider failover remains separate.
5. A short repeated closing sentence could be duplicated when joining a depth continuation. Exact, meaningful overlaps are now removed even when shorter than 24 characters.
6. Sentence clipping did not recognize Hindi danda punctuation and could mistake titles such as `Dr.` for finished sentences. Shared boundary detection handles these cases.
7. Hard clipping could leave an unmatched action marker or quote. It now closes paired formatting when it must clip a long span. Leading whitespace and split punctuation chunks also receive consistent handling.

## Unchanged numeric budgets

| Engine | Target words | Word band | Initial output-token limit | Per-continuation limit |
| --- | ---: | ---: | ---: | ---: |
| Vanilla | 35 | 25–45 | 128 | 96 |
| Strawberry | 60 | 50–70 | 144 | 128 |
| Chocolate | 100 | 85–110 | 224 | 160 |
| Hazelnut | 120 | 105–130 | 256 | 160 |

Depth continuations may use less than their listed limit. Word counts use the existing whitespace-based method. The upper word limit is enforced locally; the lower band is a target, not a guarantee during interruptions or provider failures. Engine sampling settings, provider order, memory policy, and the 2,800-token soft Hazelnut input target are unchanged.

## Input overhead comparison

The app's own estimator measured the same neutral bookseller fixture before and after, including voice notes and reply guidance:

| Engine/path | Before | After | Difference |
| --- | ---: | ---: | ---: |
| Vanilla | 2,340 | 1,929 | −411 |
| Strawberry | 2,343 | 1,930 | −413 |
| Chocolate | 2,565 | 2,153 | −412 |
| Hazelnut compact | 1,950 | 1,848 | −102 |

All 16 combinations of tier, context-path setting, and content-mode setting stayed below their previous estimated prompt size. This measures prompt overhead, not billed tokens. Freed context space may hold more relevant history within the unchanged soft budget. No additional evaluation or judging model call was added.

## Verification and limits

- TypeScript build passed.
- All **120 regression tests passed**, with zero skipped tests.
- Seven targeted reply-processing tests failed on the previous implementation and passed after the fixes. Additional checks cover continuation statuses, streaming chunks, and exact numeric budget invariants.
- An existing compact-prompt test was updated because compressing the rollback prompt too made its old relative-savings ratio obsolete. It now checks that compact remains cheaper and stays under a fixed fixture budget.
- The ZIP excludes tests, dependencies, build output, and secrets. Its source matches the tested build.

Provider responses in tests are mocked. No live-model comparison was performed, so improved naturalness and consistency are intended behaviors, not measured quality gains or guarantees. No production deployment was made. The frontend still requires its ZIP to be reuploaded for integration review.

Use Node.js 22 or newer, then `npm ci`, `npm run build`, and `npm start`. No new environment variable or database migration is required by this update. Restoring the four changed source files from the reliability release reverts this model/reply update.
