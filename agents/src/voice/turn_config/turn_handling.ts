// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { TurnDetectionMode } from '../agent_session.js';
import { type EndpointingOptions, defaultEndpointingOptions } from './endpointing.js';
import { type InterruptionOptions, defaultInterruptionOptions } from './interruption.js';

export interface TurnHandlingOptions {
  turnDetection: TurnDetectionMode | undefined;
  endpointing: Partial<EndpointingOptions>;
  interruption: Partial<InterruptionOptions>;
}

export interface InternalTurnHandlingOptions extends TurnHandlingOptions {
  endpointing: EndpointingOptions;
  interruption: InterruptionOptions;
}

export const defaultTurnHandlingOptions: InternalTurnHandlingOptions = {
  turnDetection: undefined,
  interruption: defaultInterruptionOptions,
  endpointing: defaultEndpointingOptions,
};
