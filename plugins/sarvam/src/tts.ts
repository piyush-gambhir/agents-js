// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  AudioByteStream,
  log,
  normalizeLanguage,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';
import type {
  TTSLanguages,
  TTSModels,
  TTSSampleRates,
  TTSSpeakers,
  TTSV2Speakers,
  TTSV3Speakers,
} from './models.js';

const SARVAM_TTS_SAMPLE_RATE = 24000;
const SARVAM_TTS_CHANNELS = 1;
const SARVAM_BASE_URL = 'https://api.sarvam.ai';
const SARVAM_WS_URL_PATH = '/text-to-speech/ws';
const MIN_SENTENCE_LENGTH = 8;

interface TTSBaseOptions {
  apiKey?: string;
  streaming?: boolean;
  targetLanguageCode?: TTSLanguages | string;
  pace?: number;
  sampleRate?: TTSSampleRates | number;
  baseURL?: string;
  sentenceTokenizer?: tokenize.SentenceTokenizer;
}

export interface TTSV2Options extends TTSBaseOptions {
  model?: 'bulbul:v2';
  speaker?: TTSV2Speakers | string;
  pitch?: number;
  loudness?: number;
  enablePreprocessing?: boolean;
}

export interface TTSV3Options extends TTSBaseOptions {
  model: 'bulbul:v3';
  speaker?: TTSV3Speakers | string;
  temperature?: number;
}

export type TTSOptions = TTSV2Options | TTSV3Options;

interface ResolvedTTSOptions {
  apiKey: string;
  streaming: boolean;
  model: TTSModels;
  speaker: TTSSpeakers | string;
  targetLanguageCode: string;
  pace: number;
  sampleRate: number;
  baseURL: string;
  sentenceTokenizer: tokenize.SentenceTokenizer;
  pitch?: number;
  loudness?: number;
  enablePreprocessing?: boolean;
  temperature?: number;
}

const V2_DEFAULTS = {
  speaker: 'anushka' as const,
  pitch: 0,
  pace: 1.0,
  loudness: 1.0,
  enablePreprocessing: false,
};

const V3_DEFAULTS = {
  speaker: 'shubh' as const,
  pace: 1.0,
  temperature: 0.6,
};

function resolveOptions(opts: Partial<TTSOptions>): ResolvedTTSOptions {
  const apiKey = opts.apiKey ?? process.env.SARVAM_API_KEY;
  if (!apiKey) {
    throw new Error('Sarvam API key is required, whether as an argument or as $SARVAM_API_KEY');
  }

  const model: TTSModels = opts.model ?? 'bulbul:v2';
  const isV3 = model === 'bulbul:v3';

  const base: ResolvedTTSOptions = {
    apiKey,
    streaming: opts.streaming ?? true,
    model,
    speaker: opts.speaker ?? (isV3 ? V3_DEFAULTS.speaker : V2_DEFAULTS.speaker),
    targetLanguageCode: normalizeLanguage(opts.targetLanguageCode ?? 'en-IN'),
    pace: opts.pace ?? (isV3 ? V3_DEFAULTS.pace : V2_DEFAULTS.pace),
    sampleRate: opts.sampleRate ?? SARVAM_TTS_SAMPLE_RATE,
    baseURL: opts.baseURL ?? SARVAM_BASE_URL,
    sentenceTokenizer:
      opts.sentenceTokenizer ??
      new tokenize.basic.SentenceTokenizer({ minSentenceLength: MIN_SENTENCE_LENGTH }),
  };

  if (isV3) {
    base.temperature = (opts as TTSV3Options).temperature ?? V3_DEFAULTS.temperature;
  } else {
    const v2 = opts as TTSV2Options;
    base.pitch = v2.pitch ?? V2_DEFAULTS.pitch;
    base.loudness = v2.loudness ?? V2_DEFAULTS.loudness;
    base.enablePreprocessing = v2.enablePreprocessing ?? V2_DEFAULTS.enablePreprocessing;
  }

  return base;
}

function buildRequestBody(text: string, opts: ResolvedTTSOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    text,
    target_language_code: opts.targetLanguageCode,
    speaker: opts.speaker,
    model: opts.model,
    pace: opts.pace,
    speech_sample_rate: String(opts.sampleRate),
    output_audio_codec: 'wav',
  };

  if (opts.model === 'bulbul:v3') {
    if (opts.temperature != null) body.temperature = opts.temperature;
  } else {
    if (opts.pitch != null) body.pitch = opts.pitch;
    if (opts.loudness != null) body.loudness = opts.loudness;
    if (opts.enablePreprocessing != null) body.enable_preprocessing = opts.enablePreprocessing;
  }

  return body;
}

