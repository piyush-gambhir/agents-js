// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { ParticipantKind } from '@livekit/rtc-node';
import { AudioFrame } from '@livekit/rtc-node';
import {
  type Context,
  ROOT_CONTEXT,
  type Span,
  context as otelContext,
  trace,
} from '@opentelemetry/api';
import type { WritableStreamDefaultWriter } from 'node:stream/web';
import { ReadableStream } from 'node:stream/web';
import { isAPIError } from '../_exceptions.js';
import { apiConnectDefaults, intervalForRetry } from '../inference/interruption/defaults.js';
import { InterruptionDetectionError } from '../inference/interruption/errors.js';
import type { AdaptiveInterruptionDetector } from '../inference/interruption/interruption_detector.js';
import { InterruptionStreamSentinel } from '../inference/interruption/interruption_stream.js';
import {
  type InterruptionSentinel,
  type OverlappingSpeechEvent,
} from '../inference/interruption/types.js';
import type { LanguageCode } from '../language.js';
import { type ChatContext } from '../llm/chat_context.js';
import { log } from '../log.js';
import { DeferredReadableStream, isStreamReaderReleaseError } from '../stream/deferred_stream.js';
import { IdentityTransform } from '../stream/identity_transform.js';
import { mergeReadableStreams } from '../stream/merge_readable_streams.js';
import { type StreamChannel, createStreamChannel } from '../stream/stream_channel.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { traceTypes, tracer } from '../telemetry/index.js';
import { Task, delay, waitForAbort } from '../utils.js';
import { type VAD, type VADEvent, VADEventType } from '../vad.js';
import type { TurnDetectionMode } from './agent_session.js';
import type { STTNode } from './io.js';
import { setParticipantSpanAttributes } from './utils.js';

export interface EndOfTurnInfo {
  newTranscript: string;
  transcriptConfidence: number;
  transcriptionDelay: number;
  endOfUtteranceDelay: number;
  startedSpeakingAt: number | undefined;
  stoppedSpeakingAt: number | undefined;
}

export interface PreemptiveGenerationInfo {
  newTranscript: string;
  transcriptConfidence: number;
}

export interface RecognitionHooks {
  onInterruption: (ev: OverlappingSpeechEvent) => void;
  onStartOfSpeech: (ev: VADEvent) => void;
  onVADInferenceDone: (ev: VADEvent) => void;
  onEndOfSpeech: (ev: VADEvent) => void;
  onInterimTranscript: (ev: SpeechEvent) => void;
  onFinalTranscript: (ev: SpeechEvent) => void;
  onEndOfTurn: (info: EndOfTurnInfo) => Promise<boolean>;
  onPreemptiveGeneration: (info: PreemptiveGenerationInfo) => void;

  retrieveChatCtx: () => ChatContext;
}

export interface _TurnDetector {
  readonly model: string;
  readonly provider: string;
  unlikelyThreshold: (language?: LanguageCode) => Promise<number | undefined>;
  supportsLanguage: (language?: LanguageCode) => Promise<boolean>;
  predictEndOfTurn(chatCtx: ChatContext, timeout?: number): Promise<number>;
}

export interface AudioRecognitionOptions {
  recognitionHooks: RecognitionHooks;
  stt?: STTNode;
  vad?: VAD;
  turnDetector?: _TurnDetector;
  turnDetectionMode?: TurnDetectionMode;
  interruptionDetection?: AdaptiveInterruptionDetector;
  minEndpointingDelay: number;
  maxEndpointingDelay: number;
  rootSpanContext?: Context;
  sttModel?: string;
  sttProvider?: string;
  getLinkedParticipant?: () => ParticipantLike | undefined;
}

export interface ParticipantLike {
  sid: string | undefined;
  identity: string;
  kind: ParticipantKind;
}

export class AudioRecognition {
  private hooks: RecognitionHooks;
  private stt?: STTNode;
  private vad?: VAD;
  private turnDetector?: _TurnDetector;
  private turnDetectionMode?: TurnDetectionMode;
  private minEndpointingDelay: number;
  private maxEndpointingDelay: number;
  private lastLanguage?: LanguageCode;
  private rootSpanContext?: Context;
  private sttModel?: string;
  private sttProvider?: string;
  private getLinkedParticipant?: () => ParticipantLike | undefined;

  private deferredInputStream: DeferredReadableStream<AudioFrame>;
  private logger = log();
  private lastFinalTranscriptTime = 0;
  private audioTranscript = '';
  private audioInterimTranscript = '';
  private audioPreflightTranscript = '';
  private finalTranscriptConfidence: number[] = [];
  private lastSpeakingTime: number | undefined;
  private speechStartTime: number | undefined;
  private userTurnCommitted = false;
  private speaking = false;
  private sampleRate?: number;

  private userTurnSpan?: Span;

