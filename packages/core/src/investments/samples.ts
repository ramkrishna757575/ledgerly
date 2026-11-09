import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Made-up statements in the shape of real ones, so demo mode can show the import
// without anyone uploading a real statement.
const SAMPLES = [
  { id: 'cdsl', label: 'Consolidated account statement (as on 30 Sep 2026)', file: 'cdsl-cas.txt' },
  { id: 'scripbox', label: 'Portfolio report (as on 9 Nov 2026)', file: 'scripbox-portfolio.txt' },
] as const;

export function listInvestmentSamples() {
  return SAMPLES.map(({ id, label }) => ({ id, label }));
}

export function getInvestmentSample(id: string) {
  const sample = SAMPLES.find((s) => s.id === id);
  if (!sample) return undefined;
  const text = readFileSync(new URL(`./fixtures/${sample.file}`, import.meta.url), 'utf8');
  return {
    text,
    file: {
      sha256: createHash('sha256').update(text).digest('hex'),
      filename: `sample-${sample.id}.pdf`,
      mimeType: 'application/pdf',
      size: text.length,
      storedName: `sample-${sample.id}`,
    },
  };
}