function buildWsConfigMessage(opts: ResolvedTTSOptions): string {
  const data: Record<string, unknown> = {
    target_language_code: opts.targetLanguageCode,
    speaker: opts.speaker,
    model: opts.model,
    pace: opts.pace,
    speech_sample_rate: String(opts.sampleRate),
    output_audio_codec: 'linear16',
  };

  if (opts.model === 'bulbul:v3') {
    if (opts.temperature != null) data.temperature = opts.temperature;
  } else {
    if (opts.pitch != null) data.pitch = opts.pitch;
    if (opts.loudness != null) data.loudness = opts.loudness;
    if (opts.enablePreprocessing != null) data.enable_preprocessing = opts.enablePreprocessing;
  }

  return JSON.stringify({ type: 'config', data });
}

export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  label = 'sarvam.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    const resolved = resolveOptions(opts);
    super(resolved.sampleRate, SARVAM_TTS_CHANNELS, { streaming: resolved.streaming });
    this.#opts = resolved;
  }

  updateOptions(opts: Partial<TTSOptions>) {
    const modelChanging = opts.model != null && opts.model !== this.#opts.model;

    const base: Partial<TTSOptions> = modelChanging
      ? {
          apiKey: this.#opts.apiKey,
          streaming: this.#opts.streaming,
          targetLanguageCode: this.#opts.targetLanguageCode as TTSLanguages,
          pace: this.#opts.pace,
          sampleRate: this.#opts.sampleRate as TTSSampleRates,
          baseURL: this.#opts.baseURL,
          sentenceTokenizer: this.#opts.sentenceTokenizer,
        }
      : ({ ...this.#opts } as Partial<TTSOptions>);

    this.#opts = resolveOptions({ ...base, ...opts } as TTSOptions);
  }

  /**
   * Synthesize text to audio using Sarvam AI TTS.
   *
   * @param text - Text to synthesize (max 2500 chars for v3, 1500 for v2)
   * @param connOptions - API connection options
   * @param abortSignal - Abort signal for cancellation
   * @returns A chunked stream of synthesized audio
   */
  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    if (!this.capabilities.streaming) {
      throw new Error(
        'Sarvam TTS streaming is disabled (`streaming: false`). Use synthesize() for REST or wrap with tts.StreamAdapter for streaming behavior.',
      );
    }
    return new SynthesizeStream(this, this.#opts);
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'sarvam.ChunkedStream';
  private opts: ResolvedTTSOptions;

  /** @internal */
  constructor(
    tts: TTS,
    text: string,
    opts: ResolvedTTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();

    const response = await fetch(`${this.opts.baseURL}/text-to-speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-subscription-key': this.opts.apiKey,
      },
      body: JSON.stringify(buildRequestBody(this.inputText, this.opts)),
      signal: this.abortSignal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Sarvam TTS API error ${response.status}: ${errorBody}`);
    }

    const data = (await response.json()) as { audios: string[] };
    const audioBase64 = data.audios[0];
    if (!audioBase64) {
      throw new Error('Sarvam TTS returned empty audio');
    }

    const raw = Buffer.from(audioBase64, 'base64');
    const pcmData = raw.buffer.slice(raw.byteOffset + 44, raw.byteOffset + raw.byteLength);

    const audioByteStream = new AudioByteStream(this.opts.sampleRate, SARVAM_TTS_CHANNELS);
    const frames = [...audioByteStream.write(pcmData), ...audioByteStream.flush()];

    let lastFrame: AudioFrame | undefined;
    const sendLastFrame = (segmentId: string, final: boolean) => {
      if (lastFrame) {
        this.queue.put({ requestId, segmentId, frame: lastFrame, final });
        lastFrame = undefined;
      }
    };

    for (const frame of frames) {
      sendLastFrame(requestId, false);
      lastFrame = frame;
    }
    sendLastFrame(requestId, true);

    this.queue.close();
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  private opts: ResolvedTTSOptions;
  private tokenizer: tokenize.SentenceStream;
  #logger = log();
  label = 'sarvam.SynthesizeStream';

  constructor(tts: TTS, opts: ResolvedTTSOptions) {
    super(tts);
    this.opts = opts;
    this.tokenizer = opts.sentenceTokenizer.stream();
  }

  private async closeWebSocket(ws: WebSocket): Promise<void> {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'flush' }));

        try {
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => resolve(), 1000);

            ws.once('message', () => {
              clearTimeout(timeout);
              resolve();
            });
            ws.once('close', () => {
              clearTimeout(timeout);
              resolve();
            });
            ws.once('error', () => {
              clearTimeout(timeout);
              resolve();
            });
          });
        } catch {}
      }
    } catch (e) {
      this.#logger.warn(`Error during WebSocket close sequence: ${e}`);
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  }

  protected async run() {
    const requestId = shortuuid();
    const segmentId = shortuuid();

    const wsBaseUrl = this.opts.baseURL.replace(/^http/, 'ws');
    const url = new URL(`${wsBaseUrl}${SARVAM_WS_URL_PATH}`);
    url.searchParams.set('model', this.opts.model);
    url.searchParams.set('send_completion_event', 'true');

    const ws = new WebSocket(url, {
      headers: {
        'api-subscription-key': this.opts.apiKey,
      },
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new Error(`Sarvam TTS WS connection error: ${error.message}`));
      };
      const onClose = (code: number) => {
        cleanup();
        reject(new Error(`Sarvam TTS WS closed during connect: ${code}`));
      };
      const cleanup = () => {
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onError);
        ws.removeListener('close', onClose);
      };
      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
    });

    ws.send(buildWsConfigMessage(this.opts));

    const inputTask = async () => {
      for await (const data of this.input) {
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          this.tokenizer.flush();
          continue;
        }
        this.tokenizer.pushText(data);
      }
      this.tokenizer.endInput();
      this.tokenizer.close();
    };

    const sendTask = async () => {
      for await (const event of this.tokenizer) {
        if (this.abortController.signal.aborted) break;

        const text = event.token;
        ws.send(JSON.stringify({ type: 'text', data: { text } }));
      }

      if (!this.abortController.signal.aborted) {
        ws.send(JSON.stringify({ type: 'flush' }));
      }
    };

    const recvTask = async () => {
      const bstream = new AudioByteStream(this.opts.sampleRate, SARVAM_TTS_CHANNELS);
      let finalReceived = false;
      let lastFrame: AudioFrame | undefined;

      const sendLastFrame = (final: boolean) => {
        if (lastFrame && !this.queue.closed) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      return new Promise<void>((resolve, reject) => {
        ws.on('message', (data: RawData) => {
          let msg: { type: string; data?: Record<string, unknown> };
          try {
            msg = JSON.parse(data.toString());
          } catch {
            this.#logger.warn('Sarvam WS: received non-JSON message');
            return;
          }

          switch (msg.type) {
            case 'audio': {
              const audioB64 = (msg.data?.audio as string) ?? '';
              if (!audioB64) break;

              const raw = Buffer.from(audioB64, 'base64');
              const pcm = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

              for (const frame of bstream.write(pcm as ArrayBuffer)) {
                sendLastFrame(false);
                lastFrame = frame;
              }
              break;
            }

            case 'event': {
              const eventType = msg.data?.event_type as string | undefined;
              if (eventType === 'final') {
                finalReceived = true;
                for (const frame of bstream.flush()) {
                  sendLastFrame(false);
                  lastFrame = frame;
                }
                sendLastFrame(true);

                if (!this.queue.closed) {
                  this.queue.put(SynthesizeStream.END_OF_STREAM);
                }
                resolve();
              }
              break;
            }

            case 'error': {
              const errMsg = (msg.data?.message as string) ?? 'Unknown Sarvam WS error';
              const errCode = msg.data?.code as number | undefined;
              reject(new Error(`Sarvam WS error ${errCode ?? ''}: ${errMsg}`));
              break;
            }
          }
        });

        ws.on('close', () => {
          if (!finalReceived) {
            for (const frame of bstream.flush()) {
              sendLastFrame(false);
              lastFrame = frame;
            }
            sendLastFrame(true);

            if (!this.queue.closed) {
              this.queue.put(SynthesizeStream.END_OF_STREAM);
            }
          }
          resolve();
        });

        ws.on('error', (error) => {
          reject(error);
        });
      });
    };

    try {
      await Promise.all([inputTask(), sendTask(), recvTask()]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Sarvam TTS streaming failed: ${msg}`);
    } finally {
      await this.closeWebSocket(ws);
    }
  }
}
