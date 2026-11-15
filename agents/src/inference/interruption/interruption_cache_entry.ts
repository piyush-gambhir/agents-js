// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import { estimateProbability } from './utils.js';

export class InterruptionCacheEntry {
  createdAt: number;
  requestStartedAt?: number;
  totalDurationInS: number;
  predictionDurationInS: number;
  detectionDelayInS: number;
  speechInput?: Int16Array;
  probabilities?: number[];
  isInterruption?: boolean;

  constructor(params: {
    createdAt: number;
    requestStartedAt?: number;
    speechInput?: Int16Array;
    totalDurationInS?: number;
    predictionDurationInS?: number;
    detectionDelayInS?: number;
    probabilities?: number[];
    isInterruption?: boolean;
  }) {
    this.createdAt = params.createdAt;
    this.requestStartedAt = params.requestStartedAt;
    this.totalDurationInS = params.totalDurationInS ?? 0;
    this.predictionDurationInS = params.predictionDurationInS ?? 0;
    this.detectionDelayInS = params.detectionDelayInS ?? 0;
    this.speechInput = params.speechInput;
    this.probabilities = params.probabilities;
    this.isInterruption = params.isInterruption;
  }

  get probability(): number {
    return this.probabilities ? estimateProbability(this.probabilities) : 0;
  }

  static default(): InterruptionCacheEntry {
    return new InterruptionCacheEntry({ createdAt: 0 });
  }
}
