---
name: D11 BLE readiness
description: Safe recovery for a transient Android BLE disconnect while preparing a NIIMBOT D11 connection.
---

Treat Android GATT status 147 during D11 connection setup as a transient transport failure: release the failed session, wait briefly, and retry the connection setup once.

Do not queue the status-notification descriptor write and MTU negotiation concurrently; wait for the descriptor callback before requesting MTU.

**Why:** A physical D11 can disconnect before the native setup handshake completes even when it is paired, awake, and using the correct label protocol. Android permits only one GATT operation at a time, and competing descriptor/MTU setup requests can produce an immediate post-connect drop with opaque status 147.

**How to apply:** Serialize GATT setup operations, then limit recovery to the setup-disconnect error only and allow the second failure to surface normally. Do not automatically retry `printLabel` after it has begun, because no-response BLE transport cannot prove that the printer did not start printing.