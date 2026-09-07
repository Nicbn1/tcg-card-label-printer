---
name: D11 print sequencing
description: NIIMBOT D11 protocol order and error handling required for reliable queued label printing.
---

NIIMBOT D11 jobs must use one coherent model-specific print task; do not combine setup, page-size, raster, or completion behavior from different D11/D110 profiles. D11 16-bit fields are big-endian.

**Why:** A physical D11 accepted multiple mixed-profile jobs, fed the correct number of labels, and reported completion while printing no dots. Command acceptance proved framing and feed length, not raster compatibility.

**How to apply:** Start from a hardware-tested repository's complete task. The RFCOMM D11 path adapted from niimbot/niimprintx uses density 3, label type 1, one-byte PrintStart, PageStart, four-byte rows/columns, full `0x85` rows with zero count metadata, PageEnd, then retries PrintEnd until accepted.

Map counter-clockwise label rotation pixel-by-pixel into an opaque 96 × 400 transport bitmap; do not depend on Android's filtered negative-angle bitmap transform.

**Why:** A physical D11 fed completely blank labels after the raster switched to a filtered `-90°` bitmap transform, even though the equivalent clockwise transform had printed visible content.

**How to apply:** Preserve the desired counter-clockwise orientation with explicit source-to-transport coordinates, and test that all four logical label corners map inside the transport raster.