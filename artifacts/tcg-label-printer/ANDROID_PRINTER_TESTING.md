# Core Tech N12 Android Verification

PriceTag’s native printer module is included only in an Android development or release build. Expo Go and web intentionally save labels to history instead of attempting Bluetooth transmission.

## Build prerequisites

1. Build PriceTag as an Android development or release APK after native prebuild.
2. Install the APK on an Android phone with Bluetooth enabled.
3. Pair the Core Tech N12 in **Android Settings → Connected devices → Pair new device** before opening PriceTag.

## Physical printer smoke test

1. Open **Settings** in PriceTag and tap **Choose paired N12**.
2. Accept Android’s **Nearby devices** permission prompt.
3. Select the paired N12 by name/address, then confirm the saved-printer status changes.
4. Search for a card and tap **Print Label**.
5. Confirm the N12 prints the selected preset with the expected name, price, condition, Figureheadz website, generated date, and stale-price notice when applicable.
6. Repeat from the batch queue and a history reprint.
7. Turn off the N12 and retry. PriceTag must retain the saved history/queue item and show a connection error rather than reporting a successful print.

## Troubleshooting

- **Nearby devices permission required** — enable it for PriceTag in Android app permissions, then retry.
- **Printer not paired** — pair the N12 in Android Settings first, then refresh the paired-device list in PriceTag.
- **Connection failed** — confirm the N12 is powered on, nearby, and not already connected to another phone/app.
- **Write failed** — reconnect the printer and retry; the label remains in history or the batch queue.