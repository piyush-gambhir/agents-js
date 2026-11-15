// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { IdentityTransform } from '../../stream/identity_transform.js';

describe('RoomIO WritableStream close guard', () => {
  it('should reject when closing an already-closed writer', async () => {
    const transform = new IdentityTransform<string>();
    const writer = transform.writable.getWriter();

    await writer.close();

    await expect(writer.close()).rejects.toThrow();
  });

  it('should reject when closing a writer on an errored stream', async () => {
    const transform = new IdentityTransform<string>();
    const writer = transform.writable.getWriter();

    await writer.abort(new Error('simulated write failure'));

    await expect(writer.close()).rejects.toThrow();
  });
});
