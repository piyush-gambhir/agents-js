// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Throws } from '@livekit/throws-transformer/throws';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import type { ChatContext } from './chat_context.js';
import type { ChatChunk } from './llm.js';
import { LLM, LLMStream } from './llm.js';
import type { ToolChoice, ToolContext } from './tool_context.js';

const DEFAULT_FALLBACK_API_CONNECT_OPTIONS: APIConnectOptions = {
  maxRetry: 0,
  timeoutMs: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
  retryIntervalMs: DEFAULT_API_CONNECT_OPTIONS.retryIntervalMs,
};

interface LLMStatus {
  available: boolean;
  recoveringTask: Promise<void> | null;
}

export interface AvailabilityChangedEvent {
  llm: LLM;
  available: boolean;
}

export interface FallbackAdapterOptions {
  llms: LLM[];
  attemptTimeout?: number;
  maxRetryPerLLM?: number;
  retryInterval?: number;
  retryOnChunkSent?: boolean;
}

/**
 * FallbackAdapter is an LLM that can fallback to a different LLM if the current LLM fails.
 *
 * @example
 * ```typescript
 * const fallbackLLM = new FallbackAdapter({
 *   llms: [primaryLLM, secondaryLLM, tertiaryLLM],
 *   attemptTimeout: 5.0,
 *   maxRetryPerLLM: 1,
 * });
 * ```
 */
export class FallbackAdapter extends LLM {
  readonly llms: LLM[];
  readonly attemptTimeout: number;
  readonly maxRetryPerLLM: number;
  readonly retryInterval: number;
  readonly retryOnChunkSent: boolean;

  /** @internal */
  _status: LLMStatus[];

  private logger = log();

  constructor(options: FallbackAdapterOptions) {
    super();

    if (!options.llms || options.llms.length < 1) {
      throw new Error('at least one LLM instance must be provided.');
    }

    this.llms = options.llms;
    this.attemptTimeout = options.attemptTimeout ?? 5.0;
    this.maxRetryPerLLM = options.maxRetryPerLLM ?? 0;
    this.retryInterval = options.retryInterval ?? 0.5;
    this.retryOnChunkSent = options.retryOnChunkSent ?? false;

    this._status = this.llms.map(() => ({
      available: true,
      recoveringTask: null,
    }));

    for (const llm of this.llms) {
      llm.on('metrics_collected', (metrics) => {
        this.emit('metrics_collected', metrics);
      });
    }
  }

  get model(): string {
    return 'FallbackAdapter';
  }

  label(): string {
    return 'FallbackAdapter';
  }

  chat(opts: {
    chatCtx: ChatContext;
    toolCtx?: ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    return new FallbackLLMStream(this, {
      chatCtx: opts.chatCtx,
      toolCtx: opts.toolCtx,
      connOptions: opts.connOptions || DEFAULT_FALLBACK_API_CONNECT_OPTIONS,
      parallelToolCalls: opts.parallelToolCalls,
      toolChoice: opts.toolChoice,
      extraKwargs: opts.extraKwargs,
    });
  }

  /**
   * Emit availability changed event.
   * @internal
   */
  _emitAvailabilityChanged(llm: LLM, available: boolean): void {
    const event: AvailabilityChangedEvent = { llm, available };
    (this as unknown as { emit: (event: string, data: AvailabilityChangedEvent) => void }).emit(
      'llm_availability_changed',
      event,
    );
  }
}

class FallbackLLMStream extends LLMStream {
  private adapter: FallbackAdapter;
  private parallelToolCalls?: boolean;
  private toolChoice?: ToolChoice;
  private extraKwargs?: Record<string, unknown>;
  private _currentStream?: LLMStream;
  private _log = log();

  constructor(
    adapter: FallbackAdapter,
    opts: {
      chatCtx: ChatContext;
      toolCtx?: ToolContext;
      connOptions: APIConnectOptions;
      parallelToolCalls?: boolean;
      toolChoice?: ToolChoice;
      extraKwargs?: Record<string, unknown>;
    },
  ) {
    super(adapter, {
      chatCtx: opts.chatCtx,
      toolCtx: opts.toolCtx,
      connOptions: opts.connOptions,
    });
    this.adapter = adapter;
    this.parallelToolCalls = opts.parallelToolCalls;
    this.toolChoice = opts.toolChoice;
    this.extraKwargs = opts.extraKwargs;
  }

  override get chatCtx(): ChatContext {
    return this._currentStream?.chatCtx ?? super.chatCtx;
  }

