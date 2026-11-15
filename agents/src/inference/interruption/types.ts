// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Span } from '@opentelemetry/api';

export interface OverlappingSpeechEvent {
  type: 'overlapping_speech';
  detectedAt: number;
  isInterruption: boolean;
  totalDurationInS: number;
  predictionDurationInS: number;
  detectionDelayInS: number;
  overlapStartedAt?: number;
  speechInput?: Int16Array;
  probabilities?: number[];
  probability: number;
  numRequests: number;
}

export interface InterruptionOptions {
  sampleRate: number;
  threshold: number;
  minFrames: number;
  maxAudioDurationInS: number;
  audioPrefixDurationInS: number;
  detectionIntervalInS: number;
  inferenceTimeout: number;
  minInterruptionDurationInS: number;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  useProxy: boolean;
}

export interface ApiConnectOptions {
  maxRetries: number;
  retryInterval: number;
  timeout: number;
}

export interface AgentSpeechStarted {
  type: 'agent-speech-started';
}

export interface AgentSpeechEnded {
  type: 'agent-speech-ended';
}

export interface OverlapSpeechStarted {
  type: 'overlap-speech-started';
  speechDuration: number;
  startedAt: number;
  userSpeakingSpan?: Span;
}

export interface OverlapSpeechEnded {
  type: 'overlap-speech-ended';
  endedAt: number;
}

export interface Flush {
  type: 'flush';
}

export type InterruptionSentinel =
  | AgentSpeechStarted
  | AgentSpeechEnded
  | OverlapSpeechStarted
  | OverlapSpeechEnded
  | Flush;
