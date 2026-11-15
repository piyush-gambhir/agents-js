// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  log,
  metrics,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        "You are a helpful assistant, you can hear the user's message and respond to it.",
      tools: {
        getWeather: llm.tool({
          description: 'Get the weather for a given location.',
          parameters: z.object({
            location: z.string().describe('The location to get the weather for'),
          }),
          execute: async ({ location }) => {
            return `The weather in ${location} is sunny.`;
          },
        }),
      },
    });

    const logger = log();

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'en',
        fallback: ['assemblyai/universal-streaming', 'cartesia/ink-whisper'],
      }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
        fallback: [
          { model: 'elevenlabs/eleven_flash_v2', voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc' },
          'rime/arcana',
        ],
      }),
      preemptiveGeneration: true,
      turnHandling: {
        turnDetection: new livekit.turnDetector.MultilingualModel(),
        interruption: {
          resumeFalseInterruption: true,
          falseInterruptionTimeout: 1,
          mode: 'adaptive',
        },
      },
      useTtsAlignedTranscript: true,
      aecWarmupDuration: 3000,
      connOptions: {
        llmConnOptions: {
          maxRetry: 1,
          retryIntervalMs: 2000,
          timeoutMs: 60000,
        },
      },
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

    session.on(voice.AgentSessionEventTypes.OverlappingSpeech, (ev) => {
      logger.warn({ type: ev.type, isInterruption: ev.isInterruption }, 'user overlapping speech');
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
