import { ApiError } from './api.ts';

// Banks tend to lock every statement with the same password. The one that last
// worked is kept in memory, so a batch of months needs it typed once. It is
// never written anywhere and is gone when the page is reloaded.
let remembered = '';

export const needsPassword = (error: unknown) =>
  error instanceof ApiError && (error.code === 'password_required' || error.code === 'wrong_password');

export async function sendWithPassword<T>(send: (password?: string) => Promise<T>, typed: string): Promise<T> {
  const first = typed || undefined;
  try {
    const result = await send(first);
    if (first) remembered = first;
    return result;
  } catch (error) {
    if (!first && remembered && error instanceof ApiError && error.code === 'password_required') {
      const result = await send(remembered);
      return result;
    }
    throw error;
  }
}
