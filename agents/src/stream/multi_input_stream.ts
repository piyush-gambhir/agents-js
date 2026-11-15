// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import type {
  ReadableStream,
  ReadableStreamDefaultReader,
  WritableStreamDefaultWriter,
} from 'node:stream/web';
import { log } from '../log.js';
import { isStreamReaderReleaseError } from './deferred_stream.js';
import { IdentityTransform } from './identity_transform.js';

/**
 * A fan-in multiplexer that merges multiple {@link ReadableStream} inputs into
 * a single output {@link ReadableStream}. Inputs can be dynamically added and
 * removed at any time while the stream is open.
 *
 * Unlike {@link DeferredReadableStream} which supports a single readable source,
 * `MultiInputStream` allows N concurrent input streams to pump data into one output.
 *
 * Key behaviors:
 * - An error in one input removes that input but does **not** kill the output.
 * - When all inputs end or are removed, the output stays open (waiting for new inputs).
 * - The output only closes when {@link close} is called explicitly.
 * - {@link removeInputStream} releases the reader lock so the source can be reused.
 */
export class MultiInputStream<T> {
  private transform: IdentityTransform<T>;
  private writer: WritableStreamDefaultWriter<T>;
  private inputs: Map<string, ReadableStreamDefaultReader<T>> = new Map();
  private pumpPromises: Map<string, Promise<void>> = new Map();
  private nextId = 0;
  private _closed = false;
  private logger = log();

  constructor() {
    this.transform = new IdentityTransform<T>();
    this.writer = this.transform.writable.getWriter();
  }

  get stream(): ReadableStream<T> {
    return this.transform.readable;
  }

  get inputCount(): number {
    return this.inputs.size;
  }

  /** Whether {@link close} has been called. */
  get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Add an input {@link ReadableStream} that will be pumped into the output.
   *
   * @returns A unique identifier that can be passed to {@link removeInputStream}.
   * @throws If the stream has already been closed.
   */
  addInputStream(source: ReadableStream<T>): string {
    if (this._closed) {
      throw new Error('MultiInputStream is closed');
    }

    const id = `input-${this.nextId++}`;
    const reader = source.getReader();
    this.inputs.set(id, reader);

    const pumpDone = this.pumpInput(id, reader);
    this.pumpPromises.set(id, pumpDone);

    return id;
  }

  async removeInputStream(id: string): Promise<void> {
    const reader = this.inputs.get(id);
    if (!reader) return;

    this.inputs.delete(id);

    reader.releaseLock();

    const pump = this.pumpPromises.get(id);
    if (pump) {
      await pump;
      this.pumpPromises.delete(id);
    }
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    for (const reader of this.inputs.values()) {
      reader.releaseLock();
    }
    this.inputs.clear();

    await Promise.allSettled([...this.pumpPromises.values()]);
    this.pumpPromises.clear();

    try {
      this.writer.releaseLock();
    } catch {
    }

    try {
      await this.transform.writable.close();
    } catch {
    }
  }

  private shouldStopPumping(id: string): boolean {
    return this._closed || !this.inputs.has(id);
  }

  private async pumpInput(id: string, reader: ReadableStreamDefaultReader<T>): Promise<void> {
    try {
      while (true) {
        if (this.shouldStopPumping(id)) break;

        const { done, value } = await reader.read();
        if (done) break;

        if (this.shouldStopPumping(id)) break;

        await this.writer.write(value);
      }
    } catch (e) {
      if (isStreamReaderReleaseError(e)) {
        return;
      }

      this.logger.error({ error: e }, 'Error pumping input stream from MultiInputStream');
    } finally {
      try {
        reader.releaseLock();
      } catch {
      }

      this.inputs.delete(id);
      this.pumpPromises.delete(id);
    }
  }
}
