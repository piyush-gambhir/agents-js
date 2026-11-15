// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Attributes } from '@opentelemetry/api';
import type { LogRecordProcessor, SdkLogRecord } from '@opentelemetry/sdk-logs';

export class MetadataLogProcessor implements LogRecordProcessor {
  private metadata: Attributes;

  constructor(metadata: Attributes) {
    this.metadata = metadata;
  }

  onEmit(logRecord: SdkLogRecord): void {
    if (logRecord.attributes) {
      Object.assign(logRecord.attributes, this.metadata);
    } else {
      (logRecord as any).attributes = { ...this.metadata };
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

export class ExtraDetailsProcessor implements LogRecordProcessor {
  onEmit(logRecord: SdkLogRecord): void {
    const loggerName = logRecord.instrumentationScope.name;
    if (logRecord.attributes) {
      (logRecord.attributes as any)['logger.name'] = loggerName;
    } else {
      (logRecord as any).attributes = { 'logger.name': loggerName };
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
