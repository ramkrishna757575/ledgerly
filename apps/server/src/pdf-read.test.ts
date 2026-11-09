import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readPdf } from './pdf-read.ts';

const hasQpdf = spawnSync('qpdf', ['--version']).error === undefined;
const dir = mkdtempSync(join(tmpdir(), 'ledgerly-pdf-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function locked(password: string) {
  const plain = join(dir, 'plain.pdf');
  writeFileSync(plain, ['%PDF-1.4', '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj', '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj', '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj', 'trailer << /Root 1 0 R /Size 4 >>', '%%EOF'].join('\n'));
  const out = join(dir, `${password}.pdf`);
  spawnSync('qpdf', [plain, '--encrypt', password, `${password}x`, '256', '--', out]);
  return out;
}

describe.skipIf(!hasQpdf)('readPdf', () => {
  it('falls back to the saved passwords when none, or a wrong one, is typed', async () => {
    const file = locked('card-pass');
    await expect(readPdf(file, ['nope', 'card-pass'])).resolves.toBeTypeOf('string');
    await expect(readPdf(file, ['nope', 'card-pass'], 'also-wrong')).resolves.toBeTypeOf('string');
    await expect(readPdf(file, ['card-pass'], 'card-pass')).resolves.toBeTypeOf('string');
  });

  it('asks for a password when nothing opens it', async () => {
    const file = locked('card-pass');
    await expect(readPdf(file, ['nope'])).rejects.toMatchObject({ code: 'password_required' });
    await expect(readPdf(file, ['nope'], 'also-wrong')).rejects.toMatchObject({ code: 'wrong_password' });
  });
});
