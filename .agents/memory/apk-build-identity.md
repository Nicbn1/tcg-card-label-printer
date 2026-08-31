---
name: APK build identity
description: How to make separately downloaded Android builds easy to identify and install as upgrades.
---

CI-generated Android APKs should carry the GitHub Actions workflow run number in the Android version code, user-visible version, APK filename, and uploaded artifact name. Include the commit and unique run ID in a companion build-info file.

**Why:** A fixed version code and repeated artifact name make it difficult to know which APK is installed, and Android may treat a later debug build as the same version rather than an upgrade.

**How to apply:** Keep the base app version stable for release semantics and inject a monotonic CI build number during Expo prebuild. In an installed APK, display `nativeApplicationVersion` and `nativeBuildVersion`; `expoConfig.version` can omit the packaged build identity.