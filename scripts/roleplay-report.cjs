#!/usr/bin/env node
// A/B and drift report from [roleplay-telemetry] log lines.
//   npm run build && node scripts/roleplay-report.cjs render-logs.txt [more files] [--json]
//   cat render-logs.txt | node scripts/roleplay-report.cjs - 
const fs = require('node:fs');
const { parseTelemetryLines, analyzeTelemetry, renderReport } = require('../dist/lib/roleplayReport');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const files = args.filter(a => a !== '--json');
if (!files.length) {
  console.error('usage: node scripts/roleplay-report.cjs <log file>... | -   [--json]');
  process.exit(2);
}
let text;
try {
  text = files.map(f => (f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(f, 'utf8'))).join('\n');
} catch (err) {
  console.error(`Could not read input: ${err.message}`);
  process.exit(1);
}
const events = parseTelemetryLines(text);
if (!events.length) {
  console.error('No [roleplay-telemetry] lines found. Is ROLEPLAY_TELEMETRY=off, or is this the wrong log file?');
  process.exit(1);
}
const reports = analyzeTelemetry(events);
console.log(asJson ? JSON.stringify(reports, null, 2) : renderReport(reports, events.length));
