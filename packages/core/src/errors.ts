export type DomainErrorCode = 'invalid' | 'not_found' | 'conflict' | 'password_required' | 'wrong_password';

export class DomainError extends Error {
  code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
