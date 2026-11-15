// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { withResolvers } from '../utils.js';

export function mergeReadableStreams<T>(...streams: ReadableStream<T>[]): ReadableStream<T> {
  const resolvePromises = streams.map(() => withResolvers<void>());
  return new ReadableStream<T>({
    start(controller) {
      let mustClose = false;
      Promise.all(resolvePromises.map(({ promise }) => promise))
        .then(() => {
          controller.close();
        })
        .catch((error) => {
          mustClose = true;
          controller.error(error);
        });
      for (const [index, stream] of streams.entries()) {
        (async () => {
          try {
            for await (const data of stream) {
              if (mustClose) {
                break;
              }
              controller.enqueue(data);
            }
            resolvePromises[index]!.resolve();
          } catch (error) {
            resolvePromises[index]!.reject(error);
          }
        })();
      }
    },
  });
}
