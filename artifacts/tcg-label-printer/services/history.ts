import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LabelField, LabelPresetId } from '@/services/labelPresets';

const KEY = '@tcg_print_history_v1';
const MAX_ARCHIVED_ENTRIES = 100;

export interface HistoryEntry {
  id: string;
  cardName: string;
  series: string;
  value: string;
  /** PriceCharting card ID, used as the Square SKU for newer labels. */
  cardId?: string;
  /** Selected condition shown on the label, such as Loose or Custom. */
  condition?: string;
  /** The original generated date so previews can faithfully re-create a label. */
  generatedAt?: string;
  /** Label layout information retained for exact reprints. */
  preset?: LabelPresetId;
  customFields?: LabelField[];
  sku?: string;
  quantity?: number;
  priceCents?: number;
  /** Latest observed value, separate from the amount originally printed. */
  currentPriceCents?: number;
  previousPriceCents?: number;
  lastPriceRefreshedAt?: string;
  /** Cached values are intentionally marked so they remain obvious on reprint. */
  stale?: boolean;
  /** Reprints are audit events, never a second inventory unit. */
  isReprint?: boolean;
  /** False for audit-only reprints; excluded from collection value and Square. */
  inventoryTracked?: boolean;
  status?: 'active' | 'sold' | 'removed';
  printedAt: number;
}

/**
 * Keep the active collection authoritative even when staff reprint labels
 * repeatedly. Reprint/sold/removed records remain useful audit history, but
 * they must never evict an active unit that feeds collection value or Square.
 */
function retainHistory(entries: HistoryEntry[]): HistoryEntry[] {
  const activeInventory = entries.filter(
    (entry) =>
      entry.inventoryTracked !== false &&
      (entry.status ?? 'active') === 'active',
  );
  const archived = entries
    .filter(
      (entry) =>
        entry.inventoryTracked === false ||
        (entry.status ?? 'active') !== 'active',
    )
    .slice(0, MAX_ARCHIVED_ENTRIES);

  return [...activeInventory, ...archived].sort((left, right) => right.printedAt - left.printedAt);
}

export async function addHistoryEntry(
  data: Omit<HistoryEntry, 'id' | 'printedAt'>,
): Promise<HistoryEntry> {
  const entry: HistoryEntry = {
    ...data,
    id: `${Date.now()}${Math.random().toString(36).slice(2, 9)}`,
    printedAt: Date.now(),
    inventoryTracked: data.inventoryTracked ?? true,
    isReprint: data.isReprint ?? false,
  };
  const prev = await getHistory();
  await AsyncStorage.setItem(
    KEY,
    JSON.stringify(retainHistory([entry, ...prev])),
  );
  return entry;
}

export async function getHistory(): Promise<HistoryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is HistoryEntry =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as HistoryEntry).id === 'string' &&
          typeof (entry as HistoryEntry).cardName === 'string',
      )
      .map((entry) => ({
        ...entry,
        quantity: Math.max(1, entry.quantity ?? 1),
        status: entry.status ?? 'active',
        inventoryTracked: entry.inventoryTracked ?? true,
        isReprint: entry.isReprint ?? false,
      }));
  } catch {
    return [];
  }
}

export async function replaceHistory(entries: HistoryEntry[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(retainHistory(entries)));
}

export async function updateHistoryStatus(
  ids: string[],
  status: HistoryEntry['status'],
): Promise<HistoryEntry[]> {
  const idSet = new Set(ids);
  const entries = (await getHistory()).map((entry) =>
    idSet.has(entry.id) ? { ...entry, status: status ?? 'active' } : entry,
  );
  await replaceHistory(entries);
  return entries;
}

export async function clearHistory(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
