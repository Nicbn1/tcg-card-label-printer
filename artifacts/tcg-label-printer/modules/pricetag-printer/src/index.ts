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

type PriceTagPrinterNativeModule = {
  getPermissionStatusAsync(): Promise<PrinterPermissionStatus>;
  requestPermissionsAsync(): Promise<PrinterPermissionStatus>;
  getPairedDevicesAsync(): Promise<NativePrinterDevice[]>;
  connectAsync(address: string): Promise<NativePrinterDevice>;
  writeBase64Async(base64Data: string): Promise<void>;
  disconnectAsync(): Promise<void>;
  getConnectionStateAsync(): Promise<NativePrinterConnection>;
};

const PriceTagPrinter = requireOptionalNativeModule<PriceTagPrinterNativeModule>('PriceTagPrinter');

export default PriceTagPrinter;