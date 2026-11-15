// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import type {
  ReadableStream,
  ReadableStreamDefaultReader,
  WritableStreamDefaultWriter,
} from 'node:stream/web';
import { IdentityTransform } from './identity_transform.js';

export function isStreamReaderReleaseError(e: unknown) {
  const allowedMessages = [
    'Invalid state: Releasing reader',
    'Invalid state: The reader is not attached to a stream',
    'Controller is already closed',
    'WritableStream is closed',
    'Stream reader cancelled via releaseLock()',
    'The reader was released.',
  ];

  if (e instanceof TypeError || (e instanceof Error && e.name === 'AbortError')) {
    return allowedMessages.some((message) => e.message.includes(message));
  }

  return false;
}
export class DeferredReadableStream<T> {
  private transform: IdentityTransform<T>;
  private writer: WritableStreamDefaultWriter<T>;
  private sourceReader?: ReadableStreamDefaultReader<T>;

  constructor() {
    this.transform = new IdentityTransform<T>();
    this.writer = this.transform.writable.getWriter();
  }

  get stream() {
    return this.transform.readable;
  }

  get isSourceSet() {
    return !!this.sourceReader;
  }

  setSource(source: ReadableStream<T>) {
    if (this.isSourceSet) {
      throw new Error('Stream source already set');
    }

    const sourceReader = source.getReader();
    this.sourceReader = sourceReader;
    void this.pump(sourceReader);
  }

  private async pump(sourceReader: ReadableStreamDefaultReader<T>) {
    let sourceError: unknown;

    try {
      while (true) {
        const { done, value } = await sourceReader.read();
        if (done) break;
        await this.writer.write(value);
      }
    } catch (e) {
      if (isStreamReaderReleaseError(e)) return;

      sourceError = e;
    } finally {
      if (sourceError) {
        try {
          await this.writer.abort(sourceError);
        } catch (e) {}
        return;
      }

      try {
        this.writer.releaseLock();
      } catch (e) {}

      try {
        await this.transform.writable.close();
      } catch (e) {}
    }
  }

  async detachSource() {
    if (!this.isSourceSet) {
      return;
    }

    const sourceReader = this.sourceReader!;
    this.sourceReader = undefined;

    try {
      sourceReader.releaseLock();
    } catch (e) {
      if (!isStreamReaderReleaseError(e)) {
        throw e;
      }
    }
  }
}
