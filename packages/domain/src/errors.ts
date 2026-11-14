export const errorCodes = {
  configurationInvalid: 'CONFIGURATION_INVALID',
  dependencyMissing: 'DEPENDENCY_MISSING',
  validationFailed: 'VALIDATION_FAILED',
  notFound: 'NOT_FOUND',
  conflict: 'CONFLICT',
  internal: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];

export type ErrorDetail = string | number | boolean;

export type ErrorDetails = Readonly<Record<string, ErrorDetail>>;

export class TagaError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'TagaError';
    this.code = code;
    this.details = details;
  }
}

export function isTagaError(error: unknown): error is TagaError {
  return error instanceof TagaError;
}
