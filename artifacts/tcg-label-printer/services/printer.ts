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
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getLabelFields,
  type LabelField,
  type LabelPresetId,
} from '@/services/labelPresets';
import PriceTagPrinter, {
  type NativePrinterConnection,
  type NativePrinterDevice,
  type PrinterPermissionStatus,
} from '@/modules/pricetag-printer';

const SAVED_PRINTER_ADDRESS_KEY = '@pricetag_n12_printer_address';

export interface LabelData {
  cardName: string;
  series: string;
  value: string;
  /** Chosen PriceCharting condition or "Custom" */
  condition?: string;
  /** Unique PriceCharting product ID — used as the barcode payload */
  cardId?: string;
  /** ISO timestamp captured when this label was generated */
  generatedAt?: string;
  /** Label format selected before print. */
  preset?: LabelPresetId;
  /** Fields selected when preset is Custom. */
  customFields?: LabelField[];
  /** Optional inventory identity rendered by Inventory / Custom labels. */
  sku?: string;
  /** Physical copies represented by this label. */
  quantity?: number;
  /** Numeric price snapshot used for collection refreshes and alerts. */
  priceCents?: number;
  /** Cached offline price; never present it as a live price. */
  stale?: boolean;
}

/** Truncate a string to fit within 12 mm tape character limits. */
function fit(s: string, maxChars: number): string {
  return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
}

/** Keep the generated date short enough for the narrow thermal label. */
export function formatGeneratedDate(timestamp?: string): string {
  const date = timestamp ? new Date(timestamp) : new Date();
  return date.toLocaleDateString('en-US');
}

/**
 * Returns a plain-text representation of the label as it will appear
 * on 12 mm × ~50 mm N12 tape.
 *
 * Layout (landscape, 12 mm height):
 *   Line 1 – Card name (bold, up to ~20 chars)
 *   Line 2 – Series (left) + Value (right)
 *   Line 3 – Price condition
 *   Line 4 – Website
 *   Line 5 – Generated date
 */
export function generateLabelText(label: LabelData): string {
  return getPrintableLines(label).join('\n') + '\n';
}

export function getPrintableLines(label: LabelData): string[] {
  const fields = getLabelFields(label);
  const includes = (field: LabelField) => fields.includes(field);
  const lines: string[] = [];
  const name = fit(label.cardName.toUpperCase(), 20);
  const series = fit(label.series, 14);
  const condition = fit(label.condition ?? 'Price', 20);
  const barcodeValue = fit(label.cardId ?? label.cardName, 20);

  if (includes('name')) lines.push(name);
  if (includes('set') && includes('price')) {
    lines.push(`${series.padEnd(14)} ${label.value}`);
  } else {
    if (includes('set')) lines.push(series);
    if (includes('price')) lines.push(label.value);
  }
  if (includes('condition')) lines.push(condition);
  if (includes('sku')) lines.push(`SKU: ${fit(label.sku ?? label.cardId ?? '—', 16)}`);
  if (includes('quantity')) lines.push(`Qty: ${Math.max(1, label.quantity ?? 1)}`);
  if (includes('barcode')) lines.push(`ID: ${barcodeValue}`);
  if (includes('website')) lines.push('figureheadz.com');
  if (includes('date')) lines.push(`Generated: ${formatGeneratedDate(label.generatedAt)}`);
  if (label.stale) lines.push('STALE PRICE');
  return lines;
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

  const lines = getPrintableLines(label);

  const bytes: number[] = [
    ...cmd(ESC, 0x40),          // Initialize printer
    ...cmd(ESC, 0x4d, 0x01),    // Font B (smaller, fits 12 mm tape)
    ...cmd(ESC, 0x61, 0x00),    // Left align
    ...cmd(ESC, 0x45, 0x01),    // Bold ON
    ...(lines[0] ? txt(lines[0]) : []), // First selected field — bold
    ...cmd(ESC, 0x45, 0x00),    // Bold OFF
    ...lines.slice(1).flatMap((line) => txt(line)),
    ...txt(''),                 // Feed gap
    ...cmd(GS, 0x56, 0x42, 0x00), // Full cut
  ];

  return new Uint8Array(bytes);
}

/**
 * Sends a label to the selected Core Tech N12 printer via Bluetooth.
 * The local native module is intentionally absent in Expo Go and on web,
 * where this preserves the existing history-first fallback.
 */
export type PrinterDevice = NativePrinterDevice;
export type PrinterConnection = NativePrinterConnection;
export type BluetoothPermissionStatus = PrinterPermissionStatus;

function nativePrinter() {
  if (!PriceTagPrinter) {
    throw new Error(
      'EXPO_GO_ONLY: Bluetooth printing requires an Android development or release APK.',
    );
  }
  return PriceTagPrinter;
}

export function isNativePrinterAvailable(): boolean {
  return PriceTagPrinter !== null;
}

export async function getSavedPrinterAddress(): Promise<string | null> {
  return AsyncStorage.getItem(SAVED_PRINTER_ADDRESS_KEY);
}

export async function setSavedPrinterAddress(address: string): Promise<void> {
  await AsyncStorage.setItem(SAVED_PRINTER_ADDRESS_KEY, address.trim().toUpperCase());
}

export async function clearSavedPrinterAddress(): Promise<void> {
  await AsyncStorage.removeItem(SAVED_PRINTER_ADDRESS_KEY);
}

export async function getBluetoothPermissionStatus(): Promise<BluetoothPermissionStatus> {
  return nativePrinter().getPermissionStatusAsync();
}

export async function requestBluetoothPermissions(): Promise<BluetoothPermissionStatus> {
  return nativePrinter().requestPermissionsAsync();
}

export async function getPairedPrinters(): Promise<PrinterDevice[]> {
  return nativePrinter().getPairedDevicesAsync();
}

export async function connectToPrinter(address?: string): Promise<PrinterDevice> {
  const targetAddress = address?.trim() || (await getSavedPrinterAddress());
  if (!targetAddress) {
    throw new Error('PRINTER_NOT_SELECTED: Choose a paired Core Tech N12 in Settings before printing.');
  }
  const device = await nativePrinter().connectAsync(targetAddress);
  await setSavedPrinterAddress(device.address);
  return device;
}

export async function disconnectPrinter(): Promise<void> {
  if (PriceTagPrinter) {
    await PriceTagPrinter.disconnectAsync();
  }
}

export async function getPrinterConnection(): Promise<PrinterConnection> {
  if (!PriceTagPrinter) return { connected: false, address: null };
  return PriceTagPrinter.getConnectionStateAsync();
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof globalThis.btoa !== 'function') {
    throw new Error('PRINTER_ENCODING_UNAVAILABLE: Could not prepare the printer payload.');
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

export async function sendToPrinter(
  deviceAddress: string,
  label: LabelData,
): Promise<void> {
  const printer = nativePrinter();
  const targetAddress = deviceAddress.trim() || (await getSavedPrinterAddress());
  if (!targetAddress) {
    throw new Error('PRINTER_NOT_SELECTED: Choose a paired Core Tech N12 in Settings before printing.');
  }

  await printer.connectAsync(targetAddress);
  try {
    await printer.writeBase64Async(bytesToBase64(generateEscPosBytes(label)));
  } finally {
    await printer.disconnectAsync().catch(() => undefined);
  }
}