  private vadInputStream: ReadableStream<AudioFrame>;
  private sttInputStream: ReadableStream<AudioFrame>;
  private silenceAudioTransform = new IdentityTransform<AudioFrame>();
  private silenceAudioWriter: WritableStreamDefaultWriter<AudioFrame>;

  private bounceEOUTask?: Task<void>;
  private commitUserTurnTask?: Task<void>;
  private vadTask?: Task<void>;
  private sttTask?: Task<void>;
  private interruptionTask?: Task<void>;

  private interruptionDetection?: AdaptiveInterruptionDetector;
  private _inputStartedAt?: number;
  private ignoreUserTranscriptUntil?: number;
  private transcriptBuffer: SpeechEvent[];
  private isInterruptionEnabled: boolean;
  private isAgentSpeaking: boolean;
  private interruptionStreamChannel?: StreamChannel<InterruptionSentinel | AudioFrame>;
  private closed = false;

  constructor(opts: AudioRecognitionOptions) {
    this.hooks = opts.recognitionHooks;
    this.stt = opts.stt;
    this.vad = opts.vad;
    this.turnDetector = opts.turnDetector;
    this.turnDetectionMode = opts.turnDetectionMode;
    this.minEndpointingDelay = opts.minEndpointingDelay;
    this.maxEndpointingDelay = opts.maxEndpointingDelay;
    this.lastLanguage = undefined;
    this.rootSpanContext = opts.rootSpanContext;
    this.sttModel = opts.sttModel;
    this.sttProvider = opts.sttProvider;
    this.getLinkedParticipant = opts.getLinkedParticipant;

    this.deferredInputStream = new DeferredReadableStream<AudioFrame>();
    this.interruptionDetection = opts.interruptionDetection;
    this.transcriptBuffer = [];
    this.isInterruptionEnabled = !!(opts.interruptionDetection && opts.vad);
    this.isAgentSpeaking = false;

    if (opts.interruptionDetection) {
      const [vadInputStream, teedInput] = this.deferredInputStream.stream.tee();
      const [inputStream, sttInputStream] = teedInput.tee();
      this.vadInputStream = vadInputStream;
      this.sttInputStream = mergeReadableStreams(
        sttInputStream,
        this.silenceAudioTransform.readable,
      );
      this.interruptionStreamChannel = createStreamChannel();
      this.interruptionStreamChannel.addStreamInput(inputStream);
    } else {
      const [vadInputStream, sttInputStream] = this.deferredInputStream.stream.tee();
      this.vadInputStream = vadInputStream;
      this.sttInputStream = mergeReadableStreams(
        sttInputStream,
        this.silenceAudioTransform.readable,
      );
    }
    this.silenceAudioWriter = this.silenceAudioTransform.writable.getWriter();
  }

  get currentTranscript(): string {
    if (this.audioInterimTranscript) {
      return `${this.audioTranscript} ${this.audioInterimTranscript}`.trim();
    }
    return this.audioTranscript;
  }

  /** @internal */
  get inputStartedAt() {
    return this._inputStartedAt;
  }

  /** @internal */
  updateOptions(options: { turnDetection: TurnDetectionMode | undefined }): void {
    this.turnDetectionMode = options.turnDetection;
  }

  async start() {
    this.vadTask = Task.from(({ signal }) => this.createVadTask(this.vad, signal));
    this.vadTask.result.catch((err) => {
      this.logger.error(`Error running VAD task: ${err}`);
    });

    this.sttTask = Task.from(({ signal }) => this.createSttTask(this.stt, signal));
    this.sttTask.result.catch((err) => {
      this.logger.error(`Error running STT task: ${err}`);
    });

    this.interruptionTask = Task.from(({ signal }) =>
      this.createInterruptionTask(this.interruptionDetection, signal),
    );
    this.interruptionTask.result.catch((err) => {
      this.logger.error(`Error running interruption task: ${err}`);
    });
  }

  async stop() {
    await this.sttTask?.cancelAndWait();
    await this.vadTask?.cancelAndWait();
    await this.interruptionTask?.cancelAndWait();
  }

  async disableInterruptionDetection(): Promise<void> {
    this.isInterruptionEnabled = false;
    this.interruptionDetection = undefined;
    await this.interruptionTask?.cancelAndWait();
    this.interruptionTask = undefined;
    await this.interruptionStreamChannel?.close();
    this.interruptionStreamChannel = undefined;
  }

  async onStartOfAgentSpeech() {
    this.isAgentSpeaking = true;
    return this.trySendInterruptionSentinel(InterruptionStreamSentinel.agentSpeechStarted());
  }

  async onEndOfAgentSpeech(ignoreUserTranscriptUntil: number) {
    if (!this.isInterruptionEnabled) {
      this.isAgentSpeaking = false;
      return;
    }

    const inputOpen = await this.trySendInterruptionSentinel(
      InterruptionStreamSentinel.agentSpeechEnded(),
    );
    if (!inputOpen) {
      this.isAgentSpeaking = false;
      return;
    }

    if (this.isAgentSpeaking) {
      if (this.ignoreUserTranscriptUntil === undefined) {
        this.onEndOfOverlapSpeech(Date.now());
      }
      this.ignoreUserTranscriptUntil = this.ignoreUserTranscriptUntil
        ? Math.min(ignoreUserTranscriptUntil, this.ignoreUserTranscriptUntil)
        : ignoreUserTranscriptUntil;

      await this.flushHeldTranscripts();
    }
    this.isAgentSpeaking = false;
  }

