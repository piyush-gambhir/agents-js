// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0

export const USERDATA_TIMED_TRANSCRIPT = 'lk.timed_transcripts';

export interface APIConnectOptions {
  maxRetry: number;
  retryIntervalMs: number;
  timeoutMs: number;
}

export const DEFAULT_API_CONNECT_OPTIONS: APIConnectOptions = {
  maxRetry: 3,
  retryIntervalMs: 2000,
  timeoutMs: 10000,
};

/**
 * Return the interval for the given number of retries.
 * The first retry is immediate, and then uses specified retryIntervalMs.
 * @internal
 */
export function intervalForRetry(connOptions: APIConnectOptions, numRetries: number): number {
  if (numRetries === 0) {
    return 0.1;
  }
  return connOptions.retryIntervalMs;
}

export interface SessionConnectOptions {
  sttConnOptions?: Partial<APIConnectOptions>;
  llmConnOptions?: Partial<APIConnectOptions>;
  ttsConnOptions?: Partial<APIConnectOptions>;
  maxUnrecoverableErrors?: number;
}

/**
 * Resolved session connect options with all values populated.
 * @internal
 */
export interface ResolvedSessionConnectOptions {
  sttConnOptions: APIConnectOptions;
  llmConnOptions: APIConnectOptions;
  ttsConnOptions: APIConnectOptions;
  maxUnrecoverableErrors: number;
}

export const DEFAULT_SESSION_CONNECT_OPTIONS: ResolvedSessionConnectOptions = {
  sttConnOptions: DEFAULT_API_CONNECT_OPTIONS,
  llmConnOptions: DEFAULT_API_CONNECT_OPTIONS,
  ttsConnOptions: DEFAULT_API_CONNECT_OPTIONS,
  maxUnrecoverableErrors: 3,
};
