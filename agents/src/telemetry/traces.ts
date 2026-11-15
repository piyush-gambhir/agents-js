// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import { MetricsRecordingHeader } from '@livekit/protocol';
import {
  type Attributes,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
  context as otelContext,
  trace,
} from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import FormData from 'form-data';
import { AccessToken } from 'livekit-server-sdk';
import fs from 'node:fs/promises';
import type { ChatContent, ChatItem, ChatRole } from '../llm/index.js';
import { enableOtelLogging } from '../log.js';
import { filterZeroValues } from '../metrics/model_usage.js';
import type { SessionReport } from '../voice/report.js';
import { type SimpleLogRecord, SimpleOTLPHttpLogExporter } from './otel_http_exporter.js';
import { flushPinoLogs, initPinoCloudExporter } from './pino_otel_transport.js';

export interface StartSpanOptions {
  name: string;
  context?: Context;
  attributes?: Attributes;
  endOnExit?: boolean;
  startTime?: number;
}

class DynamicTracer {
  private tracerProvider: TracerProvider;
  private tracer: Tracer;
  private readonly instrumentingModuleName: string;

  constructor(instrumentingModuleName: string) {
    this.instrumentingModuleName = instrumentingModuleName;
    this.tracerProvider = trace.getTracerProvider();
    this.tracer = trace.getTracer(instrumentingModuleName);
  }

  /**
   * Set a new tracer provider. This updates the underlying tracer instance.
   * @param provider - The new tracer provider to use
   */
  setProvider(provider: TracerProvider): void {
    this.tracerProvider = provider;
    this.tracer = this.tracerProvider.getTracer(this.instrumentingModuleName);
  }

  getTracer(): Tracer {
    return this.tracer;
  }

  /**
   * Start a span manually (without making it active).
   * You must call span.end() when done.
   *
   * @param options - Span configuration including name
   * @returns The created span
   */
  startSpan(options: StartSpanOptions): Span {
    const ctx = options.context || otelContext.active();

    const span = this.tracer.startSpan(
      options.name,
      {
        attributes: options.attributes,
        startTime: options.startTime,
      },
      ctx,
    );

    return span;
  }

  /**
   * Start a new span and make it active in the current context.
   * The span will automatically be ended when the provided function completes (unless endOnExit=false).
   *
   * @param fn - The function to execute within the span context
   * @param options - Span configuration including name
   * @returns The result of the provided function
   */
  async startActiveSpan<T>(fn: (span: Span) => Promise<T>, options: StartSpanOptions): Promise<T> {
    const ctx = options.context || otelContext.active();
    const endOnExit = options.endOnExit === undefined ? true : options.endOnExit;
    const opts: SpanOptions = { attributes: options.attributes, startTime: options.startTime };

    return await this.tracer.startActiveSpan(options.name, opts, ctx, async (span) => {
      try {
        return await fn(span);
      } finally {
        if (endOnExit) {
          span.end();
        }
      }
    });
  }

  /**
   * Synchronous version of startActiveSpan for non-async operations.
   *
   * @param fn - The function to execute within the span context
   * @param options - Span configuration including name
   * @returns The result of the provided function
   */
  startActiveSpanSync<T>(fn: (span: Span) => T, options: StartSpanOptions): T {
    const ctx = options.context || otelContext.active();
    const endOnExit = options.endOnExit === undefined ? true : options.endOnExit;
    const opts: SpanOptions = { attributes: options.attributes, startTime: options.startTime };

    return this.tracer.startActiveSpan(options.name, opts, ctx, (span) => {
      try {
        return fn(span);
      } finally {
        if (endOnExit) {
          span.end();
        }
      }
    });
  }
}

export const tracer = new DynamicTracer('livekit-agents');

export class MetadataSpanProcessor implements SpanProcessor {
  private metadata: Attributes;

  constructor(metadata: Attributes) {
    this.metadata = metadata;
  }

