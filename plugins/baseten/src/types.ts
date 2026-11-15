// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface BasetenLLMOptions {
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  user?: string;
  toolChoice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  parallelToolCalls?: boolean;
}

export interface BasetenSttOptions {
  apiKey: string;
  /** @deprecated Use modelEndpoint instead */
  modelId?: string;
  modelEndpoint?: string;
  environment?: string;
  encoding?: string;
  sampleRate?: number;
  bufferSizeSeconds?: number;
  vadThreshold?: number;
  vadMinSilenceDurationMs?: number;
  vadSpeechPadMs?: number;
  enablePartialTranscripts?: boolean;
  partialTranscriptIntervalS?: number;
  finalTranscriptMaxDurationS?: number;
  audioLanguage?: string;
  prompt?: string;
  languageDetectionOnly?: boolean;
}

export interface BasetenTTSOptions {
  apiKey: string;
  modelEndpoint: string;
  voice?: string;
  language?: string;
  temperature?: number;
  maxTokens?: number;
}
