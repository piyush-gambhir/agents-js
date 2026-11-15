// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0

export class AssignmentTimeoutError extends Error {
  constructor(message = 'Assignment timeout occurred') {
    super(message);
    this.name = 'AssignmentTimeoutError';
    Error.captureStackTrace(this, AssignmentTimeoutError);
  }
}

interface APIErrorOptions {
  body?: object | null;
  retryable?: boolean;
}

const API_ERROR_SYMBOL = Symbol('APIError');

export class APIError extends Error {
  readonly body: object | null;
  readonly retryable: boolean;

  constructor(message: string, { body = null, retryable = true }: APIErrorOptions = {}) {
    super(message);
    this.name = 'APIError';

    this.body = body;
    this.retryable = retryable;
    Error.captureStackTrace(this, APIError);
    Object.defineProperty(this, API_ERROR_SYMBOL, {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  toString(): string {
    return `${this.message} (body=${JSON.stringify(this.body)}, retryable=${this.retryable})`;
  }
}

interface APIStatusErrorOptions extends APIErrorOptions {
  statusCode?: number;
  requestId?: string | null;
}

export class APIStatusError extends APIError {
  readonly statusCode: number;
  readonly requestId: string | null;

  constructor({
    message = 'API error.',
    options = {},
  }: {
    message?: string;
    options?: APIStatusErrorOptions;
  }) {
    const statusCode = options.statusCode ?? -1;
    const isRetryable =
      options.retryable ??
      (statusCode === 408 || statusCode === 429 || !(statusCode >= 400 && statusCode < 500));

    super(message, { body: options.body, retryable: isRetryable });
    this.name = 'APIStatusError';

    this.statusCode = statusCode;
    this.requestId = options.requestId ?? null;
    Error.captureStackTrace(this, APIStatusError);
  }

  toString(): string {
    return (
      `${this.message} ` +
      `(statusCode=${this.statusCode}, ` +
      `requestId=${this.requestId}, ` +
      `body=${JSON.stringify(this.body)}, ` +
      `retryable=${this.retryable})`
    );
  }
}

export class APIConnectionError extends APIError {
  constructor({
    message = 'Connection error.',
    options = {},
  }: {
    message?: string;
    options?: APIErrorOptions;
  }) {
    super(message, { body: null, retryable: options.retryable ?? true });
    this.name = 'APIConnectionError';
    Error.captureStackTrace(this, APIConnectionError);
  }
}

export class APITimeoutError extends APIConnectionError {
  constructor({
    message = 'Request timed out.',
    options = {},
  }: {
    message?: string;
    options?: APIErrorOptions;
  }) {
    const retryable = options?.retryable ?? true;

    super({ message, options: { retryable } });
    this.name = 'APITimeoutError';
    Error.captureStackTrace(this, APITimeoutError);
  }
}

export function isAPIError(error: unknown): error is APIError {
  return error !== null && typeof error === 'object' && API_ERROR_SYMBOL in error;
}
