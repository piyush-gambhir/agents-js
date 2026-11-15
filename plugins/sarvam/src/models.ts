// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0

export type TTSModels = 'bulbul:v2' | 'bulbul:v3';

export type TTSV3Speakers =
  | 'shubh'
  | 'aditya'
  | 'ritu'
  | 'priya'
  | 'neha'
  | 'rahul'
  | 'pooja'
  | 'rohan'
  | 'simran'
  | 'kavya'
  | 'amit'
  | 'dev'
  | 'ishita'
  | 'shreya'
  | 'ratan'
  | 'varun'
  | 'manan'
  | 'sumit'
  | 'roopa'
  | 'kabir'
  | 'aayan'
  | 'ashutosh'
  | 'advait'
  | 'amelia'
  | 'sophia'
  | 'anand'
  | 'tanya'
  | 'tarun'
  | 'sunny'
  | 'mani'
  | 'gokul'
  | 'vijay'
  | 'shruti'
  | 'suhani'
  | 'mohit'
  | 'kavitha'
  | 'rehan'
  | 'soham'
  | 'rupali';

export type TTSV2Speakers =
  | 'anushka'
  | 'manisha'
  | 'vidya'
  | 'arya'
  | 'abhilash'
  | 'karun'
  | 'hitesh';

export type TTSSpeakers = TTSV2Speakers | TTSV3Speakers;

export type TTSLanguages =
  | 'bn-IN'
  | 'en-IN'
  | 'gu-IN'
  | 'hi-IN'
  | 'kn-IN'
  | 'ml-IN'
  | 'mr-IN'
  | 'od-IN'
  | 'pa-IN'
  | 'ta-IN'
  | 'te-IN';

export type TTSSampleRates = 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;


/**
 * Supported Sarvam AI STT models.
 *
 * @remarks
 * - `saaras:v3` — recommended for new integrations. Supports all 22 languages, modes, and prompts.
 * - `saaras:v2.5` — dedicated Indic-to-English translation via `/speech-to-text-translate`.
 *   Auto-detects the source language; supports prompts but not language codes or modes.
 * - `saarika:v2.5` — will be deprecated soon. All its languages are available in `saaras:v3`.
 *
 * @see {@link https://docs.sarvam.ai/api-reference-docs/getting-started/models/saaras | Saaras model docs}
 */
export type STTModels = 'saaras:v3' | 'saaras:v2.5' | 'saarika:v2.5';

export type STTModes = 'transcribe' | 'translate' | 'verbatim' | 'translit' | 'codemix';

/**
 * Languages supported by saarika:v2.5 (11 Indian languages).
 * All of these are also available in {@link STTV3Languages}.
 */
export type STTV2Languages =
  | 'unknown'
  | 'hi-IN'
  | 'bn-IN'
  | 'kn-IN'
  | 'ml-IN'
  | 'mr-IN'
  | 'od-IN'
  | 'pa-IN'
  | 'ta-IN'
  | 'te-IN'
  | 'en-IN'
  | 'gu-IN';

export type STTV3Languages =
  | STTV2Languages
  | 'as-IN'
  | 'ur-IN'
  | 'ne-IN'
  | 'kok-IN'
  | 'ks-IN'
  | 'sd-IN'
  | 'sa-IN'
  | 'sat-IN'
  | 'mni-IN'
  | 'brx-IN'
  | 'mai-IN'
  | 'doi-IN';

export type STTLanguages = STTV2Languages | STTV3Languages;
