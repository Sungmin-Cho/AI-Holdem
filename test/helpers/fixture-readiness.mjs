import fs from 'node:fs';

// JSONL producers publish a record only with its trailing newline. A visible
// file (or even a valid JSON prefix) alone is not a readiness checkpoint.
export function readFirstFixtureRecord(file, producer) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return pending(producer); throw error; }
  const end = text.indexOf('\n');
  if (end === -1) return pending(producer);
  return JSON.parse(text.slice(0, end));
}

function pending(producer) {
  if (producer && (producer.exitCode != null || producer.signalCode != null)) {
    throw new Error(`fixture record producer terminated: ${producer.exitCode}/${producer.signalCode}`);
  }
  return null;
}