  onStart(span: Span, _parentContext: Context): void {
    span.setAttributes(this.metadata);
  }

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Set the tracer provider for the livekit-agents framework.
 * This should be called before agent session start if using custom tracer providers.
 *
 * @param provider - The tracer provider to use (must be a NodeTracerProvider)
 * Configure metadata processors in the provider constructor before passing it here.
 *
 * @example
 * ```typescript
 * import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
 * import { MetadataSpanProcessor, setTracerProvider } from '@livekit/agents/telemetry';
 *
 * const provider = new NodeTracerProvider({
 *   spanProcessors: [new MetadataSpanProcessor({ room_id: 'room123', job_id: 'job456' })]
 * });
 * setTracerProvider(provider);
 * ```
 */
export function setTracerProvider(provider: NodeTracerProvider): void {
  tracer.setProvider(provider);
}

/**
 * Setup OpenTelemetry tracer for LiveKit Cloud observability.
 * This configures OTLP exporters to send traces to LiveKit Cloud.
 *
 * @param options - Configuration for cloud tracer with roomId, jobId, and cloudHostname properties
 *
 * @internal
 */
export async function setupCloudTracer(options: {
  roomId: string;
  jobId: string;
  cloudHostname: string;
}): Promise<void> {
  const { roomId, jobId, cloudHostname } = options;

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set for cloud tracing');
  }

  const token = new AccessToken(apiKey, apiSecret, {
    identity: 'livekit-agents-telemetry',
    ttl: '6h',
  });
  token.addObservabilityGrant({ write: true });

  try {
    const jwt = await token.toJwt();

    const headers = {
      Authorization: `Bearer ${jwt}`,
    };

    const metadata: Attributes = {
      room_id: roomId,
      job_id: jobId,
    };

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'livekit-agents',
      room_id: roomId,
      job_id: jobId,
    });

    const spanExporter = new OTLPTraceExporter({
      url: `https://${cloudHostname}/observability/traces/otlp/v0`,
      headers,
      compression: CompressionAlgorithm.GZIP,
    });

    const tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new MetadataSpanProcessor(metadata), new BatchSpanProcessor(spanExporter)],
    });
    tracerProvider.register();

    setTracerProvider(tracerProvider);

    initPinoCloudExporter({
      cloudHostname,
      roomId,
      jobId,
    });

    enableOtelLogging();
  } catch (error) {
    console.error('Failed to setup cloud tracer:', error);
    throw error;
  }
}

/**
 * Flush all pending Pino logs to ensure they are exported.
 * Call this before session/job ends to ensure all logs are sent.
 *
 * @internal
 */
export async function flushOtelLogs(): Promise<void> {
  await flushPinoLogs();
}

type ProtoRole = 'DEVELOPER' | 'SYSTEM' | 'USER' | 'ASSISTANT';

const ROLE_MAP: Record<ChatRole, ProtoRole> = {
  developer: 'DEVELOPER',
  system: 'SYSTEM',
  user: 'USER',
  assistant: 'ASSISTANT',
};

interface ProtoMetricsReport {
  startedSpeakingAt?: string;
  stoppedSpeakingAt?: string;
  transcriptionDelay?: number;
  endOfTurnDelay?: number;
  onUserTurnCompletedDelay?: number;
  llmNodeTtft?: number;
  ttsNodeTtfb?: number;
  e2eLatency?: number;
}

interface ProtoMessage {
  id: string;
  role: ProtoRole;
  content: { text: ChatContent }[];
  createdAt: string;
  interrupted?: boolean;
  extra?: Record<string, unknown>;
  transcriptConfidence?: number;
  metrics?: ProtoMetricsReport;
}

interface ProtoFunctionCall {
  id: string;
  callId: string;
  arguments: string | Record<string, unknown>;
  name: string;
  createdAt: string;
}

interface ProtoFunctionCallOutput {
  id: string;
  name: string;
  callId: string;
  output: string;
  isError: boolean;
  createdAt: string;
}

interface ProtoAgentHandoff {
  id: string;
  newAgentId: string;
  createdAt: string;
  oldAgentId?: string;
}

interface ProtoChatItem {
  message?: ProtoMessage;
  functionCall?: ProtoFunctionCall;
  functionCallOutput?: ProtoFunctionCallOutput;
  agentHandoff?: ProtoAgentHandoff;
}

