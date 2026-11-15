// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const primaryLLM = new openai.LLM({ model: 'gpt-4o' });
    const secondaryLLM = new openai.LLM({ model: 'gpt-4o-mini' });

    const fallbackLLM = new llm.FallbackAdapter({
      llms: [primaryLLM, secondaryLLM],
      attemptTimeout: 10.0,
      maxRetryPerLLM: 1,
      retryInterval: 0.5,
      retryOnChunkSent: false,
    });

    (fallbackLLM as llm.FallbackAdapter).on(
      'llm_availability_changed' as 'metrics_collected',
      (event: unknown) => {
        const e = event as llm.AvailabilityChangedEvent;
        if (e.available) {
          console.log(`LLM ${e.llm.label()} recovered and is now available`);
        } else {
          console.log(`LLM ${e.llm.label()} failed and is now unavailable`);
        }
      },
    );

    const agent = new voice.Agent({
      instructions:
        'You are a helpful assistant. Demonstrate that you are working by responding to user queries.',
      tools: {
        getWeather: llm.tool({
          description: 'Get the weather for a given location.',
          parameters: z.object({
            location: z.string().describe('The location to get the weather for'),
          }),
          execute: async ({ location }) => {
            return `The weather in ${location} is sunny with a temperature of 72°F.`;
          },
        }),
      },
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new deepgram.STT(),
      tts: new elevenlabs.TTS(),
      llm: fallbackLLM,
    });

    await session.start({
      agent,
      room: ctx.room,
    });

    session.say('Hello! I am a voice agent with LLM fallback support. How can I help you today?');

    const participant = await ctx.waitForParticipant();
    console.log('Participant joined:', participant.identity);
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
