/**
 * Engine-raised errors. The HTTP layer maps these to status codes:
 * NotFoundError → 404, ForbiddenError (message starts with "forbidden:") → 403,
 * ConflictError → conflict, everything else → 500.
 */

export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}

export class ForbiddenError extends Error {
  override readonly name = 'ForbiddenError';
}

export class ConflictError extends Error {
  override readonly name = 'ConflictError';
}

export class DomainClientError extends Error {
  override readonly name = 'DomainClientError';
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(`domain service returned ${status} (${code}): ${message}`);
    this.status = status;
    this.code = code;
  }
}

export class EnginePermanentError extends Error {
  override readonly name: string = 'EnginePermanentError';
}
