---
name: N12 BLE readiness
description: Android BLE compatibility rules for the N12 printer transport.
---

Do not make a successful N12 connection depend on `onMtuChanged`, optional flow-control
descriptor callbacks, or `onCharacteristicWrite` when using `WRITE_TYPE_NO_RESPONSE`.

**Why:** Low-cost BLE printer firmware and several Android stacks can accept an MTU request
or flow-control descriptor write without ever reporting its callback, and no-response writes
have no reliable write-completion callback. Treating either callback as mandatory turns a
usable connection into a false timeout; a pending descriptor operation can also block the
first print packet in Android's GATT queue.

**How to apply:** Keep safe 20-byte, paced packets as the baseline. Do not queue MTU
negotiation or optional FF03 credit notifications on the connection-to-first-print path
unless their callback behavior is proven reliable and isolated from print operations. Include
bonded devices in discovery because N12 firmware may stop advertising after pairing.

For print dispatch, send the setup and raster phase first, give the printer about two seconds
to stage and decompress it, then send the stop/feed footer. Keep the GATT session alive after
the footer; an immediate app-level disconnect can silently cancel a BLE-acknowledged print.

**Why:** The public PrintMaster protocol documents this as a two-phase flow, and the N12 can
acknowledge every BLE packet while still dropping a job whose footer or disconnect arrives
before its small raster buffer is ready.

**How to apply:** Treat a write acknowledgement as transport evidence only. Preserve an
explicit user disconnect path, but do not put unconditional disconnect cleanup around a print.