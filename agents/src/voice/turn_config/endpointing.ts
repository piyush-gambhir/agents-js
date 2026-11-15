// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
export interface EndpointingOptions {
  mode: 'fixed' | 'dynamic';
  minDelay: number;
  maxDelay: number;
}

export const defaultEndpointingOptions = {
  mode: 'fixed',
  minDelay: 500,
  maxDelay: 3000,
} as const satisfies EndpointingOptions;
