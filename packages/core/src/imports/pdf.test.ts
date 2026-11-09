import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors.ts';
import { extractPdfText } from './pdf.ts';

// qpdf is only used here, to make a locked PDF to read.
const hasTools = ['qpdf', 'pdftotext'].every((tool) => spawnSync(tool, ['--version']).error === undefined);

// A one-line PDF, with the password locking it when one is given.
export function makePdf(text: string, password?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerly-test-'));
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const raw = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    'trailer << /Root 1 0 R /Size 6 >>',
    '%%EOF',
  ].join('\n');
  const source = join(dir, 'source.pdf');
  const out = join(dir, 'out.pdf');
  writeFileSync(source, raw);
  const encrypt = password ? ['--encrypt', password, `${password}-owner`, '256', '--'] : [];
  spawnSync('qpdf', [source, ...encrypt, out]);
  return out;
}

describe.skipIf(!hasTools)('password protected PDFs', () => {
  it('reads an unlocked PDF as before', async () => {
    expect(await extractPdfText(makePdf('Closing balance 1,234.00'))).toContain('Closing balance 1,234.00');
  });

  it('asks for a password when one is needed', async () => {
    const locked = makePdf('Secret statement', 'abcd1234');
    await expect(extractPdfText(locked)).rejects.toMatchObject({ code: 'password_required' });
  });

  it('opens it with the right password and rejects a wrong one', async () => {
    const locked = makePdf('Secret statement', 'abcd1234');
    expect(await extractPdfText(locked, { password: 'abcd1234' })).toContain('Secret statement');
    await expect(extractPdfText(locked, { password: 'nope' })).rejects.toMatchObject({ code: 'wrong_password' });
    await expect(extractPdfText(locked, { password: 'nope' })).rejects.toBeInstanceOf(DomainError);
  });

  it('copes with a password full of shell characters, and leaves the file locked', async () => {
    const locked = makePdf('Secret statement', "it's a $pa ce;word");
    const before = readFileSync(locked);
    expect(await extractPdfText(locked, { password: "it's a $pa ce;word" })).toContain('Secret statement');
    expect(readFileSync(locked).equals(before)).toBe(true);
    expect(() => execFileSync('pdftotext', [locked, '-'], { stdio: 'pipe' })).toThrow();
  });
});