  /**
   * Try to generate with a single LLM.
   * Returns an async generator that yields chunks.
   * @throws {APIError} When the LLM returns an API error (retryable or not)
   */
  private async *tryGenerate(
    llm: LLM,
    checkRecovery: boolean = false,
  ): AsyncGenerator<Throws<ChatChunk, APIError>, void, unknown> {
    const connOptions: APIConnectOptions = {
      ...this.connOptions,
      maxRetry: this.adapter.maxRetryPerLLM,
      timeoutMs: this.adapter.attemptTimeout * 1000,
      retryIntervalMs: this.adapter.retryInterval * 1000,
    };

    const stream = llm.chat({
      chatCtx: super.chatCtx,
      toolCtx: this.toolCtx,
      connOptions,
      parallelToolCalls: this.parallelToolCalls,
      toolChoice: this.toolChoice,
      extraKwargs: this.extraKwargs,
    });

    let streamError: Error | undefined;
    const errorHandler = (ev: { error: Error }) => {
      streamError = ev.error;
    };
    llm.on('error', errorHandler);

    try {
      let shouldSetCurrent = !checkRecovery;
      for await (const chunk of stream) {
        if (shouldSetCurrent) {
          shouldSetCurrent = false;
          this._currentStream = stream;
        }
        yield chunk;
      }

      if (streamError) {
        throw streamError;
      }
    } catch (error) {
      if (error instanceof APIError) {
        if (checkRecovery) {
          this._log.warn({ llm: llm.label(), error }, 'recovery failed');
        } else {
          this._log.warn({ llm: llm.label(), error }, 'failed, switching to next LLM');
        }
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        if (checkRecovery) {
          this._log.warn({ llm: llm.label() }, 'recovery timed out');
        } else {
          this._log.warn({ llm: llm.label() }, 'timed out, switching to next LLM');
        }
        throw error;
      }

      if (checkRecovery) {
        this._log.error({ llm: llm.label(), error }, 'recovery unexpected error');
      } else {
        this._log.error({ llm: llm.label(), error }, 'unexpected error, switching to next LLM');
      }
      throw error;
    } finally {
      llm.off('error', errorHandler);
    }
  }

  private tryRecovery(llm: LLM, index: number): void {
    const status = this.adapter._status[index]!;

    if (status.recoveringTask !== null) {
      return;
    }

    const recoverTask = async (): Promise<void> => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _chunk of this.tryGenerate(llm, true)) {
        }

        status.available = true;
        this._log.info({ llm: llm.label() }, 'LLM recovered');
        this.adapter._emitAvailabilityChanged(llm, true);
      } catch {
      } finally {
        status.recoveringTask = null;
      }
    };

    status.recoveringTask = recoverTask();
  }

  /**
   * Main run method - iterates through LLMs with fallback logic.
   * @throws {APIConnectionError} When all LLM providers have been exhausted
   */
  protected async run(): Promise<Throws<void, APIConnectionError>> {
    const startTime = Date.now();

    const allFailed = this.adapter._status.every((s) => !s.available);
    if (allFailed) {
      this._log.error('all LLMs are unavailable, retrying...');
    }

    for (let i = 0; i < this.adapter.llms.length; i++) {
      const llm = this.adapter.llms[i]!;
      const status = this.adapter._status[i]!;

      this._log.debug(
        { llm: llm.label(), index: i, available: status.available, allFailed },
        'checking LLM',
      );

      if (status.available || allFailed) {
        let textSent = '';
        const toolCallsSent: string[] = [];

        try {
          this._log.info({ llm: llm.label() }, 'FallbackAdapter: Attempting provider');

          let chunkCount = 0;
          for await (const chunk of this.tryGenerate(llm, false)) {
            chunkCount++;
            if (chunk.delta) {
              if (chunk.delta.content) {
                textSent += chunk.delta.content;
              }
              if (chunk.delta.toolCalls) {
                for (const tc of chunk.delta.toolCalls) {
                  if (tc.name) {
                    toolCallsSent.push(tc.name);
                  }
                }
              }
            }

            this._log.debug({ llm: llm.label(), chunkCount }, 'run: forwarding chunk to queue');
            this.queue.put(chunk);
          }

          this._log.info(
            { llm: llm.label(), totalChunks: chunkCount, textLength: textSent.length },
            'FallbackAdapter: Provider succeeded',
          );
          return;
        } catch (error) {
          if (status.available) {
            status.available = false;
            this.adapter._emitAvailabilityChanged(llm, false);
          }

          this.tryRecovery(llm, i);

          if (textSent || toolCallsSent.length > 0) {
            const extra = { textSent, toolCallsSent };

            if (!this.adapter.retryOnChunkSent) {
              this._log.error(
                { llm: llm.label(), ...extra },
                'failed after sending chunk, skip retrying. Set `retryOnChunkSent` to `true` to enable.',
              );
              throw error;
            }

            this._log.warn(
              { llm: llm.label(), ...extra },
              'failed after sending chunk, retrying...',
            );
          }
        }
      }
    }

    const duration = (Date.now() - startTime) / 1000;
    const labels = this.adapter.llms.map((l) => l.label()).join(', ');
    throw new APIConnectionError({
      message: `all LLMs failed (${labels}) after ${duration.toFixed(2)}s`,
    });
  }
}
