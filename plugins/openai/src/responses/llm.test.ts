// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm as agentsLlm } from '@livekit/agents';
import { llm, llmStrict } from '@livekit/agents-plugins-test';
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { LLM } from './llm.js';

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);

// Minimal async-iterable stub that yields a single response.completed event,
// letting LLMStream terminate without ever touching the network.
function makeFakeStream(): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'response.completed',
        response: {
          id: 'resp_test',
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        },
      } as unknown as OpenAI.Responses.ResponseStreamEvent;
    },
  };
}

describe('OpenAI Responses HTTP — option wiring', () => {
  it('forwards maxOutputTokens as max_output_tokens to responses.create', async () => {
    const create = vi.fn().mockResolvedValue(makeFakeStream());
    const mockClient = { responses: { create } } as unknown as OpenAI;

    const model = new LLM({
      model: 'gpt-4.1',
      useWebSocket: false,
      client: mockClient,
      maxOutputTokens: 128,
    });

    const ctx = agentsLlm.ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'hi' });

    const stream = model.chat({ chatCtx: ctx });
    for await (const _ of stream) {
      // drain
    }

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({ max_output_tokens: 128 });
  });

  it('omits max_output_tokens when maxOutputTokens is not set', async () => {
    const create = vi.fn().mockResolvedValue(makeFakeStream());
    const mockClient = { responses: { create } } as unknown as OpenAI;

    const model = new LLM({
      model: 'gpt-4.1',
      useWebSocket: false,
      client: mockClient,
    });

    const ctx = agentsLlm.ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'hi' });

    const stream = model.chat({ chatCtx: ctx });
    for await (const _ of stream) {
      // drain
    }

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('max_output_tokens');
  });
});

if (hasOpenAIApiKey) {
  describe('OpenAI Responses', async () => {
    await llm(
      new LLM({
        temperature: 0,
        strictToolSchema: false,
      }),
      true,
    );
  });
} else {
  describe('OpenAI Responses', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}

if (hasOpenAIApiKey) {
  describe('OpenAI Responses strict tool schema', async () => {
    await llmStrict(
      new LLM({
        temperature: 0,
        strictToolSchema: true,
      }),
    );
  });
} else {
  describe('OpenAI Responses strict tool schema', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}