function chatItemToProto(item: ChatItem): ProtoChatItem {
  const itemDict: ProtoChatItem = {};

  if (item.type === 'message') {
    const msg: ProtoMessage = {
      id: item.id,
      role: ROLE_MAP[item.role] ?? (item.role.toUpperCase() as ProtoRole),
      content: item.content.map((c: ChatContent) => ({ text: c })),
      createdAt: toRFC3339(item.createdAt),
    };

    if (item.interrupted) {
      msg.interrupted = item.interrupted;
    }

    if (item.extra && Object.keys(item.extra).length > 0) {
      msg.extra = item.extra;
    }

    if (item.transcriptConfidence !== undefined) {
      msg.transcriptConfidence = item.transcriptConfidence;
    }

    const metrics = item.metrics;
    if (metrics && Object.keys(metrics).length > 0) {
      const protoMetrics: ProtoMetricsReport = {};
      if (metrics.startedSpeakingAt !== undefined) {
        protoMetrics.startedSpeakingAt = toRFC3339(metrics.startedSpeakingAt * 1000);
      }
      if (metrics.stoppedSpeakingAt !== undefined) {
        protoMetrics.stoppedSpeakingAt = toRFC3339(metrics.stoppedSpeakingAt * 1000);
      }
      if (metrics.transcriptionDelay !== undefined) {
        protoMetrics.transcriptionDelay = metrics.transcriptionDelay;
      }
      if (metrics.endOfTurnDelay !== undefined) {
        protoMetrics.endOfTurnDelay = metrics.endOfTurnDelay;
      }
      if (metrics.onUserTurnCompletedDelay !== undefined) {
        protoMetrics.onUserTurnCompletedDelay = metrics.onUserTurnCompletedDelay;
      }
      if (metrics.llmNodeTtft !== undefined) {
        protoMetrics.llmNodeTtft = metrics.llmNodeTtft;
      }
      if (metrics.ttsNodeTtfb !== undefined) {
        protoMetrics.ttsNodeTtfb = metrics.ttsNodeTtfb;
      }
      if (metrics.e2eLatency !== undefined) {
        protoMetrics.e2eLatency = metrics.e2eLatency;
      }
      msg.metrics = protoMetrics;
    }

    itemDict.message = msg;
  } else if (item.type === 'function_call') {
    itemDict.functionCall = {
      id: item.id,
      callId: item.callId,
      arguments: item.args,
      name: item.name,
      createdAt: toRFC3339(item.createdAt),
    };
  } else if (item.type === 'function_call_output') {
    itemDict.functionCallOutput = {
      id: item.id,
      name: item.name,
      callId: item.callId,
      output: item.output,
      isError: item.isError,
      createdAt: toRFC3339(item.createdAt),
    };
  } else if (item.type === 'agent_handoff') {
    const handoff: ProtoAgentHandoff = {
      id: item.id,
      newAgentId: item.newAgentId,
      createdAt: toRFC3339(item.createdAt),
    };
    if (item.oldAgentId !== undefined && item.oldAgentId !== null && item.oldAgentId !== '') {
      handoff.oldAgentId = item.oldAgentId;
    }
    itemDict.agentHandoff = handoff;
  }

  try {
    if (item.type === 'function_call' && typeof itemDict.functionCall?.arguments === 'string') {
      itemDict.functionCall.arguments = JSON.parse(itemDict.functionCall.arguments);
    } else if (
      item.type === 'function_call_output' &&
      typeof itemDict.functionCallOutput?.output === 'string'
    ) {
      itemDict.functionCallOutput.output = JSON.parse(itemDict.functionCallOutput.output);
    }
  } catch {}

  return itemDict;
}

function toRFC3339(valueMs: number | Date): string {
  const dt = valueMs instanceof Date ? valueMs : new Date(valueMs);
  const truncated = new Date(Math.floor(dt.getTime()));
  return truncated.toISOString();
}

/**
 * Upload session report to LiveKit Cloud observability.
 * @param options - Configuration with agentName, cloudHostname, and report
 */
