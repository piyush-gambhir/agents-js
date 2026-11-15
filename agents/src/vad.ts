// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import type {
  ReadableStream,
  ReadableStreamDefaultReader,
  WritableStreamDefaultWriter,
} from 'node:stream/web';
import { log } from './log.js';
import type { VADMetrics } from './metrics/base.js';
import { DeferredReadableStream } from './stream/deferred_stream.js';
import { IdentityTransform } from './stream/identity_transform.js';

export enum VADEventType {
  START_OF_SPEECH,
  INFERENCE_DONE,
  END_OF_SPEECH,
  METRICS_COLLECTED,
}

export interface VADEvent {
  type: VADEventType;
  samplesIndex: number;
  timestamp: number;
  speechDuration: number;
  silenceDuration: number;
  frames: AudioFrame[];
  probability: number;
  inferenceDuration: number;
  speaking: boolean;
  rawAccumulatedSilence: number;
  rawAccumulatedSpeech: number;
}

export interface VADCapabilities {
  updateInterval: number;
}

export type VADCallbacks = {
  ['metrics_collected']: (metrics: VADMetrics) => void;
};

export abstract class VAD extends (EventEmitter as new () => TypedEmitter<VADCallbacks>) {
  #capabilities: VADCapabilities;
  abstract label: string;

  constructor(capabilities: VADCapabilities) {
    super();
    this.#capabilities = capabilities;
  }

  get capabilities(): VADCapabilities {
    return this.#capabilities;
  }

  /**
   * Returns a {@link VADStream} that can be used to push audio frames and receive VAD events.
   */
  abstract stream(): VADStream;

  async close(): Promise<void> {
    return;
  }
}

export abstract class VADStream implements AsyncIterableIterator<VADEvent> {
  protected static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');
  protected input = new IdentityTransform<AudioFrame | typeof VADStream.FLUSH_SENTINEL>();
  protected output = new IdentityTransform<VADEvent>();
  protected inputWriter: WritableStreamDefaultWriter<AudioFrame | typeof VADStream.FLUSH_SENTINEL>;
  protected inputReader: ReadableStreamDefaultReader<AudioFrame | typeof VADStream.FLUSH_SENTINEL>;
  protected outputWriter: WritableStreamDefaultWriter<VADEvent>;
  protected outputReader: ReadableStreamDefaultReader<VADEvent>;
  protected closed = false;
  protected inputClosed = false;

  protected vad: VAD;
  protected lastActivityTime = BigInt(0);
  protected logger;
  protected deferredInputStream: DeferredReadableStream<AudioFrame>;

  private metricsStream: ReadableStream<VADEvent>;
  constructor(vad: VAD) {
    this.logger = log();
    this.vad = vad;
    this.deferredInputStream = new DeferredReadableStream<AudioFrame>();

    this.inputWriter = this.input.writable.getWriter();
    this.inputReader = this.input.readable.getReader();
    this.outputWriter = this.output.writable.getWriter();

    const [outputStream, metricsStream] = this.output.readable.tee();
    this.metricsStream = metricsStream;
    this.outputReader = outputStream.getReader();

    this.pumpDeferredStream();
    this.monitorMetrics();
  }

  private async pumpDeferredStream() {
    const reader = this.deferredInputStream.stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await this.inputWriter.write(value);
      }
    } catch (e) {
      this.logger.error(`Error pumping deferred stream: ${e}`);
      throw e;
    } finally {
      reader.releaseLock();
    }
  }

  protected async monitorMetrics() {
    let inferenceDurationTotalMs = 0;
    let inferenceCount = 0;
    const metricsReader = this.metricsStream.getReader();
    while (true) {
      const { done, value } = await metricsReader.read();
      if (done) {
        break;
      }
      switch (value.type) {
        case VADEventType.START_OF_SPEECH:
          inferenceCount++;
          if (inferenceCount >= 1000 / this.vad.capabilities.updateInterval) {
            this.vad.emit('metrics_collected', {
              type: 'vad_metrics',
              timestamp: Date.now(),
              idleTimeMs: Math.trunc(
                Number((process.hrtime.bigint() - this.lastActivityTime) / BigInt(1000000)),
              ),
              inferenceDurationTotalMs,
              inferenceCount,
              label: this.vad.label,
            });

            inferenceCount = 0;
            inferenceDurationTotalMs = 0;
          }
          break;
        case VADEventType.INFERENCE_DONE:
          inferenceDurationTotalMs += Math.round(value.inferenceDuration);
          this.lastActivityTime = process.hrtime.bigint();
          break;
        case VADEventType.END_OF_SPEECH:
          this.lastActivityTime = process.hrtime.bigint();
          break;
      }
    }
  }

  /**
   * Safely send a VAD event to the output stream, handling writer release errors during shutdown.
   * @returns true if the event was sent, false if the stream is closing
   * @throws Error if an unexpected error occurs
   */
  protected sendVADEvent(event: VADEvent): boolean {
    if (this.closed) {
      return false;
    }

    try {
      this.outputWriter.write(event);
      return true;
    } catch (e) {
      throw e;
    }
  }

  updateInputStream(audioStream: ReadableStream<AudioFrame>) {
    this.deferredInputStream.setSource(audioStream);
  }

  detachInputStream() {
    this.deferredInputStream.detachSource();
  }

  /** @deprecated Use `updateInputStream` instead */
  pushFrame(frame: AudioFrame) {
    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.inputWriter.write(frame);
  }

  flush() {
    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.inputWriter.write(VADStream.FLUSH_SENTINEL);
  }

  endInput() {
    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.inputClosed = true;
    this.input.writable.close();
  }

  async next(): Promise<IteratorResult<VADEvent>> {
    return this.outputReader.read().then(({ done, value }) => {
      if (done) {
        return { done: true, value: undefined };
      }
      return { done: false, value };
    });
  }

  close() {
    this.outputWriter.releaseLock();
    this.outputReader.cancel();
    this.output.writable.close();
    this.closed = true;
  }

  [Symbol.asyncIterator](): VADStream {
    return this;
  }
}
