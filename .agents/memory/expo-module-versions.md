---
name: Expo module versions
description: Keep added Expo modules aligned with the SDK versions Metro expects.
---

When adding an Expo module, use the version range Metro reports as expected for the active Expo SDK, rather than assuming an adjacent package version is compatible.

**Why:** Native Expo modules can install successfully yet still produce compatibility warnings or runtime/build instability when their SDK release line differs from the installed Expo runtime.

**How to apply:** After adding an Expo package, restart the Expo workflow and use its compatibility output to align the module versions before shipping the feature.