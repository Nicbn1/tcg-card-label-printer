---
name: D11 print sequencing
description: NIIMBOT D11 protocol order and error handling required for reliable queued label printing.
---

NIIMBOT D11 jobs must acknowledge setup commands before raster rows, acknowledge page end, and report page completion before `PrintEnd`. D11 16-bit fields are big-endian; older D11 models require `SetPageSize` to contain only the row count.

**Why:** Blindly streaming setup and ending without reading serial responses made a connected D11 feed blank labels. A physical D11 also accepted the newer D110 rows-plus-columns command and reported completion while feeding four fully blank labels.

**How to apply:** For the D11 profile, send page size as height/rows only. Await each mapped setup response, stream raster rows, await page-end response, poll status until one page completes, then acknowledge `PrintEnd`. Do not treat command acknowledgement as proof that a newer model's payload shape is compatible.

Map counter-clockwise label rotation pixel-by-pixel into an opaque 96 × 400 transport bitmap; do not depend on Android's filtered negative-angle bitmap transform.

**Why:** A physical D11 fed completely blank labels after the raster switched to a filtered `-90°` bitmap transform, even though the equivalent clockwise transform had printed visible content.

**How to apply:** Preserve the desired counter-clockwise orientation with explicit source-to-transport coordinates, and test that all four logical label corners map inside the transport raster.