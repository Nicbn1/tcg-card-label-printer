/**
 * Core Tech N12 label generator + Bluetooth printer stub.
 *
 * The N12 is a 12 mm thermal tape printer that connects over Bluetooth.
 * Labels are printed landscape on 12 mm × ~50 mm tape. The print head
 * is 96 dots wide (203 DPI × 12 mm ≈ 96 dots). We format content to fit.
 *
 * Label generation (generateLabelText / generateEscPosBytes) works in
 * Expo Go. Actual Bluetooth transmission requires a native APK build —
 * see README.md → "Building for Android / Enabling Bluetooth".
 */

export interface LabelData {
  cardName: string;
  series: string;
  value: string;
}

/** Truncate a string to fit within 12 mm tape character limits. */
function fit(s: string, maxChars: number): string {
  return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
}

/**
 * Returns a plain-text representation of the label as it will appear
 * on 12 mm × ~50 mm N12 tape.
 *
 * Layout (landscape, 12 mm height):
 *   Line 1 – Card name (bold, up to ~20 chars)
 *   Line 2 – Series (left) + Value (right)
 */
export function generateLabelText(label: LabelData): string {
  const name   = fit(label.cardName.toUpperCase(), 20);
  const series = fit(label.series, 14);
  const value  = label.value;
  const row2   = `${series.padEnd(14)} ${value}`;
  return `${name}\n${row2}\n`;
}

/**
 * Generates ESC/POS byte commands for 12 mm tape width.
 *
 * N12-compatible ESC/POS settings:
 *   - Page width: 96 dots (12 mm at 203 DPI)
 *   - Font: smallest available (ESC M 1 = Font B, ~8pt)
 *   - Bold for card name
 *   - Normal for series + value
 *   - Cut at end
 *
 * These bytes can be sent over a Bluetooth SPP / BLE-serial connection.
 */
export function generateEscPosBytes(label: LabelData): Uint8Array {
  const ESC = 0x1b;
  const GS  = 0x1d;
  const enc = new TextEncoder();
  const txt = (s: string): number[] => [...enc.encode(s + '\n')];
  const cmd = (...b: number[]): number[] => b;

  const name   = fit(label.cardName.toUpperCase(), 20);
  const series = fit(label.series, 14);
  const value  = label.value;

  const bytes: number[] = [
    ...cmd(ESC, 0x40),          // Initialize printer
    ...cmd(ESC, 0x4d, 0x01),    // Font B (smaller, fits 12 mm tape)
    ...cmd(ESC, 0x61, 0x00),    // Left align
    ...cmd(ESC, 0x45, 0x01),    // Bold ON
    ...txt(name),               // Card name — bold
    ...cmd(ESC, 0x45, 0x00),    // Bold OFF
    ...txt(`${series.padEnd(14)} ${value}`), // Series + value on one line
    ...txt(''),                 // Feed gap
    ...cmd(GS, 0x56, 0x42, 0x00), // Full cut
  ];

  return new Uint8Array(bytes);
}

/**
 * Sends a label to the paired Core Tech N12 printer via Bluetooth.
 *
 * ⚠️  Requires a native APK build with react-native-bluetooth-classic.
 *     In Expo Go this always throws — the UI handles that gracefully.
 *
 * To enable:
 *   1. Install the native BT package:
 *        pnpm --filter @workspace/tcg-label-printer add react-native-bluetooth-classic
 *   2. Build as a development/release APK (see README.md).
 *   3. Uncomment the block below and remove the throw.
 */
export async function sendToPrinter(
  deviceAddress: string,
  label: LabelData,
): Promise<void> {
  throw new Error(
    'EXPO_GO_ONLY: Bluetooth printing requires a native APK build.\n' +
      'See README.md → "Building for Android / Enabling Bluetooth".',
  );

  /*
  // ─────────────────────────────────────────────────────────────────────
  // NATIVE BUILD — uncomment once react-native-bluetooth-classic is installed
  // and the app is built as an APK.
  // ─────────────────────────────────────────────────────────────────────
  // Pair the N12 via Android Bluetooth settings first, then pass its
  // MAC address here (shown in the Android BT device list).
  // ─────────────────────────────────────────────────────────────────────
  const RNBluetoothClassic =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react-native-bluetooth-classic').default;

  const device = await RNBluetoothClassic.connectToDevice(deviceAddress);

  const bytes = generateEscPosBytes(label);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  const base64 = btoa(binary);

  await device.write(base64);
  await device.disconnect();
  */
}

// Release source synchronized with artifacts/tcg-label-printer.