  async onStartOfOverlapSpeech(speechDuration: number, startedAt: number, userSpeakingSpan?: Span) {
    if (this.isAgentSpeaking) {
      this.trySendInterruptionSentinel(
        InterruptionStreamSentinel.overlapSpeechStarted(
          speechDuration,
          startedAt,
          userSpeakingSpan,
        ),
      );
    }
  }

  async onEndOfOverlapSpeech(endedAt: number, userSpeakingSpan?: Span) {
    if (!this.isInterruptionEnabled) {
      return;
    }
    if (userSpeakingSpan && userSpeakingSpan.isRecording()) {
      userSpeakingSpan.setAttribute(traceTypes.ATTR_IS_INTERRUPTION, 'false');
    }

    return this.trySendInterruptionSentinel(InterruptionStreamSentinel.overlapSpeechEnded(endedAt));
  }

  private async flushHeldTranscripts() {
    if (
      !this.isInterruptionEnabled ||
      this.ignoreUserTranscriptUntil === undefined ||
      this.transcriptBuffer.length === 0
    ) {
      return;
    }

    if (!this._inputStartedAt) {
      this.transcriptBuffer = [];
      this.ignoreUserTranscriptUntil = undefined;
      return;
    }

    let emitFromIndex: number | null = null;
    let shouldFlush = false;

    for (let i = 0; i < this.transcriptBuffer.length; i++) {
      const ev = this.transcriptBuffer[i];
      if (!ev || !ev.alternatives || ev.alternatives.length === 0) {
        emitFromIndex = Math.min(emitFromIndex ?? i, i);
        continue;
      }
      const firstAlternative = ev.alternatives[0];
      if (
        firstAlternative.startTime === firstAlternative.endTime &&
        firstAlternative.startTime === 0
      ) {
        this.transcriptBuffer = [];
        this.ignoreUserTranscriptUntil = undefined;
        return;
      }

      if (this.#alternativeEndsBeforeIgnoreWindow(firstAlternative)) {
        emitFromIndex = null;
      } else {
        emitFromIndex = Math.min(emitFromIndex ?? i, i);
        shouldFlush = true;
        break;
      }
    }

    const eventsToEmit =
      emitFromIndex !== null && shouldFlush ? this.transcriptBuffer.slice(emitFromIndex) : [];

    this.transcriptBuffer = [];
    this.ignoreUserTranscriptUntil = undefined;

    for (const event of eventsToEmit) {
      this.logger.trace(
        {
          event: event.type,
        },
        're-emitting held user transcript',
      );
      this.onSTTEvent(event);
    }
  }

