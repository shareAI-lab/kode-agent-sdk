export type ResumeErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'AGENT_NOT_FOUND'
  | 'TEMPLATE_NOT_FOUND'
  | 'TEMPLATE_VERSION_MISMATCH'
  | 'SANDBOX_INIT_FAILED'
  | 'CORRUPTED_DATA';

export class ResumeError extends Error {
  readonly code: ResumeErrorCode;

  constructor(code: ResumeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'ResumeError';
  }
}

export function assert(condition: any, code: ResumeErrorCode, message: string): asserts condition {
  if (!condition) {
    throw new ResumeError(code, message);
  }
}

export class MultimodalValidationError extends Error {
  readonly code = 'ERR_MULTIMODAL_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'MultimodalValidationError';
  }
}

export class UnsupportedContentBlockError extends Error {
  readonly code = 'ERR_CONTENTBLOCK_UNSUPPORTED';

  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedContentBlockError';
  }
}

export class UnsupportedProviderError extends Error {
  readonly code = 'ERR_PROVIDER_UNSUPPORTED';

  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedProviderError';
  }
}

export class ProviderCapabilityError extends Error {
  readonly code = 'ERR_PROVIDER_CAPABILITY';

  constructor(message: string) {
    super(message);
    this.name = 'ProviderCapabilityError';
  }
}
