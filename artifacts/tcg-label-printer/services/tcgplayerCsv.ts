import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import type { HistoryEntry } from '@/services/history';

const STORAGE_KEY = '@pricetag_tcgplayer_inventory_v1';
const REQUIRED_HEADERS = ['TCGplayer ID', 'Product Name', 'Condition', 'TCG Marketplace Price'];
const ADD_QUANTITY_HEADER = 'Add to Quantity';

export interface TcgplayerInventory {
  headers: string[];
  rows: Record<string, string>[];
  importedAt: string;
  mappings?: TcgplayerLabelMapping[];
  quantityOverrides?: Record<string, string>;
}

export interface TcgplayerLabelMapping {
  entryId: string;
  listingKey: string;
}

export interface TcgplayerMatchReview {
  entryId: string;
  cardName: string;
  series: string;
  condition?: string;
  quantity: number;
  status: 'ambiguous' | 'unmatched';
  candidateRowIndexes: number[];
}

export interface TcgplayerMatchAnalysis {
  reviewQueue: TcgplayerMatchReview[];
  matchedRowIndexes: number[];
}

export interface TcgplayerMatchSummary {
  matchedRows: number;
  unmatchedRows: number;
  suggestedQuantity: number;
}

function normalize(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function escapeCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Parse RFC 4180-style CSV, including quoted commas and newlines.
 * TCGplayer exports frequently contain commas in product names and titles.
 */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const source = text.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      record.push(cell);
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      record.push(cell);
      if (record.some((value) => value.trim() !== '')) records.push(record);
      record = [];
      cell = '';
    } else {
      cell += character;
    }
  }

  if (cell || record.length) {
    record.push(cell);
    if (record.some((value) => value.trim() !== '')) records.push(record);
  }

  const headers = (records.shift() ?? []).map((header) => header.trim());
  const rows = records.map((values) =>
    headers.reduce<Record<string, string>>((row, header, index) => {
      row[header] = values[index] ?? '';
      return row;
    }, {}),
  );
  return { headers, rows };
}

export function validateTcgplayerCsv(headers: string[]): string | null {
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  return missing.length
    ? `This does not look like a TCGplayer pricing export. Missing: ${missing.join(', ')}.`
    : null;
}

function rowKey(row: Record<string, string>): string {
  return `${normalize(row['Product Name'])}|${normalize(row['Set Name'])}`;
}

export function tcgplayerListingKey(row: Record<string, string>, index: number): string {
  const id = row['TCGplayer ID']?.trim();
  return `${id}|${rowKey(row)}|${normalize(row.Condition)}|${id ? '' : index}`;
}

function activeEntries(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.filter(
    (entry) => entry.inventoryTracked !== false && (entry.status ?? 'active') === 'active',
  );
}

function candidateIndexes(
  inventory: TcgplayerInventory,
  entry: HistoryEntry,
): { selectedRowIndex?: number; candidateRowIndexes: number[]; status?: 'ambiguous' | 'unmatched' } {
  const mappings = inventory.mappings ?? [];
  const savedMapping = mappings.find((mapping) => mapping.entryId === entry.id);
  if (savedMapping) {
    const mappedIndex = inventory.rows.findIndex(
      (row, index) => tcgplayerListingKey(row, index) === savedMapping.listingKey,
    );
    if (mappedIndex >= 0) {
      return { selectedRowIndex: mappedIndex, candidateRowIndexes: [mappedIndex] };
    }
  }

  const nameMatches = inventory.rows.reduce<number[]>((matches, row, index) => {
    if (normalize(row['Product Name']) === normalize(entry.cardName)) matches.push(index);
    return matches;
  }, []);
  const setMatches = nameMatches.filter((index) => {
    const setName = normalize(inventory.rows[index]['Set Name']);
    const series = normalize(entry.series);
    return Boolean(series && setName) && setName === series;
  });
  const entryCondition = normalize(entry.condition);
  const exactMatches = setMatches.filter(
    (index) => entryCondition && normalize(inventory.rows[index].Condition) === entryCondition,
  );

  if (entryCondition && setMatches.length === 1 && exactMatches.length === 1) {
    return { selectedRowIndex: exactMatches[0], candidateRowIndexes: exactMatches };
  }
  if (!entryCondition && setMatches.length === 1 && !normalize(inventory.rows[setMatches[0]].Condition)) {
    return { selectedRowIndex: setMatches[0], candidateRowIndexes: setMatches };
  }
  if (setMatches.length > 0) {
    return { candidateRowIndexes: setMatches, status: 'ambiguous' };
  }
  if (nameMatches.length > 0) {
    return { candidateRowIndexes: nameMatches, status: 'ambiguous' };
  }
  return { candidateRowIndexes: [], status: 'unmatched' };
}

export function analyzeTcgplayerMatches(
  inventory: TcgplayerInventory,
  entries: HistoryEntry[],
): TcgplayerMatchAnalysis {
  const reviewQueue: TcgplayerMatchReview[] = [];
  const matchedRowIndexes = new Set<number>();

  for (const entry of activeEntries(entries)) {
    const match = candidateIndexes(inventory, entry);
    if (match.selectedRowIndex !== undefined) {
      matchedRowIndexes.add(match.selectedRowIndex);
      continue;
    }
    reviewQueue.push({
      entryId: entry.id,
      cardName: entry.cardName,
      series: entry.series,
      condition: entry.condition,
      quantity: Math.max(1, entry.quantity ?? 1),
      status: match.status ?? 'unmatched',
      candidateRowIndexes: match.candidateRowIndexes,
    });
  }

  return { reviewQueue, matchedRowIndexes: [...matchedRowIndexes] };
}

