// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';
import { downloadFileToCacheDir as hfDownload } from './hf_utils.js';
import { HG_MODEL_REPO, MODEL_REVISIONS, ONNX_FILEPATH } from './turn_detector/constants.js';

export { downloadFileToCacheDir } from './hf_utils.js';
export * as turnDetector from './turn_detector/index.js';

class EOUPlugin extends Plugin {
  constructor() {
    super({
      title: 'turn-detector',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }

  async downloadFiles(): Promise<void> {
    const { AutoTokenizer } = await import('@huggingface/transformers');

    for (const revision of Object.values(MODEL_REVISIONS)) {
      await AutoTokenizer.from_pretrained(HG_MODEL_REPO, { revision });

      await hfDownload({ repo: HG_MODEL_REPO, path: ONNX_FILEPATH, revision });
      await hfDownload({ repo: HG_MODEL_REPO, path: 'languages.json', revision });
    }
  }
}

Plugin.registerPlugin(new EOUPlugin());
