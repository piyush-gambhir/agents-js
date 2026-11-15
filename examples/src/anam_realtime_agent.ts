// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  initializeLogger,
  voice,
} from '@livekit/agents';
import * as anam from '@livekit/agents-plugin-anam';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    initializeLogger({ pretty: true });

    const agent = new voice.Agent({
      instructions: 'You are a helpful assistant. Speak clearly and concisely.',
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'en' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      llm: new openai.realtime.RealtimeModel({
        voice: 'alloy',
        turnDetection: null,
        inputAudioTranscription: null,
      }),
      turnDetection: new livekit.turnDetector.EnglishModel(),
    });

    await session.start({
      agent,
      room: ctx.room,
      outputOptions: {
        syncTranscription: false,
      },
    });

    await ctx.connect();

    const personaName = process.env.ANAM_PERSONA_NAME ?? 'Agent';
    const avatarId = process.env.ANAM_AVATAR_ID;
    if (!avatarId) {
      throw new Error('ANAM_AVATAR_ID is required');
    }

    const avatar = new anam.AvatarSession({
      personaConfig: { name: personaName, avatarId },
      apiUrl: process.env.ANAM_API_URL,
    });
    await avatar.start(session, ctx.room);

    session.generateReply({
      instructions: 'Greet the user briefly and confirm you are ready.',
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
