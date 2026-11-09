import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Made-up statements in the shape of real ones, used by demo mode so people can
// try the import flow without uploading anything.
const SAMPLES = [
  { id: 'bank', label: 'Savings account statement', file: 'axis-consolidated.txt' },
  { id: 'card', label: 'Credit card statement', file: 'axis-card.txt' },
] as const;

export function listSampleStatements() {
  return SAMPLES.map(({ id, label }) => ({ id, label }));
}

export function getSampleStatement(id: string) {
  const sample = SAMPLES.find((s) => s.id === id);
  if (!sample) return undefined;
  const text = readFileSync(new URL(`./fixtures/${sample.file}`, import.meta.url), 'utf8');
  return {
    text,
    file: {
      sha256: createHash('sha256').update(text).digest('hex'),
      filename: `sample-${sample.id}-statement.pdf`,
      mimeType: 'application/pdf',
      size: text.length,
      storedName: `sample-${sample.id}`,
    },
  };
}
