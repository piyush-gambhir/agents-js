// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import { AsyncIterableQueue } from '../utils.js';

// prettier-ignore
export const PUNCTUATIONS = [
  '!', '"', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/', ':', ';', '<', '=',
  '>', '?', '@', '[', '\\', ']', '^', '_', '`', '{', '|', '}', '~', '±', '—', '‘', '’', '“', '”',
  '…',
]

export interface TokenData {
  segmentId: string;
  token: string;
}

export abstract class SentenceTokenizer {
  abstract tokenize(text: string, language?: string): string[];

  /**
   * Returns a {@link SentenceStream} that can be used to push strings and receive smaller segments.
   */
  abstract stream(): SentenceStream;
}

export abstract class SentenceStream {
  protected static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');
  protected input = new AsyncIterableQueue<string | typeof SentenceStream.FLUSH_SENTINEL>();
  protected queue = new AsyncIterableQueue<TokenData>();
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  pushText(text: string) {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.#closed) {
      throw new Error('Stream is closed');
    }
    this.input.put(text);
  }

  flush() {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.#closed) {
      throw new Error('Stream is closed');
    }
    this.input.put(SentenceStream.FLUSH_SENTINEL);
  }

  endInput() {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.#closed) {
      throw new Error('Stream is closed');
    }
    this.input.close();
  }

  next(): Promise<IteratorResult<TokenData>> {
    return this.queue.next();
  }

  close() {
    this.input.close();
    this.queue.close();
    this.#closed = true;
  }

  [Symbol.asyncIterator](): SentenceStream {
    return this;
  }
}

export abstract class WordTokenizer {
  abstract tokenize(text: string, language?: string): string[];

  /**
   * Returns a {@link WordStream} that can be used to push words and receive smaller segments.
   */
  abstract stream(): WordStream;
}

export abstract class WordStream {
  protected static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');
  protected input = new AsyncIterableQueue<string | typeof WordStream.FLUSH_SENTINEL>();
  protected queue = new AsyncIterableQueue<TokenData>();
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  pushText(text: string) {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.#closed) {
      throw new Error('Stream is closed');
    }
    this.input.put(text);
  }

  flush() {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.#closed) {
      throw new Error('Stream is closed');
    }
    this.input.put(WordStream.FLUSH_SENTINEL);
  }

  endInput() {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.#closed) {
      throw new Error('Stream is closed');
    }
    this.input.close();
  }

  next(): Promise<IteratorResult<TokenData>> {
    return this.queue.next();
  }

  close() {
    this.input.close();
    this.queue.close();
    this.#closed = true;
  }

  [Symbol.asyncIterator](): WordStream {
    return this;
  }
}
