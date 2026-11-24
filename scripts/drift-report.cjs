#!/usr/bin/env node
// Persona-drift check on a saved conversation: compares the character's first
// and last replies on repetition, stock phrases, assistant-style phrasing, etc.
//   npm run build && node scripts/drift-report.cjs chat.json [--name Mira] [--json]
// chat.json: [{ "role": "user"|"assistant", "content": "..." }, ...]  or  { "replies": ["...", ...] }
const fs = require('node:fs');
const { driftReport, measureTranscript } = require('../dist/lib/providers/replyMetrics');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const nameAt = args.indexOf('--name');
const name = nameAt >= 0 ? args[nameAt + 1] ?? '' : '';
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--name');
if (!file) { console.error('usage: node scripts/drift-report.cjs <chat.json> [--name Mira] [--json]'); process.exit(2); }

let data;
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`Could not read ${file} as JSON: ${err.message}`);
  process.exit(1);
}
const replies = Array.isArray(data)
  ? data.filter(m => m && m.role === 'assistant').map(m => String(m.content ?? ''))
  : (data.replies ?? []).map(String);
const report = driftReport(replies, name);
if (!report) { console.error(`Need at least 6 character replies (found ${replies.length}).`); process.exit(1); }
if (asJson) { console.log(JSON.stringify({ overall: measureTranscript(replies, name), ...report }, null, 2)); process.exit(0); }

const pct = x => `${(x * 100).toFixed(1)}%`;
const row = (label, k, f = pct) => console.log(`${label.padEnd(24)} ${String(f(report.early[k])).padStart(8)} ${String(f(report.late[k])).padStart(8)}   ${(report.delta[k] >= 0 ? '+' : '') + (k === 'meanWords' ? report.delta[k].toFixed(1) : (report.delta[k] * 100).toFixed(1) + ' pts')}`);
console.log(`Drift report: first ${report.windowSize} vs last ${report.windowSize} of ${replies.length} replies\n`);
console.log(`${''.padEnd(24)} ${'early'.padStart(8)} ${'late'.padStart(8)}   change`);
row('mean words', 'meanWords', x => x.toFixed(1));
row('non-verbal beat', 'actionRate');
row('ends on question', 'questionEndRate');
row('assistant-isms', 'assistantismRate');
row('stock tics', 'ticRate');
row('adjacent repeat*', 'repeatAdjacentRate');
row('repeated phrase', 'repeatedPhraseRate');
row('opening diversity', 'openingDiversity');
console.log('\nDrift signals: assistant-isms, stock tics and repeats going UP, opening diversity going DOWN.');
console.log('*lexical proxy for semantic repetition; compare early vs late, not against published figures.');
