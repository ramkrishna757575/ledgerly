import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DomainError } from '../errors.ts';

const run = promisify(execFile);

// pdftotext keeps the column layout, which the bank adapters depend on.
//
// Banks lock statements with a password, so one may be needed. pdftotext only
// takes it as an argument, so for the second or so it runs, the password can be
// seen in the process list by other users of the same machine. On a personal
// computer or in the container that is only you. It is never stored: the
// uploaded file stays locked on disk.
export async function extractPdfText(path: string, options: { password?: string } = {}) {
  const { password } = options;
  const args = ['-layout', ...(password ? ['-upw', password] : []), path, '-'];
  try {
    const { stdout } = await run('pdftotext', args, { maxBuffer: 50 * 1024 * 1024, timeout: 30_000 });
    return stdout;
  } catch (error) {
    const { code, stderr = '' } = error as { code?: string; stderr?: string };
    if (code === 'ENOENT') {
      throw new DomainError('invalid', 'Reading PDFs needs pdftotext (poppler-utils) to be installed');
    }
    if (/incorrect password/i.test(stderr)) {
      // poppler turns away some passwords that other readers accept, so qpdf
      // gets a try at unlocking the file before it is called wrong.
      if (password) {
        const unlocked = await viaQpdf(path, password);
        if (unlocked !== undefined) return unlocked;
      }
      throw password
        ? new DomainError('wrong_password', 'That password did not open the PDF. Check it and try again.')
        : new DomainError('password_required', 'This PDF is password protected. Enter its password to read it.');
    }
    throw new DomainError('invalid', 'This PDF could not be read');
  }
}

async function viaQpdf(path: string, password: string): Promise<string | undefined> {
  const work = await mkdtemp(join(tmpdir(), 'ledgerly-unlock-'));
  try {
    const open = join(work, 'open.pdf');
    // Exit code 3 only means warnings; the file is still written.
    await run('qpdf', [`--password=${password}`, '--decrypt', path, open], { timeout: 30_000 }).catch((error) => {
      if (error?.code !== 3) throw error;
    });
    return (await run('pdftotext', ['-layout', open, '-'], { maxBuffer: 50 * 1024 * 1024, timeout: 30_000 })).stdout;
  } catch {
    return undefined;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
