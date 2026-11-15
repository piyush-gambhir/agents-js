// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import type {
  AgentHandoffItem,
  ChatMessage,
  ChatRole,
  FunctionCall,
  FunctionCallOutput,
} from '../../llm/chat_context.js';
import type { Agent } from '../agent.js';

export interface ChatMessageEvent {
  type: 'message';
  item: ChatMessage;
}

export interface FunctionCallEvent {
  type: 'function_call';
  item: FunctionCall;
}

export interface FunctionCallOutputEvent {
  type: 'function_call_output';
  item: FunctionCallOutput;
}

export interface AgentHandoffEvent {
  type: 'agent_handoff';
  item: AgentHandoffItem;
  oldAgent?: Agent;
  newAgent: Agent;
}

export type RunEvent =
  | ChatMessageEvent
  | FunctionCallEvent
  | FunctionCallOutputEvent
  | AgentHandoffEvent;

export function isChatMessageEvent(event: RunEvent): event is ChatMessageEvent {
  return event.type === 'message';
}

export function isFunctionCallEvent(event: RunEvent): event is FunctionCallEvent {
  return event.type === 'function_call';
}

export function isFunctionCallOutputEvent(event: RunEvent): event is FunctionCallOutputEvent {
  return event.type === 'function_call_output';
}

export function isAgentHandoffEvent(event: RunEvent): event is AgentHandoffEvent {
  return event.type === 'agent_handoff';
}

export interface MessageAssertOptions {
  role?: ChatRole;
}

export interface FunctionCallAssertOptions {
  name?: string;
  args?: Record<string, unknown>;
}

export interface FunctionCallOutputAssertOptions {
  output?: string;
  isError?: boolean;
}

export interface AgentHandoffAssertOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newAgentType?: new (...args: any[]) => Agent;
}

export type EventType = 'message' | 'function_call' | 'function_call_output' | 'agent_handoff';
