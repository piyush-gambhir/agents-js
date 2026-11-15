// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
export type PersonaConfig = {
  name?: string;
  avatarId?: string;
  personaId?: string;
};

export type APIConnectOptions = {
  maxRetry?: number;
  retryInterval?: number;
  timeout?: number;
};

export class AnamException extends Error {}
