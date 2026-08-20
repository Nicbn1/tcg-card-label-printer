import AsyncStorage from '@react-native-async-storage/async-storage';
import { getHistory, replaceHistory, type HistoryEntry } from '@/services/history';
import { refreshCardProduct, type CardProduct } from '@/services/pricecharting';

const ALERT_THRESHOLD_KEY = '@pricetag_price_alert_threshold_v1';
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface RefreshSummary {
  entries: HistoryEntry[];
  refreshedCards: number;
  changedEntries: number;
  failedCards: number;
}

export function priceForCondition(product: CardProduct, condition?: string): number {
  switch (condition?.toLowerCase()) {
    case 'cib':
      return product['cib-price'] ?? 0;
    case 'new':
      return product['new-price'] ?? 0;
    case 'graded':
      return product['graded-price'] ?? 0;
    case 'loose':
    default:
      return product['loose-price'] ?? product['cib-price'] ?? product['new-price'] ?? 0;
  }
}

export function entryCurrentPriceCents(entry: HistoryEntry): number {
  if (typeof entry.currentPriceCents === 'number') return entry.currentPriceCents;
  if (typeof entry.priceCents === 'number') return entry.priceCents;
  const parsed = Number.parseFloat(entry.value.replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

export function entryPriceMovementCents(entry: HistoryEntry): number {
  if (typeof entry.previousPriceCents !== 'number') return 0;
  return entryCurrentPriceCents(entry) - entry.previousPriceCents;
}

export function isEntryPriceStale(entry: HistoryEntry): boolean {
  if (!entry.lastPriceRefreshedAt) return true;
  return Date.now() - Date.parse(entry.lastPriceRefreshedAt) > STALE_AFTER_MS;
}

export function activeCollectionValue(entries: HistoryEntry[]): number {
  return entries
    .filter(
      (entry) =>
        (entry.status ?? 'active') === 'active' &&
        entry.inventoryTracked !== false,
    )
    .reduce(
      (total, entry) => total + entryCurrentPriceCents(entry) * Math.max(1, entry.quantity ?? 1),
      0,
    );
}

export async function getMinimumPriceAlertCents(): Promise<number> {
  try {
    const stored = await AsyncStorage.getItem(ALERT_THRESHOLD_KEY);
    return Math.max(0, Number.parseInt(stored ?? '0', 10) || 0);
  } catch {
    return 0;
  }
}

export async function setMinimumPriceAlertCents(cents: number): Promise<void> {
  await AsyncStorage.setItem(ALERT_THRESHOLD_KEY, String(Math.max(0, Math.round(cents))));
}

export async function refreshHistoryPrices(
  suppliedEntries?: HistoryEntry[],
): Promise<RefreshSummary> {
  const entries = suppliedEntries ?? (await getHistory());
  const uniqueCards = new Map<string, HistoryEntry>();
  entries
    .filter(
      (entry) =>
        (entry.status ?? 'active') === 'active' &&
        entry.inventoryTracked !== false &&
        entry.condition?.toLowerCase() !== 'custom' &&
        !!entry.cardId,
    )
    .forEach((entry) => {
      const key = `${entry.cardId}:${entry.condition ?? 'Loose'}`;
      if (!uniqueCards.has(key)) uniqueCards.set(key, entry);
    });

  const refreshedPrices = new Map<string, number>();
  let failedCards = 0;
  for (const [key, entry] of uniqueCards) {
    try {
      const product = await refreshCardProduct(entry.cardId!, entry.cardName);
      const price = priceForCondition(product, entry.condition);
      if (price > 0) refreshedPrices.set(key, price);
      else failedCards += 1;
    } catch {
      failedCards += 1;
    }
  }

  const refreshedAt = new Date().toISOString();
  let changedEntries = 0;
  const nextEntries = entries.map((entry) => {
    const key = `${entry.cardId}:${entry.condition ?? 'Loose'}`;
    const price = refreshedPrices.get(key);
    if (!price) return entry;
    const currentPrice = entryCurrentPriceCents(entry);
    if (currentPrice !== price) changedEntries += 1;
    return {
      ...entry,
      previousPriceCents: currentPrice,
      currentPriceCents: price,
      lastPriceRefreshedAt: refreshedAt,
    };
  });

  if (refreshedPrices.size) await replaceHistory(nextEntries);
  return {
    entries: nextEntries,
    refreshedCards: refreshedPrices.size,
    changedEntries,
    failedCards,
  };
}