  #alternativeEndsBeforeIgnoreWindow(
    alternative: NonNullable<SpeechEvent['alternatives']>[number],
  ): boolean {
    if (
      this.ignoreUserTranscriptUntil === undefined ||
      !this._inputStartedAt ||
      alternative.startTime <= 0
    ) {
      return false;
    }

    return alternative.startTime * 1000 + this._inputStartedAt < this.ignoreUserTranscriptUntil;
  }

  private shouldHoldSttEvent(ev: SpeechEvent): boolean {
    if (!this.isInterruptionEnabled) {
      return false;
    }
    if (this.isAgentSpeaking) {
      return true;
    }

    if (ev.type === SpeechEventType.START_OF_SPEECH) {
      this.ignoreUserTranscriptUntil = undefined;
      this.transcriptBuffer = [];
      return false;
    }

    if (this.ignoreUserTranscriptUntil === undefined) {
      return false;
    }
    if (!ev.alternatives || ev.alternatives.length === 0) {
      return true;
    }

    const alternative = ev.alternatives[0];

    if (
      alternative.startTime !== alternative.endTime &&
      this.#alternativeEndsBeforeIgnoreWindow(alternative)
    ) {
      return true;
    }
    return false;
  }

  private async trySendInterruptionSentinel(
    frame: AudioFrame | InterruptionSentinel,
  ): Promise<boolean> {
    if (
      this.isInterruptionEnabled &&
      this.interruptionStreamChannel &&
      !this.interruptionStreamChannel.closed
    ) {
      try {
        await this.interruptionStreamChannel.write(frame);
        return true;
      } catch (e: unknown) {
        this.logger.warn(
          `could not forward interruption sentinel: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return false;
  }

  private ensureUserTurnSpan(startTime?: number): Span {
    if (this.userTurnSpan && this.userTurnSpan.isRecording()) {
      return this.userTurnSpan;
    }

    this.userTurnSpan = tracer.startSpan({
      name: 'user_turn',
      context: this.rootSpanContext,
      startTime,
    });

    const participant = this.getLinkedParticipant?.();
    if (participant) {
      setParticipantSpanAttributes(this.userTurnSpan, participant);
    }

    if (this.sttModel) {
      this.userTurnSpan.setAttribute(traceTypes.ATTR_GEN_AI_REQUEST_MODEL, this.sttModel);
    }
    if (this.sttProvider) {
      this.userTurnSpan.setAttribute(traceTypes.ATTR_GEN_AI_PROVIDER_NAME, this.sttProvider);
    }

    return this.userTurnSpan;
  }

  private userTurnContext(span: Span): Context {
    const base = this.rootSpanContext ?? ROOT_CONTEXT;
    return trace.setSpan(base, span);
  }

  private async onSTTEvent(ev: SpeechEvent) {
    if (
      this.turnDetectionMode === 'manual' &&
      this.userTurnCommitted &&
      (this.bounceEOUTask === undefined ||
        this.bounceEOUTask.done ||
        ev.type == SpeechEventType.INTERIM_TRANSCRIPT)
    ) {
      this.logger.debug(
        {
          userTurnCommitted: this.userTurnCommitted,
          eouTaskDone: this.bounceEOUTask?.done,
          evType: ev.type,
          turnDetectionMode: this.turnDetectionMode,
        },
        'ignoring stt event',
      );
      return;
    }


    if (ev.type !== SpeechEventType.RECOGNITION_USAGE && this.isInterruptionEnabled) {
      if (this.shouldHoldSttEvent(ev)) {
        this.logger.trace(
          { event: ev.type, ignoreUserTranscriptUntil: this.ignoreUserTranscriptUntil },
          'holding STT event until ignore_user_transcript_until expires',
        );
        this.transcriptBuffer.push(ev);
        return;
      } else {
        await this.flushHeldTranscripts();
      }
    }

    switch (ev.type) {
      case SpeechEventType.FINAL_TRANSCRIPT:
        const transcript = ev.alternatives?.[0]?.text;
        const confidence = ev.alternatives?.[0]?.confidence ?? 0;
        this.lastLanguage = ev.alternatives?.[0]?.language;

        if (!transcript) {
          return;
        }

        this.hooks.onFinalTranscript(ev);

        this.logger.debug(
          {
            user_transcript: transcript,
            language: this.lastLanguage,
          },
          'received user transcript',
        );

        this.lastFinalTranscriptTime = Date.now();
        this.audioTranscript += ` ${transcript}`;
        this.audioTranscript = this.audioTranscript.trimStart();
        this.finalTranscriptConfidence.push(confidence);
        const transcriptChanged = this.audioTranscript !== this.audioPreflightTranscript;
        this.audioInterimTranscript = '';
        this.audioPreflightTranscript = '';

        if (!this.vad || this.lastSpeakingTime === undefined) {
          this.lastSpeakingTime = Date.now();
        }

        if (this.vadBaseTurnDetection || this.userTurnCommitted) {
          if (transcriptChanged) {
            this.logger.debug(
              { transcript: this.audioTranscript },
              'triggering preemptive generation (FINAL_TRANSCRIPT)',
            );
            this.hooks.onPreemptiveGeneration({
              newTranscript: this.audioTranscript,
              transcriptConfidence:
                this.finalTranscriptConfidence.length > 0
                  ? this.finalTranscriptConfidence.reduce((a, b) => a + b, 0) /
                    this.finalTranscriptConfidence.length
                  : 0,
            });
          }

          if (!this.speaking) {
            const chatCtx = this.hooks.retrieveChatCtx();
            this.logger.debug('running EOU detection on stt FINAL_TRANSCRIPT');
            this.runEOUDetection(chatCtx);
          }
        }
        break;
      case SpeechEventType.PREFLIGHT_TRANSCRIPT:
        this.hooks.onInterimTranscript(ev);
        const preflightTranscript = ev.alternatives?.[0]?.text ?? '';
        const preflightConfidence = ev.alternatives?.[0]?.confidence ?? 0;
        const preflightLanguage = ev.alternatives?.[0]?.language;

        const MIN_LANGUAGE_DETECTION_LENGTH = 5;
        if (
          !this.lastLanguage ||
          (preflightLanguage && preflightTranscript.length > MIN_LANGUAGE_DETECTION_LENGTH)
        ) {
          this.lastLanguage = preflightLanguage;
        }

        if (!preflightTranscript) {
          return;
        }

        this.logger.debug(
          {
            user_transcript: preflightTranscript,
            language: this.lastLanguage,
          },
          'received user preflight transcript',
        );

        this.lastFinalTranscriptTime = Date.now();
        this.audioPreflightTranscript =
          `${this.audioTranscript} ${preflightTranscript}`.trimStart();
        this.audioInterimTranscript = preflightTranscript;

        if (!this.vad || this.lastSpeakingTime === undefined) {
          this.lastSpeakingTime = Date.now();
        }

        if (this.turnDetectionMode !== 'manual' || this.userTurnCommitted) {
          const confidenceVals = [...this.finalTranscriptConfidence, preflightConfidence];
          this.logger.debug(
            {
              transcript:
                this.audioPreflightTranscript.length > 100
                  ? this.audioPreflightTranscript.slice(0, 100) + '...'
                  : this.audioPreflightTranscript,
            },
            'triggering preemptive generation (PREFLIGHT_TRANSCRIPT)',
          );
          this.hooks.onPreemptiveGeneration({
            newTranscript: this.audioPreflightTranscript,
            transcriptConfidence:
              confidenceVals.length > 0
                ? confidenceVals.reduce((a, b) => a + b, 0) / confidenceVals.length
                : 0,
          });
        }
        break;
      case SpeechEventType.INTERIM_TRANSCRIPT:
        this.logger.debug({ transcript: ev.alternatives?.[0]?.text }, 'interim transcript');
        this.hooks.onInterimTranscript(ev);
        this.audioInterimTranscript = ev.alternatives?.[0]?.text ?? '';
        break;
      case SpeechEventType.START_OF_SPEECH:
        if (this.turnDetectionMode !== 'stt') break;
        {
          const span = this.ensureUserTurnSpan(Date.now());
          const ctx = this.userTurnContext(span);
          otelContext.with(ctx, () => {
            this.hooks.onStartOfSpeech({
              type: VADEventType.START_OF_SPEECH,
              samplesIndex: 0,
              timestamp: Date.now(),
              speechDuration: 0,
              silenceDuration: 0,
              frames: [],
              probability: 0,
              inferenceDuration: 0,
              speaking: true,
              rawAccumulatedSilence: 0,
              rawAccumulatedSpeech: 0,
            });
          });
        }
        this.speaking = true;
        this.lastSpeakingTime = Date.now();

        this.bounceEOUTask?.cancel();
        break;
      case SpeechEventType.END_OF_SPEECH:
        if (this.turnDetectionMode !== 'stt') break;
        {
          const span = this.ensureUserTurnSpan();
          const ctx = this.userTurnContext(span);
          otelContext.with(ctx, () => {
            this.hooks.onEndOfSpeech({
              type: VADEventType.END_OF_SPEECH,
              samplesIndex: 0,
              timestamp: Date.now(),
              speechDuration: 0,
              silenceDuration: 0,
              frames: [],
              probability: 0,
              inferenceDuration: 0,
              speaking: false,
              rawAccumulatedSilence: 0,
              rawAccumulatedSpeech: 0,
            });
          });
        }
        if (this.vad && this.speaking) {
          this.logger.warn('stt end of speech received while user is speaking, resetting vad');
          this.resetVad();
        }
        this.speaking = false;
        this.userTurnCommitted = true;
        this.lastSpeakingTime = Date.now();

        if (!this.speaking) {
          const chatCtx = this.hooks.retrieveChatCtx();
          this.logger.debug('running EOU detection on stt END_OF_SPEECH');
          this.runEOUDetection(chatCtx);
        }
    }
  }

  private onOverlapSpeechEvent(ev: OverlappingSpeechEvent) {
    if (ev.isInterruption) {
      this.hooks.onInterruption(ev);
    }
  }

  private runEOUDetection(chatCtx: ChatContext) {
    this.logger.debug(
      {
        stt: this.stt,
        audioTranscript: this.audioTranscript,
        turnDetectionMode: this.turnDetectionMode,
      },
      'running EOU detection',
    );

    if (this.stt && !this.audioTranscript && this.turnDetectionMode !== 'manual') {
      this.logger.debug('skipping EOU detection');
      return;
    }

    chatCtx = chatCtx.copy();
    chatCtx.addMessage({ role: 'user', content: this.audioTranscript });

    const turnDetector =
      this.audioTranscript && this.turnDetectionMode !== 'manual' ? this.turnDetector : undefined;

    const bounceEOUTask =
      (
        lastSpeakingTime: number | undefined,
        lastFinalTranscriptTime: number,
        speechStartTime: number | undefined,
      ) =>
      async (controller: AbortController) => {
        let endpointingDelay = this.minEndpointingDelay;

        const userTurnSpan = this.ensureUserTurnSpan();
        const userTurnCtx = this.userTurnContext(userTurnSpan);

        if (turnDetector) {
          await tracer.startActiveSpan(
            async (span) => {
              this.logger.debug('Running turn detector model');

              let endOfTurnProbability = 0.0;
              let unlikelyThreshold: number | undefined;

              if (!(await turnDetector.supportsLanguage(this.lastLanguage))) {
                this.logger.debug(`Turn detector does not support language ${this.lastLanguage}`);
              } else {
                try {
                  endOfTurnProbability = await turnDetector.predictEndOfTurn(chatCtx);
                  unlikelyThreshold = await turnDetector.unlikelyThreshold(this.lastLanguage);

                  this.logger.debug(
                    { endOfTurnProbability, unlikelyThreshold, language: this.lastLanguage },
                    'end of turn probability',
                  );

                  if (unlikelyThreshold && endOfTurnProbability < unlikelyThreshold) {
                    endpointingDelay = this.maxEndpointingDelay;
                  }
                } catch (error) {
                  this.logger.error(error, 'Error predicting end of turn');
                }
              }

              span.setAttribute(
                traceTypes.ATTR_CHAT_CTX,
                JSON.stringify(chatCtx.toJSON({ excludeTimestamp: false })),
              );
              span.setAttribute(traceTypes.ATTR_EOU_PROBABILITY, endOfTurnProbability);
              span.setAttribute(traceTypes.ATTR_EOU_UNLIKELY_THRESHOLD, unlikelyThreshold ?? 0);
              span.setAttribute(traceTypes.ATTR_EOU_DELAY, endpointingDelay);
              span.setAttribute(traceTypes.ATTR_EOU_LANGUAGE, this.lastLanguage ?? '');
            },
            {
              name: 'eou_detection',
              context: userTurnCtx,
            },
          );
        }

        let extraSleep = endpointingDelay;
        if (lastSpeakingTime !== undefined) {
          extraSleep += lastSpeakingTime - Date.now();
        }

        if (extraSleep > 0) {
          await delay(Math.max(extraSleep, 0), { signal: controller.signal });
        }

        this.logger.debug({ transcript: this.audioTranscript }, 'end of user turn');

        const confidenceAvg =
          this.finalTranscriptConfidence.length > 0
            ? this.finalTranscriptConfidence.reduce((a, b) => a + b, 0) /
              this.finalTranscriptConfidence.length
            : 0;

        let startedSpeakingAt: number | undefined;
        let stoppedSpeakingAt: number | undefined;
        let transcriptionDelay: number | undefined;
        let endOfUtteranceDelay: number | undefined;

        if (
          lastFinalTranscriptTime !== 0 &&
          lastSpeakingTime !== undefined &&
          speechStartTime !== undefined
        ) {
          startedSpeakingAt = speechStartTime;
          stoppedSpeakingAt = lastSpeakingTime;
          transcriptionDelay = Math.max(lastFinalTranscriptTime - lastSpeakingTime, 0);
          endOfUtteranceDelay = Date.now() - lastSpeakingTime;
        }

        const committed = await this.hooks.onEndOfTurn({
          newTranscript: this.audioTranscript,
          transcriptConfidence: confidenceAvg,
          transcriptionDelay: transcriptionDelay ?? 0,
          endOfUtteranceDelay: endOfUtteranceDelay ?? 0,
          startedSpeakingAt,
          stoppedSpeakingAt,
        });

        if (committed) {
          this._endUserTurnSpan({
            transcript: this.audioTranscript,
            confidence: confidenceAvg,
            transcriptionDelay: transcriptionDelay ?? 0,
            endOfUtteranceDelay: endOfUtteranceDelay ?? 0,
          });

          this.audioTranscript = '';
          this.finalTranscriptConfidence = [];
          this.lastSpeakingTime = undefined;
          this.lastFinalTranscriptTime = 0;
          this.speechStartTime = undefined;
        }

        this.userTurnCommitted = false;
      };

    this.bounceEOUTask?.cancel();
    this.bounceEOUTask = Task.from(
      bounceEOUTask(this.lastSpeakingTime, this.lastFinalTranscriptTime, this.speechStartTime),
    );

    this.bounceEOUTask.result
      .then(() => {
        this.logger.debug('EOU detection task completed');
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message.includes('This operation was aborted')) {
          return;
        }
        this.logger.error(err, 'Error in EOU detection task:');
      });
  }

  private async createSttTask(stt: STTNode | undefined, signal: AbortSignal) {
    if (!stt) return;

    this.logger.debug('createSttTask: create stt stream from stt node');

    const sttStream = await stt(this.sttInputStream, {});

    if (signal.aborted || sttStream === null) return;

    if (sttStream instanceof ReadableStream) {
      const reader = sttStream.getReader();

      signal.addEventListener('abort', async () => {
        try {
          reader.releaseLock();
          await sttStream?.cancel();
        } catch (e) {
          this.logger.debug('createSttTask: error during abort handler:', e);
        }
      });

      try {
        while (true) {
          if (signal.aborted) break;

          const { done, value: ev } = await reader.read();
          if (done) break;

          if (typeof ev === 'string') {
            throw new Error('STT node must yield SpeechEvent');
          } else {
            await this.onSTTEvent(ev);
          }
        }
      } catch (e) {
        if (isStreamReaderReleaseError(e)) {
          return;
        }
        this.logger.error({ error: e }, 'createSttTask: error reading sttStream');
      } finally {
        reader.releaseLock();
        try {
          await sttStream.cancel();
        } catch (e) {
          this.logger.debug(
            'createSttTask: error cancelling sttStream (may already be cancelled):',
            e,
          );
        }
      }
    }
  }

  private async createVadTask(vad: VAD | undefined, signal: AbortSignal) {
    if (!vad) return;

    const vadStream = vad.stream();
    vadStream.updateInputStream(this.vadInputStream);

    const abortHandler = () => {
      vadStream.detachInputStream();
      vadStream.close();
      signal.removeEventListener('abort', abortHandler);
    };
    signal.addEventListener('abort', abortHandler);

    try {
      for await (const ev of vadStream) {
        if (signal.aborted) break;

        switch (ev.type) {
          case VADEventType.START_OF_SPEECH:
            this.logger.debug('VAD task: START_OF_SPEECH');
            {
              const startTime = Date.now() - ev.speechDuration;
              const span = this.ensureUserTurnSpan(startTime);
              const ctx = this.userTurnContext(span);
              otelContext.with(ctx, () => this.hooks.onStartOfSpeech(ev));
            }
            this.speaking = true;

            if (ev.frames.length > 0 && ev.frames[0]) {
              this.sampleRate = ev.frames[0].sampleRate;
            }

            this.bounceEOUTask?.cancel();
            break;
          case VADEventType.INFERENCE_DONE:
            this.hooks.onVADInferenceDone(ev);
            if (ev.rawAccumulatedSpeech > 0.0) {
              this.lastSpeakingTime = Date.now();

              if (this.speechStartTime === undefined) {
                this.speechStartTime = Date.now() - ev.rawAccumulatedSpeech;
              }
            }
            break;
          case VADEventType.END_OF_SPEECH:
            this.logger.debug('VAD task: END_OF_SPEECH');
            {
              const span = this.ensureUserTurnSpan();
              const ctx = this.userTurnContext(span);
              otelContext.with(ctx, () => this.hooks.onEndOfSpeech(ev));
            }

            this.speaking = false;

            if (
              this.vadBaseTurnDetection ||
              (this.turnDetectionMode === 'stt' && this.userTurnCommitted)
            ) {
              const chatCtx = this.hooks.retrieveChatCtx();
              this.runEOUDetection(chatCtx);
            }
            break;
        }
      }
    } catch (e) {
      this.logger.error(e, 'Error in VAD task');
    } finally {
      this.logger.debug('VAD task closed');
    }
  }

  private async createInterruptionTask(
    interruptionDetection: AdaptiveInterruptionDetector | undefined,
    signal: AbortSignal,
  ) {
    if (!interruptionDetection || !this.interruptionStreamChannel) return;

    let numRetries = 0;
    const maxRetries = apiConnectDefaults.maxRetries;

    while (!signal.aborted) {
      const stream = interruptionDetection.createStream();
      const eventReader = stream.stream().getReader();

      const cleanup = async () => {
        try {
          signal.removeEventListener('abort', cleanup);
          eventReader.releaseLock();
          await stream.close();
        } catch (e) {
          this.logger.debug('createInterruptionTask: error during cleanup:', e);
        }
      };

      signal.addEventListener('abort', cleanup, { once: true });

      let forwardTask: Promise<void> | undefined;

      try {
        if (numRetries > 0 && this.isAgentSpeaking) {
          await stream.pushFrame(InterruptionStreamSentinel.agentSpeechStarted());
        }

        forwardTask = (async () => {
          const inputReader = this.interruptionStreamChannel!.stream().getReader();
          const abortPromise = waitForAbort(signal);

          try {
            while (!signal.aborted) {
              const res = await Promise.race([inputReader.read(), abortPromise]);
              if (!res) break;

              const { value, done } = res;
              if (done) break;

              if (value instanceof AudioFrame) {
                const frameDurationMs = (value.samplesPerChannel / value.sampleRate) * 1000;
                this._inputStartedAt ??= Date.now() - frameDurationMs;
              } else {
                this._inputStartedAt ??= Date.now();
              }

              await stream.pushFrame(value);
            }
          } finally {
            inputReader.releaseLock();
          }
        })();

        const abortPromise = waitForAbort(signal);

        while (!signal.aborted) {
          const res = await Promise.race([eventReader.read(), abortPromise]);
          if (!res) break;
          const { done, value: ev } = res;
          if (done) break;
          this.onOverlapSpeechEvent(ev);
        }
        break;
      } catch (e) {
        if (signal.aborted) break;

        if (isAPIError(e)) {
          if (maxRetries === 0 || !e.retryable) {
            interruptionDetection.emitError(
              new InterruptionDetectionError(
                e.message,
                Date.now(),
                interruptionDetection.label,
                false,
              ),
            );
            break;
          } else if (numRetries >= maxRetries) {
            interruptionDetection.emitError(
              new InterruptionDetectionError(
                `failed to detect interruption after ${numRetries} attempts`,
                Date.now(),
                interruptionDetection.label,
                false,
              ),
            );
            break;
          } else {
            const retryInterval = intervalForRetry(numRetries);
            interruptionDetection.emitError(
              new InterruptionDetectionError(
                e.message,
                Date.now(),
                interruptionDetection.label,
                true,
              ),
            );
            this.logger.warn(
              { model: interruptionDetection.label, attempt: numRetries },
              `failed to detect interruption, retrying in ${retryInterval}ms`,
            );
            numRetries++;
            await delay(retryInterval, { signal });
          }
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          interruptionDetection.emitError(
            new InterruptionDetectionError(msg, Date.now(), interruptionDetection.label, false),
          );
          this.logger.error(e, 'Error in interruption task');
          break;
        }
      } finally {
        await cleanup();
        await forwardTask?.catch((e) => {
          this.logger.debug({ err: e }, 'interruption task exited with error');
        });
      }
    }
    this.logger.debug('Interruption task closed');
  }

  setInputAudioStream(audioStream: ReadableStream<AudioFrame>) {
    this.deferredInputStream.setSource(audioStream);
  }

  detachInputAudioStream() {
    this.deferredInputStream.detachSource();
  }

  clearUserTurn() {
    this.audioTranscript = '';
    this.audioInterimTranscript = '';
    this.audioPreflightTranscript = '';
    this.finalTranscriptConfidence = [];
    this.userTurnCommitted = false;

    this.sttTask?.cancelAndWait().finally(() => {
      this.sttTask = Task.from(({ signal }) => this.createSttTask(this.stt, signal));
      this.sttTask.result.catch((err) => {
        this.logger.error(`Error running STT task: ${err}`);
      });
    });
  }

  private resetVad() {
    if (!this.vad) return;

    this.vadTask?.cancelAndWait().finally(() => {
      if (this.closed) return;
      this.vadTask = Task.from(({ signal }) => this.createVadTask(this.vad, signal));
      this.vadTask.result.catch((err) => {
        this.logger.error(`Error running VAD task: ${err}`);
      });
    });
  }

  commitUserTurn(audioDetached: boolean) {
    const commitUserTurnTask =
      (delayDuration: number = 500) =>
      async (controller: AbortController) => {
        if (Date.now() - this.lastFinalTranscriptTime > delayDuration) {
          if (audioDetached && this.sampleRate !== undefined) {
            const numSamples = Math.floor(this.sampleRate * 0.5);
            const silence = new Int16Array(numSamples * 2);
            const silenceFrame = new AudioFrame(silence, this.sampleRate, 1, numSamples);
            this.silenceAudioWriter.write(silenceFrame);
          }

          await delay(delayDuration, { signal: controller.signal });
        }

        if (this.audioInterimTranscript) {
          this.audioTranscript = `${this.audioTranscript} ${this.audioInterimTranscript}`.trim();
        }
        this.audioInterimTranscript = '';

        const chatCtx = this.hooks.retrieveChatCtx();
        this.logger.debug('running EOU detection on commitUserTurn');
        this.runEOUDetection(chatCtx);
        this.userTurnCommitted = true;
      };

    this.commitUserTurnTask?.cancel();
    this.commitUserTurnTask = Task.from(commitUserTurnTask());

    this.commitUserTurnTask.result
      .then(() => {
        this.logger.debug('User turn committed');
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') {
          this.logger.debug('User turn commit task cancelled');
          return;
        }
        this.logger.error(err, 'Error in user turn commit task:');
      });
  }

  async close() {
    this.closed = true;
    this.detachInputAudioStream();
    this.silenceAudioWriter.releaseLock();
    await this.commitUserTurnTask?.cancelAndWait();
    await this.sttTask?.cancelAndWait();
    await this.vadTask?.cancelAndWait();
    await this.bounceEOUTask?.cancelAndWait();
    await this.interruptionTask?.cancelAndWait();
    await this.interruptionStreamChannel?.close();
  }

  private _endUserTurnSpan({
    transcript,
    confidence,
    transcriptionDelay,
    endOfUtteranceDelay,
  }: {
    transcript: string;
    confidence: number;
    transcriptionDelay: number;
    endOfUtteranceDelay: number;
  }): void {
    if (this.userTurnSpan) {
      this.userTurnSpan.setAttributes({
        [traceTypes.ATTR_USER_TRANSCRIPT]: transcript,
        [traceTypes.ATTR_TRANSCRIPT_CONFIDENCE]: confidence,
        [traceTypes.ATTR_TRANSCRIPTION_DELAY]: transcriptionDelay,
        [traceTypes.ATTR_END_OF_TURN_DELAY]: endOfUtteranceDelay,
      });
      this.userTurnSpan.end();
      this.userTurnSpan = undefined;
    }
  }

  private get vadBaseTurnDetection() {
    if (typeof this.turnDetectionMode === 'object') {
      return false;
    }

    if (this.turnDetectionMode === undefined || this.turnDetectionMode === 'vad') {
      return true;
    }

    return false;
  }
}
