import { requireOptionalNativeModule } from 'expo';

export type PrinterPermissionStatus = {
  granted: boolean;
  canAskAgain: boolean;
  status: 'granted' | 'denied';
};

export type NativePrinterDevice = {
  name: string;
  address: string;
};

export type NativePrinterConnection = {
  connected: boolean;
  address: string | null;
};

export type NativePrinterLabel = {
  lines: string[];
};

export type NativePrinterDelivery = {
  packetCount: number;
  writeMode: 'no-response-queued';
  packetBytes: number;
  /** A D11 PrintStatus notification was received after the page was sent. */
  statusReceived: boolean;
  /** D11 page number reported by the most recent print-status response. */
  completedPageCount: number | null;
};

type PriceTagPrinterNativeModule = {
  getPermissionStatusAsync(): Promise<PrinterPermissionStatus>;
  requestPermissionsAsync(): Promise<PrinterPermissionStatus>;
  scanForDevicesAsync(): Promise<NativePrinterDevice[]>;
  connectAsync(address: string): Promise<NativePrinterDevice>;
  printLabelAsync(label: NativePrinterLabel): Promise<NativePrinterDelivery>;
  disconnectAsync(): Promise<void>;
  getConnectionStateAsync(): Promise<NativePrinterConnection>;
};

const PriceTagPrinter = requireOptionalNativeModule<PriceTagPrinterNativeModule>('PriceTagPrinter');

export default PriceTagPrinter;