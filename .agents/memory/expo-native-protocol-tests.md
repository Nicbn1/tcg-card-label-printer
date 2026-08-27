---
name: Expo native protocol tests
description: How to execute Android JVM tests for a local Expo module in this workspace.
---

Android module source here does not include its own Gradle wrapper; Expo generates the enclosing Android project that owns the runnable Gradle test task.

**Why:** Invoking the module Gradle configuration directly is insufficient, and shell sessions may not inherit the Android SDK location used by prior builds.

**How to apply:** Stage the current module source into a generated Expo Android project, then run its module `testDebugUnitTest` task with `ANDROID_HOME` and `ANDROID_SDK_ROOT` explicitly set to the installed SDK.