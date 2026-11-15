// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  log,
  metrics,
  voice,
} from '@livekit/agents';
import * as inworld from '@livekit/agents-plugin-inworld';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        "You are a helpful assistant, you can hear the user's message and respond to it in 1-2 short sentences.",
    });

    const logger = log();
    const tts = new inworld.TTS({
      timestampType: 'WORD',
      voice: 'Hades',
      model: 'inworld-tts-1',
      encoding: 'LINEAR16',
      textNormalization: 'ON',
      bitRate: 64000,
      sampleRate: 24000,
      speakingRate: 1.0,
      temperature: 1.1,
      bufferCharThreshold: 100,
      maxBufferDelayMs: 3000,
    });

    tts
      .listVoices()
      .then((voices: inworld.Voice[]) => {
        console.log(`[Inworld TTS] ${voices.length} voices available in this workspace`);
        if (voices.length > 0) {
          console.log(
            '[Inworld TTS] Logging information for first voice:',
            JSON.stringify(voices[0], null, 2),
          );
        }
      })
      .catch((err: Error) => {
        console.error('[Inworld TTS] Failed to list voices:', err);
      });

    const session = new voice.AgentSession({
      stt: 'assemblyai/universal-streaming:en',
      llm: 'openai/gpt-4.1-mini',
      tts,
      vad: ctx.proc.userData.vad! as silero.VAD,
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      voiceOptions: {
        preemptiveGeneration: true,
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session.tts!.on('alignment' as any, (data: any) => {
      if (data.wordAlignment) {
        const { words, starts, ends } = data.wordAlignment;
        for (let i = 0; i < words.length; i++) {
          console.log(`[Inworld TTS] Word: "${words[i]}", Start: ${starts[i]}, End: ${ends[i]}`);
        }
      }
      if (data.characterAlignment) {
        const { chars, starts, ends } = data.characterAlignment;
        for (let i = 0; i < chars.length; i++) {
          console.log(`[Inworld TTS] Char: "${chars[i]}", Start: ${starts[i]}, End: ${ends[i]}`);
        }
      }
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
    });

    ctx.addShutdownCallback(async () => {
      logger.info(
        {
          usage: session.usage,
        },
        'Session usage summary',
      );
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });

    session.say('Hello, how can I help you today?');
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
