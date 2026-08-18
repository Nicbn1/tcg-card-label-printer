import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@tcg_print_history_v1';
const MAX_ENTRIES = 100;

export interface HistoryEntry {
  id: string;
  cardName: string;
  series: string;
  value: string;
  printedAt: number;
}

export async function addHistoryEntry(
  data: Omit<HistoryEntry, 'id' | 'printedAt'>,
): Promise<HistoryEntry> {
  const entry: HistoryEntry = {
    ...data,
    id: `${Date.now()}${Math.random().toString(36).slice(2, 9)}`,
    printedAt: Date.now(),
  };
  const prev = await getHistory();
  await AsyncStorage.setItem(
    KEY,
    JSON.stringify([entry, ...prev].slice(0, MAX_ENTRIES)),
  );
  return entry;
}

export async function getHistory(): Promise<HistoryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export async function clearHistory(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
