// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
export interface InterruptionOptions {
  enabled: boolean;
  mode: 'adaptive' | 'vad' | undefined;
  discardAudioIfUninterruptible: boolean;
  minDuration: number;
  minWords: number;
  falseInterruptionTimeout: number;
  resumeFalseInterruption: boolean;
}

export const defaultInterruptionOptions = {
  enabled: true,
  mode: undefined,
  discardAudioIfUninterruptible: true,
  minDuration: 500,
  minWords: 0,
  falseInterruptionTimeout: 2000,
  resumeFalseInterruption: true,
} as const satisfies InterruptionOptions;
