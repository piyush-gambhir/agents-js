// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { AudioFrame } from '@livekit/rtc-node';
import ffmpeg from 'fluent-ffmpeg';
import type { ReadableStream } from 'node:stream/web';
import { log } from './log.js';
import { createStreamChannel } from './stream/stream_channel.js';
import { type AudioBuffer, isFfmpegTeardownError } from './utils.js';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export interface AudioDecodeOptions {
  sampleRate?: number;
  numChannels?: number;
  format?: string;
  abortSignal?: AbortSignal;
}

export function calculateAudioDurationSeconds(frame: AudioBuffer) {
  return Array.isArray(frame)
    ? frame.reduce((sum, a) => sum + a.samplesPerChannel / a.sampleRate, 0)
    : frame.samplesPerChannel / frame.sampleRate;
}

export class AudioByteStream {
  #sampleRate: number;
  #numChannels: number;
  #bytesPerFrame: number;
  #buf: Int8Array;
  #logger = log();

  constructor(sampleRate: number, numChannels: number, samplesPerChannel: number | null = null) {
    this.#sampleRate = sampleRate;
    this.#numChannels = numChannels;

    if (samplesPerChannel === null) {
      samplesPerChannel = Math.floor(sampleRate / 10);
    }

    this.#bytesPerFrame = numChannels * samplesPerChannel * 2;
    this.#buf = new Int8Array();
  }

  write(data: ArrayBufferLike | ArrayBufferView): AudioFrame[] {
    const bytes = ArrayBuffer.isView(data)
      ? new Int8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Int8Array(data);
    this.#buf = new Int8Array([...this.#buf, ...bytes]);

    const frames: AudioFrame[] = [];
    while (this.#buf.length >= this.#bytesPerFrame) {
      const frameData = this.#buf.slice(0, this.#bytesPerFrame);
      this.#buf = this.#buf.slice(this.#bytesPerFrame);

      frames.push(
        new AudioFrame(
          new Int16Array(frameData.buffer),
          this.#sampleRate,
          this.#numChannels,
          frameData.length / 2,
        ),
      );
    }

    return frames;
  }

  flush(): AudioFrame[] {
    if (this.#buf.length % (2 * this.#numChannels) !== 0) {
      this.#logger.warn('AudioByteStream: incomplete frame during flush, dropping');
      return [];
    }

    const frames = [
      new AudioFrame(
        new Int16Array(this.#buf.buffer),
        this.#sampleRate,
        this.#numChannels,
        this.#buf.length / 2,
      ),
    ];

    this.#buf = new Int8Array();
    return frames;
  }
}

/**
 * Decode an audio file into AudioFrame instances
 *
 * @param filePath - Path to the audio file
 * @param options - Decoding options
 * @returns AsyncGenerator that yields AudioFrame objects
 *
 * @example
 * ```typescript
 * for await (const frame of audioFramesFromFile('audio.ogg', { sampleRate: 48000 })) {
 *   console.log('Frame:', frame.samplesPerChannel, 'samples');
 * }
 * ```
 */
export function audioFramesFromFile(
  filePath: string,
  options: AudioDecodeOptions = {},
): ReadableStream<AudioFrame> {
  const sampleRate = options.sampleRate ?? 48000;
  const numChannels = options.numChannels ?? 1;

  const audioStream = new AudioByteStream(sampleRate, numChannels);
  const channel = createStreamChannel<AudioFrame>();
  const logger = log();

  const command = ffmpeg(filePath)
    .inputOptions([
      '-probesize',
      '32',
      '-analyzeduration',
      '0',
      '-fflags',
      '+nobuffer+flush_packets',
      '-flags',
      'low_delay',
    ])
    .format('s16le')
    .audioChannels(numChannels)
    .audioFrequency(sampleRate);

  let commandRunning = true;

  const onClose = () => {
    logger.debug('Audio file playback aborted');

    channel.close();
    if (commandRunning) {
      commandRunning = false;
      command.kill('SIGKILL');
    }
  };

  command.on('error', (err: Error) => {
    if (isFfmpegTeardownError(err)) {
      logger.debug('FFmpeg command ended during shutdown');
    } else {
      logger.error(err, 'FFmpeg command error');
    }
    commandRunning = false;
    onClose();
  });

  const outputStream = command.pipe();
  options.abortSignal?.addEventListener('abort', onClose, { once: true });

  outputStream.on('data', (chunk: Buffer) => {
    const arrayBuffer = chunk.buffer.slice(
      chunk.byteOffset,
      chunk.byteOffset + chunk.byteLength,
    ) as ArrayBuffer;

    const frames = audioStream.write(arrayBuffer);
    for (const frame of frames) {
      channel.write(frame);
    }
  });

  outputStream.on('end', () => {
    const frames = audioStream.flush();
    for (const frame of frames) {
      channel.write(frame);
    }
    commandRunning = false;
    channel.close();
  });

  outputStream.on('error', (err: Error) => {
    logger.error(err);
    commandRunning = false;
    onClose();
  });

  return channel.stream();
}

/**
 * Loop audio frames from a file indefinitely
 *
 * @param filePath - Path to the audio file
 * @param options - Decoding options
 * @returns AsyncGenerator that yields AudioFrame objects in an infinite loop
 */
export async function* loopAudioFramesFromFile(
  filePath: string,
  options: AudioDecodeOptions = {},
): AsyncGenerator<AudioFrame, void, unknown> {
  const frames: AudioFrame[] = [];
  const logger = log();

  for await (const frame of audioFramesFromFile(filePath, options)) {
    frames.push(frame);
    yield frame;
  }

  while (!options.abortSignal?.aborted) {
    for (const frame of frames) {
      yield frame;
    }
  }

  logger.debug('Audio file playback loop finished');
}
