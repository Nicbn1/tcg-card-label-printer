import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import type { HistoryEntry } from '@/services/history';

const SQUARE_HEADERS = [
  'Item Name',
  'Variation Name',
  'Description',
  'SKU',
  'Price',
  'Categories',
  'Reporting Category',
  'Item Type',
] as const;

export type DuplicateHandling = 'separate' | 'merge';

export interface SquareExportOptions {
  category: string;
  reportingCategory: string;
  locationName: string;
  quantityPerEntry: number;
  duplicateHandling: DuplicateHandling;
}

function isExportableInventory(entry: HistoryEntry): boolean {
  return entry.inventoryTracked !== false && (entry.status ?? 'active') === 'active';
}

export const DEFAULT_SQUARE_EXPORT_OPTIONS: SquareExportOptions = {
  category: 'Trading Cards',
  reportingCategory: 'Trading Cards',
  locationName: '',
  quantityPerEntry: 1,
  duplicateHandling: 'separate',
};

interface SquareRow {
  itemName: string;
  variationName: string;
  description: string;
  sku: string;
  price: string;
  category: string;
  reportingCategory: string;
  itemType: string;
  quantity: number;
}

function escapeCell(value: string | number): string {
  const text = String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function priceForSquare(value: string): string {
  const amount = Number.parseFloat(value.replace(/[^0-9.]/g, ''));
  return Number.isFinite(amount) ? amount.toFixed(2) : '';
}

function skuForSquare(entry: HistoryEntry): string {
  const condition = (entry.condition ?? 'Price').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const price = priceForSquare(entry.value).replace('.', '') || 'NA';
  const source = entry.cardId
    ? `PC-${entry.cardId}-${condition}-${price}`
    : `FH-${entry.id}-${condition}-${price}`;
  return source.replace(/[^A-Za-z0-9-]/g, '-').toUpperCase();
}

function dateForDescription(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US');
}

/**
 * Produces a Square Item Library CSV from generated labels.
 *
 * Square requires Item Name, Variation Name, Description, and SKU. Every
 * history item is converted into a physical-good variation with a chosen
 * quantity. The caller can merge matching SKUs for a cleaner Square import.
 */
export function getSquareExportPreview(
  entries: HistoryEntry[],
  options: SquareExportOptions = DEFAULT_SQUARE_EXPORT_OPTIONS,
): { sourceEntries: number; outputRows: number; mergedEntries: number } {
  const inventoryEntries = entries.filter(isExportableInventory);
  const outputRows =
    options.duplicateHandling === 'merge'
      ? new Set(inventoryEntries.map((entry) => skuForSquare(entry))).size
      : inventoryEntries.length;
  return {
    sourceEntries: inventoryEntries.length,
    outputRows,
    mergedEntries: inventoryEntries.length - outputRows,
  };
}

function createRows(entries: HistoryEntry[], options: SquareExportOptions): SquareRow[] {
  const quantity = Math.max(1, Math.floor(options.quantityPerEntry || 1));
  const initialRows = entries
    .filter(isExportableInventory)
    .map((entry, index) => {
    const baseVariationName = (entry.condition ?? entry.series) || 'Default';
    const baseSku = skuForSquare(entry);
    const isSeparate = options.duplicateHandling === 'separate';
    return {
      itemName: entry.cardName,
      variationName: isSeparate ? `${baseVariationName} · Label ${index + 1}` : baseVariationName,
      description: `Figureheadz PriceTag ${entry.condition ?? 'Price'} label generated ${dateForDescription(entry.printedAt)}`,
      sku: isSeparate ? `${baseSku}-${entry.id.slice(-7).toUpperCase()}` : baseSku,
      price: priceForSquare(entry.value),
      category: options.category || 'Trading Cards',
      reportingCategory: options.reportingCategory || options.category || 'Trading Cards',
      itemType: 'Physical good',
      quantity,
    };
    });

  if (options.duplicateHandling === 'separate') return initialRows;

  return Array.from(
    initialRows.reduce<Map<string, SquareRow>>((grouped, row) => {
      const existing = grouped.get(row.sku);
      if (existing) {
        existing.quantity += row.quantity;
      } else {
        grouped.set(row.sku, { ...row });
      }
      return grouped;
    }, new Map()).values(),
  );
}

export function createSquareInventoryCsv(
  entries: HistoryEntry[],
  suppliedOptions: Partial<SquareExportOptions> = {},
): string {
  const options: SquareExportOptions = {
    ...DEFAULT_SQUARE_EXPORT_OPTIONS,
    ...suppliedOptions,
  };
  const quantityHeader = options.locationName.trim()
    ? `New Quantity [${options.locationName.trim()}]`
    : 'New Quantity';
  const rows = createRows(entries, options).map((row) => [
    row.itemName,
    row.variationName,
    row.description,
    row.sku,
    row.price,
    row.category,
    row.reportingCategory,
    row.itemType,
    row.quantity,
  ]);

  return [
    [...SQUARE_HEADERS, quantityHeader].map(escapeCell).join(','),
    ...rows.map((row) => row.map(escapeCell).join(',')),
  ].join('\r\n');
}

export function squareExportFileName(now = new Date()): string {
  return `pricetag-square-inventory-${now.toISOString().slice(0, 10)}.csv`;
}

/**
 * Downloads on web and opens the native Android/iOS share sheet with a real
 * CSV file, ready to save or hand off to Square.
 */
export async function exportSquareInventoryCsv(
  entries: HistoryEntry[],
  options?: Partial<SquareExportOptions>,
): Promise<void> {
  const csv = createSquareInventoryCsv(entries, options);
  const fileName = squareExportFileName();

  if (Platform.OS === 'web') {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    return;
  }

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('File sharing is not available on this device.');
  }

  const file = new File(Paths.cache, fileName);
  file.create({ overwrite: true, intermediates: true });
  file.write(csv);

  await Sharing.shareAsync(file.uri, {
    dialogTitle: 'Export Square inventory CSV',
    mimeType: 'text/csv',
    UTI: 'public.comma-separated-values-text',
  });
}