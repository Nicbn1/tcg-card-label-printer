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
  acknowledgedPacketCount: number;
  writeMode: 'acknowledged' | 'no-response-queued';
  packetBytes: number;
  usedFlowControl: boolean;
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