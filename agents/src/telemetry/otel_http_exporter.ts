// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0

import { SeverityNumber } from '@opentelemetry/api-logs';
import { AccessToken } from 'livekit-server-sdk';

export interface SimpleLogRecord {
  body: string;
  timestampMs: number;
  attributes: Record<string, unknown>;
  severityNumber?: SeverityNumber;
  severityText?: string;
}

export interface SimpleOTLPHttpLogExporterConfig {
  cloudHostname: string;
  resourceAttributes: Record<string, string>;
  scopeName: string;
  scopeAttributes?: Record<string, string>;
}

/**
 * Simple OTLP HTTP Log Exporter for direct log export
 *
 * This is a simplified exporter that doesn't require the full SDK infrastructure.
 * Use this when you need to send logs directly without LoggerProvider.
 *
 * @example
 * ```typescript
 * const exporter = new SimpleOTLPHttpLogExporter({
 *   cloudHostname: 'cloud.livekit.io',
 *   resourceAttributes: { room_id: 'xxx', job_id: 'yyy' },
 *   scopeName: 'chat_history',
 * });
 *
 * await exporter.export([
 *   { body: 'Hello', timestampMs: Date.now(), attributes: { test: true } },
 * ]);
 * ```
 */
export class SimpleOTLPHttpLogExporter {
  private readonly config: SimpleOTLPHttpLogExporterConfig;
  private jwt: string | null = null;

  private static readonly FORCE_DOUBLE_KEYS = new Set([
    'transcriptConfidence',
    'transcriptionDelay',
    'endOfTurnDelay',
    'onUserTurnCompletedDelay',
    'llmNodeTtft',
    'ttsNodeTtfb',
    'e2eLatency',
  ]);

  constructor(config: SimpleOTLPHttpLogExporterConfig) {
    this.config = config;
  }

  async export(records: SimpleLogRecord[]): Promise<void> {
    if (records.length === 0) return;

    await this.ensureJwt();

    const endpoint = `https://${this.config.cloudHostname}/observability/logs/otlp/v0`;
    const payload = this.buildPayload(records);
    const payloadJson = JSON.stringify(payload);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.jwt}`,
        'Content-Type': 'application/json',
      },
      body: payloadJson,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `OTLP log export failed: ${response.status} ${response.statusText} - ${text}`,
      );
    }
  }

  private async ensureJwt(): Promise<void> {
    if (this.jwt) return;

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set');
    }

    const token = new AccessToken(apiKey, apiSecret, { ttl: '6h' });
    token.addObservabilityGrant({ write: true });
    this.jwt = await token.toJwt();
  }

  private buildPayload(records: SimpleLogRecord[]): object {
    const resourceAttrs = Object.entries(this.config.resourceAttributes).map(([key, value]) => ({
      key,
      value: { stringValue: value },
    }));

    if (!this.config.resourceAttributes['service.name']) {
      resourceAttrs.push({ key: 'service.name', value: { stringValue: 'livekit-agents' } });
    }

    const scopeAttrs = this.config.scopeAttributes
      ? Object.entries(this.config.scopeAttributes).map(([key, value]) => ({
          key,
          value: { stringValue: value },
        }))
      : [];

    const logRecords = records.map((record) => {
      const timestampMs = Number.isFinite(record.timestampMs) ? record.timestampMs : Date.now();
      return {
        timeUnixNano: String(BigInt(Math.floor(timestampMs * 1_000_000))),
        observedTimeUnixNano: String(BigInt(Date.now()) * BigInt(1_000_000)),
        severityNumber: record.severityNumber ?? SeverityNumber.UNSPECIFIED,
        severityText: record.severityText ?? 'unspecified',
        body: { stringValue: record.body },
        attributes: this.convertAttributes(record.attributes),
        traceId: '',
        spanId: '',
      };
    });

    return {
      resourceLogs: [
        {
          resource: { attributes: resourceAttrs },
          scopeLogs: [
            {
              scope: {
                name: this.config.scopeName,
                attributes: scopeAttrs,
              },
              logRecords,
            },
          ],
        },
      ],
    };
  }

  private convertAttributes(
    attrs: Record<string, unknown>,
  ): Array<{ key: string; value: unknown }> {
    return Object.entries(attrs).map(([key, value]) => ({
      key,
      value: this.convertValue(value, key),
    }));
  }

  private convertValue(value: unknown, path: string = ''): unknown {
    if (value === null || value === undefined) {
      return { stringValue: '' };
    }
    if (typeof value === 'string') {
      return { stringValue: value };
    }
    if (typeof value === 'number') {
      const leafKey =
        path
          .split('.')
          .pop()
          ?.replace(/\[\d+\]$/, '') ?? path;
      if (SimpleOTLPHttpLogExporter.FORCE_DOUBLE_KEYS.has(leafKey)) {
        return { doubleValue: value };
      }
      return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
    }
    if (typeof value === 'boolean') {
      return { boolValue: value };
    }
    if (Array.isArray(value)) {
      return {
        arrayValue: {
          values: value.map((v, i) => this.convertValue(v, `${path}[${i}]`)),
        },
      };
    }
    if (typeof value === 'object') {
      return {
        kvlistValue: {
          values: Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
            key: k,
            value: this.convertValue(v, path ? `${path}.${k}` : k),
          })),
        },
      };
    }
    return { stringValue: String(value) };
  }
}
