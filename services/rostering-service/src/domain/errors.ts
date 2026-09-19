/** Domain errors the transport maps to HTTP status codes. */

export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}

export class PreconditionError extends Error {
  override readonly name = 'PreconditionError';
}

export class ForbiddenError extends Error {
  override readonly name = 'ForbiddenError';
}

export class IdempotencyMismatchError extends Error {
  override readonly name = 'IdempotencyMismatchError';
}