export async function uploadSessionReport(options: {
  agentName: string;
  cloudHostname: string;
  report: SessionReport;
}): Promise<void> {
  const { agentName, cloudHostname, report } = options;

  const logExporter = new SimpleOTLPHttpLogExporter({
    cloudHostname,
    resourceAttributes: {
      room_id: report.roomId,
      job_id: report.jobId,
    },
    scopeName: 'chat_history',
    scopeAttributes: {
      room_id: report.roomId,
      job_id: report.jobId,
      room: report.room,
    },
  });

  const logRecords: SimpleLogRecord[] = [];

  const commonAttrs = {
    room_id: report.roomId,
    job_id: report.jobId,
    'logger.name': 'chat_history',
  };

  const usage = report.modelUsage?.map(filterZeroValues) || null;

  logRecords.push({
    body: 'session report',
    timestampMs: report.startedAt || report.timestamp || 0,
    attributes: {
      ...commonAttrs,
      'session.options': report.options || {},
      'session.report_timestamp': report.timestamp,
      agent_name: agentName,
      usage,
    },
  });

  let lastTimestamp = 0;
  for (const item of report.chatHistory.items) {
    if (!item) continue;

    const hasValidTimestamp = Number.isFinite(item.createdAt);
    let itemTimestamp = hasValidTimestamp ? item.createdAt : Date.now();

    if (itemTimestamp <= lastTimestamp) {
      itemTimestamp = lastTimestamp + 0.001;
    }
    lastTimestamp = itemTimestamp;

    const itemProto = chatItemToProto(item);
    let severityNumber = SeverityNumber.UNSPECIFIED;
    let severityText = 'unspecified';

    if (item.type === 'function_call_output' && item.isError) {
      severityNumber = SeverityNumber.ERROR;
      severityText = 'error';
    }

    logRecords.push({
      body: 'chat item',
      timestampMs: itemTimestamp,
      attributes: { 'chat.item': itemProto, ...commonAttrs },
      severityNumber,
      severityText,
    });
  }

  await logExporter.export(logRecords);

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set for session upload');
  }

  const token = new AccessToken(apiKey, apiSecret, { ttl: '6h' });
  token.addObservabilityGrant({ write: true });
  const jwt = await token.toJwt();

  const formData = new FormData();

  const audioStartTime = report.audioRecordingStartedAt ?? 0;
  const headerMsg = new MetricsRecordingHeader({
    roomId: report.roomId,
    duration: BigInt(0),
    startTime: {
      seconds: BigInt(Math.floor(audioStartTime / 1000)),
      nanos: Math.floor((audioStartTime % 1000) * 1e6),
    },
  });

  const headerBytes = Buffer.from(headerMsg.toBinary());
  formData.append('header', headerBytes, {
    filename: 'header.binpb',
    contentType: 'application/protobuf',
    knownLength: headerBytes.length,
    header: {
      'Content-Type': 'application/protobuf',
      'Content-Length': headerBytes.length.toString(),
    },
  });

  const chatHistoryJson = JSON.stringify(report.chatHistory.toJSON({ excludeTimestamp: false }));
  const chatHistoryBuffer = Buffer.from(chatHistoryJson, 'utf-8');
  formData.append('chat_history', chatHistoryBuffer, {
    filename: 'chat_history.json',
    contentType: 'application/json',
    knownLength: chatHistoryBuffer.length,
    header: {
      'Content-Type': 'application/json',
      'Content-Length': chatHistoryBuffer.length.toString(),
    },
  });

  if (report.audioRecordingPath && report.audioRecordingStartedAt) {
    let audioBytes: Buffer;
    try {
      audioBytes = await fs.readFile(report.audioRecordingPath);
    } catch {
      audioBytes = Buffer.alloc(0);
    }

    if (audioBytes.length > 0) {
      formData.append('audio', audioBytes, {
        filename: 'recording.ogg',
        contentType: 'audio/ogg',
        knownLength: audioBytes.length,
        header: {
          'Content-Type': 'audio/ogg',
          'Content-Length': audioBytes.length.toString(),
        },
      });
    }
  }

  return new Promise<void>((resolve, reject) => {
    formData.submit(
      {
        protocol: 'https:',
        host: cloudHostname,
        path: '/observability/recordings/v0',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      },
      (err, res) => {
        if (err) {
          reject(new Error(`Failed to upload session report: ${err.message}`));
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk.toString();
          });
          res.on('error', (readErr) => {
            reject(
              new Error(
                `Failed to upload session report: ${res.statusCode} ${res.statusMessage} (body read error: ${readErr.message})`,
              ),
            );
          });
          res.on('end', () => {
            reject(
              new Error(
                `Failed to upload session report: ${res.statusCode} ${res.statusMessage} - ${body}`,
              ),
            );
          });
          return;
        }

        res.resume();
        res.on('error', (readErr) => reject(new Error(`Response read error: ${readErr.message}`)));
        res.on('end', () => resolve());
      },
    );
  });
}
