// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { ChatContext } from '../llm/chat_context.js';
import { type ModelUsage, filterZeroValues } from '../metrics/model_usage.js';
import type { AgentSessionOptions, VoiceOptions } from './agent_session.js';
import type { AgentEvent } from './events.js';

type ReportOptions = AgentSessionOptions & Partial<VoiceOptions>;

export interface SessionReport {
  jobId: string;
  roomId: string;
  room: string;
  options: ReportOptions;
  events: AgentEvent[];
  chatHistory: ChatContext;
  enableRecording: boolean;
  startedAt: number;
  timestamp: number;
  audioRecordingPath?: string;
  audioRecordingStartedAt?: number;
  duration?: number;
  modelUsage?: ModelUsage[];
}

export interface SessionReportOptions {
  jobId: string;
  roomId: string;
  room: string;
  options: ReportOptions;
  events: AgentEvent[];
  chatHistory: ChatContext;
  enableRecording?: boolean;
  startedAt?: number;
  timestamp?: number;
  audioRecordingPath?: string;
  audioRecordingStartedAt?: number;
  modelUsage?: ModelUsage[];
}

export function createSessionReport(opts: SessionReportOptions): SessionReport {
  const timestamp = opts.timestamp ?? Date.now();
  const audioRecordingStartedAt = opts.audioRecordingStartedAt;

  return {
    jobId: opts.jobId,
    roomId: opts.roomId,
    room: opts.room,
    options: opts.options,
    events: opts.events,
    chatHistory: opts.chatHistory,
    enableRecording: opts.enableRecording ?? false,
    startedAt: opts.startedAt ?? Date.now(),
    timestamp,
    audioRecordingPath: opts.audioRecordingPath,
    audioRecordingStartedAt,
    duration:
      audioRecordingStartedAt !== undefined ? timestamp - audioRecordingStartedAt : undefined,
    modelUsage: opts.modelUsage,
  };
}

export function sessionReportToJSON(report: SessionReport): Record<string, unknown> {
  const events: Record<string, unknown>[] = [];
  const options = report.options;
  const interruptionConfig = options.turnHandling?.interruption;
  const endpointingConfig = options.turnHandling?.endpointing;

  const allowInterruptions =
    interruptionConfig?.enabled !== undefined
      ? interruptionConfig.enabled
      : interruptionConfig?.mode !== undefined
        ? true
        : options.allowInterruptions ?? options.voiceOptions?.allowInterruptions;
  const discardAudioIfUninterruptible =
    interruptionConfig?.discardAudioIfUninterruptible ??
    options.discardAudioIfUninterruptible ??
    options.voiceOptions?.discardAudioIfUninterruptible;
  const minInterruptionDuration =
    interruptionConfig?.minDuration ??
    options.minInterruptionDuration ??
    options.voiceOptions?.minInterruptionDuration;
  const minInterruptionWords =
    interruptionConfig?.minWords ??
    options.minInterruptionWords ??
    options.voiceOptions?.minInterruptionWords;
  const minEndpointingDelay =
    endpointingConfig?.minDelay ??
    options.minEndpointingDelay ??
    options.voiceOptions?.minEndpointingDelay;
  const maxEndpointingDelay =
    endpointingConfig?.maxDelay ??
    options.maxEndpointingDelay ??
    options.voiceOptions?.maxEndpointingDelay;

  for (const event of report.events) {
    if (event.type === 'metrics_collected' || event.type === 'session_usage_updated') {
      continue;
    }

    events.push({ ...event });
  }

  return {
    job_id: report.jobId,
    room_id: report.roomId,
    room: report.room,
    events,
    options: {
      allow_interruptions: allowInterruptions,
      discard_audio_if_uninterruptible: discardAudioIfUninterruptible,
      min_interruption_duration: minInterruptionDuration,
      min_interruption_words: minInterruptionWords,
      min_endpointing_delay: minEndpointingDelay,
      max_endpointing_delay: maxEndpointingDelay,
      max_tool_steps: options.maxToolSteps,
    },
    chat_history: report.chatHistory.toJSON({ excludeTimestamp: false }),
    enable_user_data_training: report.enableRecording,
    timestamp: report.timestamp,
    usage: report.modelUsage ? report.modelUsage.map(filterZeroValues) : null,
  };
}