export function applySuggestedQuantities(
  inventory: TcgplayerInventory,
  entries: HistoryEntry[],
): {
  inventory: TcgplayerInventory;
  summary: TcgplayerMatchSummary;
  reviewQueue: TcgplayerMatchReview[];
  matchedRowIndexes: number[];
} {
  const analysis = analyzeTcgplayerMatches(inventory, entries);
  const active = activeEntries(entries);
  const counts = new Map<number, number>();
  const overrides = inventory.quantityOverrides ?? {};
  const mappings = new Map(
    (inventory.mappings ?? []).map((mapping) => [mapping.entryId, mapping]),
  );

  for (const entry of active) {
    const match = candidateIndexes(inventory, entry);
    if (match.selectedRowIndex === undefined) continue;
    counts.set(
      match.selectedRowIndex,
      (counts.get(match.selectedRowIndex) ?? 0) + Math.max(1, entry.quantity ?? 1),
    );
    mappings.set(entry.id, {
      entryId: entry.id,
      listingKey: tcgplayerListingKey(
        inventory.rows[match.selectedRowIndex],
        match.selectedRowIndex,
      ),
    });
  }

  let matchedRows = 0;
  let suggestedQuantity = 0;
  const matchedIndexSet = new Set(analysis.matchedRowIndexes);
  const rows = inventory.rows.map((row, index) => {
    const suggested = counts.get(index) ?? 0;
    if (suggested > 0) {
      matchedRows += 1;
      suggestedQuantity += suggested;
    }
    return {
      ...row,
      [ADD_QUANTITY_HEADER]: matchedIndexSet.has(index)
        ? overrides[tcgplayerListingKey(row, index)] ?? String(suggested)
        : '0',
    };
  });
  const quantityOverrides = Object.fromEntries(
    inventory.rows.flatMap((row, index) => {
      const key = tcgplayerListingKey(row, index);
      const override = overrides[key];
      return matchedIndexSet.has(index) && override !== undefined ? [[key, override]] : [];
    }),
  );

  return {
    inventory: {
      ...inventory,
      headers: inventory.headers.includes(ADD_QUANTITY_HEADER)
        ? inventory.headers
        : [...inventory.headers, ADD_QUANTITY_HEADER],
      rows,
      mappings: [...mappings.values()].filter((mapping) =>
        active.some((entry) => entry.id === mapping.entryId),
      ),
      quantityOverrides,
    },
    summary: {
      matchedRows,
      unmatchedRows: analysis.reviewQueue.length,
      suggestedQuantity,
    },
    reviewQueue: analysis.reviewQueue,
    matchedRowIndexes: analysis.matchedRowIndexes,
  };
}

export function confirmTcgplayerMapping(
  inventory: TcgplayerInventory,
  entries: HistoryEntry[],
  entryId: string,
  rowIndex: number,
): ReturnType<typeof applySuggestedQuantities> {
  if (!inventory.rows[rowIndex]) {
    throw new Error('That TCGplayer listing is no longer available.');
  }
  const mappings = (inventory.mappings ?? []).filter((mapping) => mapping.entryId !== entryId);
  mappings.push({
    entryId,
    listingKey: tcgplayerListingKey(inventory.rows[rowIndex], rowIndex),
  });
  return applySuggestedQuantities({ ...inventory, mappings }, entries);
}

export async function saveTcgplayerInventory(inventory: TcgplayerInventory): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(inventory));
}

export async function getTcgplayerInventory(): Promise<TcgplayerInventory | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TcgplayerInventory>;
    if (
      !Array.isArray(parsed.headers) ||
      !Array.isArray(parsed.rows) ||
      typeof parsed.importedAt !== 'string'
    ) {
      return null;
    }
    return {
      headers: parsed.headers.filter((header): header is string => typeof header === 'string'),
      rows: parsed.rows.filter(
        (row): row is Record<string, string> =>
          !!row &&
          typeof row === 'object' &&
          Object.values(row).every((value) => typeof value === 'string'),
      ),
      importedAt: parsed.importedAt,
      mappings: Array.isArray(parsed.mappings)
        ? parsed.mappings.filter(
            (mapping): mapping is TcgplayerLabelMapping =>
              !!mapping &&
              typeof mapping === 'object' &&
              typeof (mapping as TcgplayerLabelMapping).entryId === 'string' &&
              typeof (mapping as TcgplayerLabelMapping).listingKey === 'string',
          )
        : [],
      quantityOverrides:
        parsed.quantityOverrides &&
        typeof parsed.quantityOverrides === 'object' &&
        !Array.isArray(parsed.quantityOverrides)
          ? Object.fromEntries(
              Object.entries(parsed.quantityOverrides).filter(
                ([key, value]) => typeof key === 'string' && typeof value === 'string',
              ),
            )
          : {},
    };
  } catch {
    return null;
  }
}

export async function clearTcgplayerInventory(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

export function createTcgplayerCsv(inventory: TcgplayerInventory): string {
  return [
    inventory.headers.map(escapeCell).join(','),
    ...inventory.rows.map((row) =>
      inventory.headers.map((header) => escapeCell(row[header] ?? '')).join(','),
    ),
  ].join('\r\n');
}

export function tcgplayerExportFileName(now = new Date()): string {
  return `pricetag-tcgplayer-inventory-${now.toISOString().slice(0, 10)}.csv`;
}

export async function shareTcgplayerInventoryCsv(inventory: TcgplayerInventory): Promise<void> {
  const csv = createTcgplayerCsv(inventory);
  const fileName = tcgplayerExportFileName();

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
    dialogTitle: 'Export TCGplayer inventory CSV',
    mimeType: 'text/csv',
    UTI: 'public.comma-separated-values-text',
  });
}