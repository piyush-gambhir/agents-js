// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type Span, SpanStatusCode, context as otelContext, trace } from '@opentelemetry/api';
import type { RealtimeModelMetrics } from '../metrics/base.js';
import * as traceTypes from './trace_types.js';
import { tracer } from './traces.js';

export function recordException(span: Span, error: Error): void {
  span.recordException(error);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error.message,
  });

  span.setAttributes({
    [traceTypes.ATTR_EXCEPTION_TYPE]: error.constructor.name,
    [traceTypes.ATTR_EXCEPTION_MESSAGE]: error.message,
    [traceTypes.ATTR_EXCEPTION_TRACE]: error.stack || '',
  });
}

export function recordRealtimeMetrics(span: Span, metrics: RealtimeModelMetrics): void {
  const attrs: Record<string, string | number> = {
    [traceTypes.ATTR_GEN_AI_REQUEST_MODEL]: metrics.label || 'unknown',
    [traceTypes.ATTR_REALTIME_MODEL_METRICS]: JSON.stringify(metrics),
    [traceTypes.ATTR_GEN_AI_USAGE_INPUT_TOKENS]: metrics.inputTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: metrics.outputTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_INPUT_TEXT_TOKENS]: metrics.inputTokenDetails.textTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_INPUT_AUDIO_TOKENS]: metrics.inputTokenDetails.audioTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_INPUT_CACHED_TOKENS]: metrics.inputTokenDetails.cachedTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_OUTPUT_TEXT_TOKENS]: metrics.outputTokenDetails.textTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_OUTPUT_AUDIO_TOKENS]: metrics.outputTokenDetails.audioTokens,
  };

  if (metrics.ttftMs !== undefined && metrics.ttftMs !== -1) {
    const completionStartTime = metrics.timestamp + metrics.ttftMs;
    const completionStartTimeUtc = new Date(completionStartTime).toISOString();
    attrs[traceTypes.ATTR_LANGFUSE_COMPLETION_START_TIME] = completionStartTimeUtc;
  }

  if (span.isRecording()) {
    span.setAttributes(attrs);
  } else {
    const currentContext = otelContext.active();
    const spanContext = trace.setSpan(currentContext, span);

    tracer.getTracer().startActiveSpan('realtime_metrics', {}, spanContext, (child) => {
      try {
        child.setAttributes(attrs);
      } finally {
        child.end();
      }
    });
  }
}
