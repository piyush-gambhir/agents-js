// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  define: {
    __PACKAGE_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0-test'),
  },
  test: {
    include: ['**/*.test.ts'],
    name: 'nodejs',
    environment: 'node',
    testTimeout: 5_000,
    env: loadEnv(mode, process.cwd(), ''),
    setupFiles: ['./vitest.setup.ts'],
  },
}));
