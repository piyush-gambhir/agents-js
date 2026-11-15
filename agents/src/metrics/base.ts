// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0

export type MetricsMetadata = {
  modelProvider?: string;
  modelName?: string;
};

export type AgentMetrics =
  | STTMetrics
  | LLMMetrics
  | TTSMetrics
  | VADMetrics
  | EOUMetrics
  | RealtimeModelMetrics
  | InterruptionMetrics;

export type LLMMetrics = {
  type: 'llm_metrics';
  label: string;
  requestId: string;
  timestamp: number;
  durationMs: number;
  ttftMs: number;
  cancelled: boolean;
  completionTokens: number;
  promptTokens: number;
  promptCachedTokens: number;
  totalTokens: number;
  tokensPerSecond: number;
  speechId?: string;
  metadata?: MetricsMetadata;
};

export type STTMetrics = {
  type: 'stt_metrics';
  label: string;
  requestId: string;
  timestamp: number;
  durationMs: number;
  audioDurationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  streamed: boolean;
  metadata?: MetricsMetadata;
};

export type TTSMetrics = {
  type: 'tts_metrics';
  label: string;
  requestId: string;
  timestamp: number;
  ttfbMs: number;
  durationMs: number;
  audioDurationMs: number;
  cancelled: boolean;
  charactersCount: number;
  inputTokens?: number;
  outputTokens?: number;
  streamed: boolean;
  segmentId?: string;
  speechId?: string;
  metadata?: MetricsMetadata;
};

export type VADMetrics = {
  type: 'vad_metrics';
  label: string;
  timestamp: number;
  idleTimeMs: number;
  inferenceDurationTotalMs: number;
  inferenceCount: number;
};

export type EOUMetrics = {
  type: 'eou_metrics';
  timestamp: number;
  endOfUtteranceDelayMs: number;
  transcriptionDelayMs: number;
  onUserTurnCompletedDelayMs: number;
  lastSpeakingTimeMs: number;
  speechId?: string;
};

export type RealtimeModelMetricsCachedTokenDetails = {
  audioTokens: number;
  textTokens: number;
  imageTokens: number;
};

export type RealtimeModelMetricsInputTokenDetails = {
  audioTokens: number;
  textTokens: number;
  imageTokens: number;
  cachedTokens: number;
  cachedTokensDetails?: RealtimeModelMetricsCachedTokenDetails;
};

export type RealtimeModelMetricsOutputTokenDetails = {
  textTokens: number;
  audioTokens: number;
  imageTokens: number;
};

export type RealtimeModelMetrics = {
  type: 'realtime_model_metrics';
  label: string;
  requestId: string;
  timestamp: number;
  durationMs: number;
  sessionDurationMs?: number;
  ttftMs: number;
  cancelled: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokensPerSecond: number;
  inputTokenDetails: RealtimeModelMetricsInputTokenDetails;
  outputTokenDetails: RealtimeModelMetricsOutputTokenDetails;
  metadata?: MetricsMetadata;
};

export type InterruptionMetrics = {
  type: 'interruption_metrics';
  timestamp: number;
  totalDuration: number;
  predictionDuration: number;
  detectionDelay: number;
  numInterruptions: number;
  numBackchannels: number;
  numRequests: number;
  metadata?: MetricsMetadata;
};
