// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import type * as types from '@google/genai';

export type LiveAPIModels =
  | 'gemini-live-2.5-flash-native-audio'
  | 'gemini-live-2.5-flash-preview-native-audio-09-2025'
  | 'gemini-live-2.5-flash-preview-native-audio'
  | 'gemini-3.1-flash-live-preview'
  | 'gemini-2.5-flash-native-audio-preview-12-2025'
  | 'gemini-2.5-flash-native-audio-preview-09-2025'
  | 'gemini-2.0-flash-exp';

export type Voice =
  | 'Achernar'
  | 'Achird'
  | 'Algenib'
  | 'Algieba'
  | 'Alnilam'
  | 'Aoede'
  | 'Autonoe'
  | 'Callirrhoe'
  | 'Charon'
  | 'Despina'
  | 'Enceladus'
  | 'Erinome'
  | 'Fenrir'
  | 'Gacrux'
  | 'Iapetus'
  | 'Kore'
  | 'Laomedeia'
  | 'Leda'
  | 'Orus'
  | 'Pulcherrima'
  | 'Puck'
  | 'Rasalgethi'
  | 'Sadachbia'
  | 'Sadaltager'
  | 'Schedar'
  | 'Sulafat'
  | 'Umbriel'
  | 'Vindemiatrix'
  | 'Zephyr'
  | 'Zubenelgenubi';

export type ClientEvents =
  | {
      type: 'content';
      value: types.LiveClientContent;
    }
  | {
      type: 'realtime_input';
      value: types.LiveClientRealtimeInput;
    }
  | {
      type: 'tool_response';
      value: types.LiveClientToolResponse;
    }
  | {
      type: 'function_response';
      value: types.FunctionResponse;
    };
