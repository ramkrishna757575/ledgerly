import { DomainError, extractPdfText } from '@ledgerly/core';

// Reads a PDF that may be locked. A password typed in the form goes first;
// the ones saved for statements (Settings, or WATCH_PASSWORDS) are tried after
// it, so a batch uploaded by hand opens the same way one from email does.
export async function readPdf(path: string, saved: string[], typed?: string): Promise<string> {
  for (const password of [typed || undefined, ...(typed ? [] : [undefined]), ...saved]) {
    try {
      return await extractPdfText(path, { password });
    } catch (error) {
      if (!(error instanceof DomainError) || (error.code !== 'password_required' && error.code !== 'wrong_password')) throw error;
    }
  }
  throw typed
    ? new DomainError('wrong_password', 'That password did not open the PDF. Check it and try again.')
    : new DomainError('password_required', saved.length === 0 ? 'This PDF is password protected. Enter its password to read it.' : 'None of the configured passwords opened the file');
}
