// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { expect, it } from 'vitest';
import { MetadataSpanProcessor } from './traces.js';

it('exports custom-provider metadata with constructor-configured processors', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [
      new MetadataSpanProcessor({ room_id: 'room123', job_id: 'job456' }),
      new SimpleSpanProcessor(exporter),
    ],
  });
  try {
    provider.getTracer('metadata-regression').startSpan('test').end();
    await provider.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0]?.attributes).toMatchObject({
      room_id: 'room123',
      job_id: 'job456',
    });
  } finally {
    await provider.shutdown();
  }
});
