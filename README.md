# TCG Card Label Printer

An Android app for TCG card collectors. Search card prices on **PriceCharting** (free, no API key) and print **12 mm labels** to the **Core Tech N12** Bluetooth thermal printer.

## Features

- 🔍 Search any TCG card (Pokémon, MTG, Yu-Gi-Oh, etc.) via PriceCharting
- 💰 Shows Loose, CIB, New, and Graded prices
- 🖨 Formats labels for the Core Tech N12 (12 mm × ~50 mm tape)
- 📋 Print history saved locally
- 🌙 Dark collector theme

## Label Format (12 mm tape, 203 DPI, 96 dots wide)

```
CHARIZARD
Pokemon Base Set      $245.00
```

## Requirements

- Android 8.0+ device  
- Core Tech N12 Bluetooth label printer (12 mm tape)
- Pair the printer in Android **Settings → Bluetooth** first

## Development

```bash
pnpm install
pnpm --filter @workspace/tcg-label-printer run dev
# Scan QR with Expo Go — Bluetooth is simulated in Expo Go
```

## Building for Android / Enabling Bluetooth

Bluetooth printing requires a **native APK build**.

### 1 – Install the Bluetooth package

```bash
pnpm --filter @workspace/tcg-label-printer add react-native-bluetooth-classic
```

### 2 – Uncomment native code in `services/printer.ts`

Remove the `throw` statement and uncomment the `react-native-bluetooth-classic` block.

### 3 – Add Android permissions to `app.json`

```json
"android": {
  "permissions": [
    "BLUETOOTH", "BLUETOOTH_ADMIN",
    "BLUETOOTH_CONNECT", "BLUETOOTH_SCAN"
  ]
}
```

### 4 – Build APK with EAS

```bash
npx eas build --platform android --profile preview
```

Or use Android Studio after `npx expo prebuild --platform android`.

## Pricing Source

Prices from [PriceCharting](https://www.pricecharting.com) — free, no API key required.

## Tech Stack

- Expo / React Native, PriceCharting API, react-native-bluetooth-classic (native), ESC/POS protocol, AsyncStorage

## File Structure

```
services/pricecharting.ts   – PriceCharting API client
services/printer.ts         – ESC/POS label generator + BT stub (N12-tuned)
services/history.ts         – AsyncStorage print history
components/PrintLabel.tsx   – 12 mm tape label preview
app/(tabs)/index.tsx        – Search screen
app/(tabs)/settings.tsx     – History + printer info
app/card/[id].tsx           – Card detail + Print button
```

## License

MIT
