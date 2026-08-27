---
name: D11 print sequencing
description: NIIMBOT D11 protocol order and error handling required for reliable queued label printing.
---

NIIMBOT D11 jobs must send density/type, `CMD_PRINT_START`, clear, page start, page size, and quantity in that order. D11 16-bit fields and print-status page counts are big-endian.

**Why:** Encoding the 96-dot print-head width little-endian sends `0x6000`, an invalid page size that causes a physical D11 to reject label setup. A `0xDB` may arrive while no status request is active or after `PrintEnd`, so a one-off status waiter can silently lose a real failure.

**How to apply:** Send all 16-bit dimensions, quantity, row indexes, and status-page values high-byte first. Reset and latch any D11 print-error notification for the full job, check it after queued writes and before returning, and make a final status request after `PrintEnd` when notifications are available. Keep rejected batch entries retryable rather than reporting them as sent.