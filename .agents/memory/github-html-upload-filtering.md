---
name: GitHub HTML upload filtering
description: Covers the connector-side content filter that rejects HTML payloads during GitHub synchronization.
---

GitHub connector writes may be rejected by an upstream content filter when a request contains an HTML document, even when authentication and API quota are healthy.

**Why:** Multiple GitHub write APIs accepted other source and binary files but consistently rejected the mockup sandbox HTML entry point.

**How to apply:** Keep the mockup sandbox entry marker-based and generate the document through Vite's pre-transform hook. Avoid restoring a literal HTML document unless normal native Git authentication is available.