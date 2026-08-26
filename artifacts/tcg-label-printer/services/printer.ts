/**
 * NIIMBOT D11 label generator + Bluetooth printer bridge.
 *
 * The D11 is a 12 mm thermal tape printer that connects over Bluetooth.
 * Labels are printed landscape on 12 mm × ~50 mm tape. The print head
 * is 96 dots wide (203 DPI × 12 mm ≈ 96 dots). We format content to fit.
 *
 * Label generation works in Expo Go. The physical D11 uses its own Niimbot BLE
 * packet protocol, encoded by the native Android module. Transmission requires
 * a native APK build —
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
  type NativePrinterDelivery,
  type NativePrinterDevice,
  type PrinterPermissionStatus,
} from '@/modules/pricetag-printer';

const SAVED_PRINTER_ADDRESS_KEY = '@pricetag_d11_printer_address';

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
 * on 12 mm × ~50 mm D11 tape.
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
 * Sends a label to the selected NIIMBOT D11 printer via BLE.
 * The local native module is intentionally absent in Expo Go and on web,
 * where this preserves the existing history-first fallback.
 */
export type PrinterDevice = NativePrinterDevice;
export type PrinterConnection = NativePrinterConnection;
export type BluetoothPermissionStatus = PrinterPermissionStatus;
export type PrinterDelivery = NativePrinterDelivery;

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

export async function scanForPrinters(): Promise<PrinterDevice[]> {
  return nativePrinter().scanForDevicesAsync();
}

export async function connectToPrinter(address?: string): Promise<PrinterDevice> {
  const targetAddress = address?.trim() || (await getSavedPrinterAddress());
  if (!targetAddress) {
    throw new Error('PRINTER_NOT_SELECTED: Choose your nearby NIIMBOT D11 in Settings before printing.');
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

/**
 * Extracts a user-readable sentence from a printer error.
 *
 * Expo native module rejections wrap the original Kotlin exception inside a
 * verbose envelope:
 *   "Call to function '...' has been rejected.\n-> Caused by: SomeClass: CODE: message"
 *
 * All Kotlin errors in PriceTagPrinterModule follow the pattern
 * "UPPER_SNAKE_CODE: Human-readable sentence." This function finds that
 * sentence, stripping both the code prefix and any Expo wrapper, so callers
 * always surface plain English to the user.
 */
export function extractPrinterErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Match "UPPER_CODE: sentence" anywhere in the string — works on bare
  // Kotlin throws and on Expo's multi-line rejection envelope.
  const match = raw.match(/\b[A-Z][A-Z0-9_]+:\s+([^\n]+)/);
  return match ? match[1].trim() : raw;
}

export async function sendToPrinter(
  deviceAddress: string,
  label: LabelData,
): Promise<PrinterDelivery> {
  const printer = nativePrinter();
  const targetAddress = deviceAddress.trim() || (await getSavedPrinterAddress());
  if (!targetAddress) {
    throw new Error('PRINTER_NOT_SELECTED: Choose your nearby NIIMBOT D11 in Settings before printing.');
  }

  await printer.connectAsync(targetAddress);
  // Keep the D11 session alive while it finishes the physical feed. Forget /
  // disconnect remains the explicit way to release the selected printer.
  return printer.printLabelAsync({ lines: getPrintableLines(label) });
}
