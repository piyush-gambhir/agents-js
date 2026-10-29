<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Dependency security and migration

Enabling the fork's dependency alerts exposed 133 advisories in its existing manifests and lockfile. These were real dependency advisories, including development-tool findings, and were not dismissed as false positives.

The workspace now resolves patched dependencies and pnpm audit reports zero advisories. Direct dependency updates and narrowly selected overrides cover vulnerable older transitive resolutions. The frozen lockfile records the selected versions and integrity values. No advisory ignore list is used.

## Compatibility changes

- The supported Zod peer baseline is now 4.6.6 or later. Consumers using Zod 3 must upgrade.
- Non-strict Zod 4 tool schemas retain optional properties as optional. Nullable properties can use an equivalent JSON Schema type array instead of anyOf. The updated snapshots record these version-specific representations.
- Vitest and its coverage plugin are aligned at 4.1.12. Turbo uses the v2 `tasks` configuration.
- Telemetry uses the patched OpenTelemetry SDK 2 family, with matching exporters and resource APIs.
- Custom tracer metadata must be configured in the NodeTracerProvider constructor. The second metadata argument to setTracerProvider was removed because SDK 2 no longer allows adding processors after construction. MetadataSpanProcessor is exported for this purpose:

```ts
const provider = new NodeTracerProvider({
  spanProcessors: [new MetadataSpanProcessor({ room_id: roomId }), exporterProcessor],
});
setTracerProvider(provider);
```

CI uses Node 24. The unchanged Phonic SDK remains at its previously locked version to avoid an unrelated provider API change during the dependency refresh.

The telemetry regression verifies that constructor-configured metadata reaches exported spans. Existing parent-child span assertions use SDK 2's parentSpanContext representation and retain their expected parent IDs.

The required Security checks gate includes a frozen installation, pnpm audit, and the focused telemetry tests. Default-branch alerts remain open until merge and a dependency graph refresh. Review the compatibility changes before merging; no package was published by this task.

Made by gpt-6 in Codex
