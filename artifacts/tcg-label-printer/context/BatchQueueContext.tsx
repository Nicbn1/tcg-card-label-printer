import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CardProduct } from '@/services/pricecharting';
import {
  getDefaultCondition,
  type CardPriceData,
  type PriceCondition,
} from '@/services/priceSelection';
import {
  DEFAULT_LABEL_PRESET,
  type LabelField,
  type LabelPresetId,
} from '@/services/labelPresets';

export interface BatchQueueItem extends CardPriceData {
  queueId: string;
  condition: PriceCondition;
  customPrice: string;
  preset: LabelPresetId;
  customFields?: LabelField[];
  quantity: number;
  stale: boolean;
}

interface BatchQueueContextValue {
  items: BatchQueueItem[];
  isReady: boolean;
  addCard: (product: CardProduct, stale?: boolean) => boolean;
  addCopy: (queueId: string) => void;
  updateItem: (
    queueId: string,
    updates: Partial<
      Pick<BatchQueueItem, 'condition' | 'customPrice' | 'preset' | 'customFields' | 'quantity'>
    >,
  ) => void;
  removeItem: (queueId: string) => void;
  clearQueue: () => void;
}

const BatchQueueContext = createContext<BatchQueueContextValue | null>(null);
const QUEUE_STORAGE_KEY = '@pricetag_batch_queue_v1';

function snapshotProduct(product: CardProduct): CardPriceData {
  return {
    cardId: String(product.id),
    cardName: product['product-name'],
    series: product['console-name'],
    loose: product['loose-price'] ?? 0,
    cib: product['cib-price'] ?? 0,
    newPrice: product['new-price'] ?? 0,
    graded: product['graded-price'] ?? 0,
  };
}

function makeQueueItem(product: CardProduct, stale = false): BatchQueueItem {
  const snapshot = snapshotProduct(product);
  return {
    ...snapshot,
    queueId: `${Date.now()}${Math.random().toString(36).slice(2, 9)}`,
    condition: getDefaultCondition(snapshot),
    customPrice: '',
    preset: DEFAULT_LABEL_PRESET,
    quantity: 1,
    stale,
  };
}

function isStoredQueueItem(value: unknown): value is BatchQueueItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<BatchQueueItem>;
  return (
    typeof item.queueId === 'string' &&
    typeof item.cardName === 'string' &&
    typeof item.series === 'string' &&
    typeof item.cardId === 'string' &&
    typeof item.loose === 'number' &&
    typeof item.cib === 'number' &&
    typeof item.newPrice === 'number' &&
    typeof item.graded === 'number' &&
    ['loose', 'cib', 'new', 'graded', 'custom'].includes(item.condition ?? '') &&
    typeof item.customPrice === 'string'
  );
}

export function BatchQueueProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<BatchQueueItem[]>([]);
  const itemsRef = useRef<BatchQueueItem[]>([]);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(QUEUE_STORAGE_KEY)
      .then((raw) => {
        if (!active || !raw) return;
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          const restored = parsed
            .filter(isStoredQueueItem)
            .map((item) => ({
              ...item,
              preset: item.preset ?? DEFAULT_LABEL_PRESET,
              quantity: Math.max(1, item.quantity ?? 1),
              stale: item.stale ?? false,
            }));
          itemsRef.current = restored;
          setItems(restored);
        }
      })
      .catch(() => {
        // A bad or unavailable cache should not block normal batch creation.
      })
      .finally(() => {
        if (active) setIsReady(true);
      });

    return () => {
      active = false;
    };
  }, []);

  const replaceItems = useCallback((next: BatchQueueItem[]) => {
    itemsRef.current = next;
    setItems(next);
    AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(next)).catch(() => {
      // Keep the active queue usable even if a device cache write fails.
    });
  }, []);

  const addCard = useCallback(
    (product: CardProduct, stale = false): boolean => {
      if (!isReady || itemsRef.current.some((item) => item.cardId === String(product.id))) {
        return false;
      }
      replaceItems([...itemsRef.current, makeQueueItem(product, stale)]);
      return true;
    },
    [isReady, replaceItems],
  );

  const addCopy = useCallback(
    (queueId: string) => {
      const source = itemsRef.current.find((item) => item.queueId === queueId);
      if (!source) return;
      replaceItems([
        ...itemsRef.current,
        {
          ...source,
          queueId: `${Date.now()}${Math.random().toString(36).slice(2, 9)}`,
        },
      ]);
    },
    [replaceItems],
  );

  const updateItem = useCallback(
    (
      queueId: string,
      updates: Partial<
        Pick<BatchQueueItem, 'condition' | 'customPrice' | 'preset' | 'customFields' | 'quantity'>
      >,
    ) => {
      replaceItems(
        itemsRef.current.map((item) =>
          item.queueId === queueId ? { ...item, ...updates } : item,
        ),
      );
    },
    [replaceItems],
  );

  const removeItem = useCallback(
    (queueId: string) => {
      replaceItems(itemsRef.current.filter((item) => item.queueId !== queueId));
    },
    [replaceItems],
  );

  const clearQueue = useCallback(() => replaceItems([]), [replaceItems]);

  const value = useMemo(
    () => ({ items, isReady, addCard, addCopy, updateItem, removeItem, clearQueue }),
    [items, isReady, addCard, addCopy, updateItem, removeItem, clearQueue],
  );

  return <BatchQueueContext.Provider value={value}>{children}</BatchQueueContext.Provider>;
}

export function useBatchQueue(): BatchQueueContextValue {
  const context = useContext(BatchQueueContext);
  if (!context) {
    throw new Error('useBatchQueue must be used inside BatchQueueProvider');
  }
  return context;
}