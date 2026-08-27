# NIIMBOT D11 12 mm Android Verification

PriceTag’s native printer module is included only in an Android development or release build. Expo Go and web intentionally save labels to history instead of attempting Bluetooth transmission.

## Build prerequisites

1. Build a fresh PriceTag Android development or release APK after the D11 protocol update. Do not use an APK produced before the update.
2. Install the APK on an Android phone with Bluetooth enabled.
3. Load genuine **12 mm** D11 tape and pair the NIIMBOT D11 in **Android Settings → Connected devices → Pair new device** before opening PriceTag.

## Protocol preflight

The build under test must send the 96-dot page width as big-endian `00 60`, a roughly 400-dot landscape length, and must start the print task before page clear/start/size commands. Text must read horizontally along the long edge of the tape. The D11 uses no-response BLE writes, so a successful Android queue operation alone is not printer acknowledgement. Only an incoming D11 print-status notification may be described as printer status.

## Physical printer smoke test

1. Open **Settings** in PriceTag and tap **Find nearby D11**.
2. Accept Android’s **Nearby devices** permission prompt.
3. Select the paired D11 by name/address, then confirm the saved-printer status changes.
4. Search for a card and tap **Print Label**.
5. Confirm one card label prints horizontally along the long edge at the full **12 mm** tape width with legible content: name, price, condition, Figureheadz website, generated date, and stale-price notice when applicable.
6. Add at least three cards to the batch queue and print the batch. Confirm every item prints in order, then reopen the queue and confirm it is empty.
7. Add a new queue item, turn off the D11 before printing it, and retry. Confirm the item remains queued and the alert gives a useful connection/retry message.
8. With the D11 powered on, deliberately cause a setup rejection (for example, use incompatible tape if available). Confirm the affected item remains queued and the alert says that the D11 rejected the label setup.
9. Exercise the setup-disconnect path by powering off the D11 after selecting it but before the first print packet is sent, then power it back on and retry. Confirm PriceTag retries setup once, does not resend any already-dispatched print data, and sends the queued item only after the reconnect succeeds.
10. Reprint a history item. When the app only queued no-response BLE writes, confirm its wording says **queued**, not acknowledged or status received. When a D11 status notification arrives, confirm it says **D11 status received**.

## Troubleshooting

- **Nearby devices permission required** — enable it for PriceTag in Android app permissions, then retry.
- **Printer not paired** — pair the D11 in Android Settings first, then refresh the paired-device list in PriceTag.
- **Connection failed** — confirm the D11 is powered on, nearby, and not already connected to another phone/app.
- **Write failed** — reconnect the printer and retry; the label remains in history or the batch queue.
- **Label setup rejected** — confirm 12 mm tape is installed, then retry. The affected batch item stays queued.