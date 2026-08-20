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
import { cacheSearchResults } from '@/services/cardCache';
import { searchCardsLive } from '@/services/pricecharting';

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : '/api';
const QUEUE_KEY = '@pricetag_offline_operations_v1';
const MAX_PENDING_OPERATIONS = 6;

type PendingOperation =
  | {
      id: string;
      kind: 'search';
      query: string;
      createdAt: string;
      status: 'pending' | 'failed';
      error?: string;
    }
  | {
      id: string;
      kind: 'identify';
      imageBase64: string;
      mimeType: string;
      createdAt: string;
      status: 'pending' | 'failed';
      error?: string;
    };

interface OfflineBoothContextValue {
  pendingOperations: PendingOperation[];
  lastSyncMessage: string | null;
  isReady: boolean;
  isSyncing: boolean;
  queueSearch: (query: string) => Promise<void>;
  queueIdentification: (imageBase64: string, mimeType: string) => Promise<void>;
  retryPending: () => Promise<void>;
}

const OfflineBoothContext = createContext<OfflineBoothContextValue | null>(null);

function operationId(): string {
  return `${Date.now()}${Math.random().toString(36).slice(2, 9)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not reach the service.';
}

async function identifyCard(imageBase64: string, mimeType: string): Promise<string | null> {
  const response = await fetch(`${API_BASE}/identify-card`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64, mimeType }),
  });
  if (!response.ok) throw new Error(`Identify failed: ${response.status}`);
  const data = await response.json();
  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
  if (candidate && typeof candidate.cardName === 'string') return candidate.cardName;
  return typeof data.cardName === 'string' ? data.cardName : null;
}

export function OfflineBoothProvider({ children }: { children: React.ReactNode }) {
  const [pendingOperations, setPendingOperations] = useState<PendingOperation[]>([]);
  const operationsRef = useRef<PendingOperation[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncMessage, setLastSyncMessage] = useState<string | null>(null);
  const retryingRef = useRef(false);

  const saveOperations = useCallback((operations: PendingOperation[]) => {
    operationsRef.current = operations;
    setPendingOperations(operations);
    AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(operations)).catch(() => {
      // The active queue still remains usable for this session.
    });
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(QUEUE_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          const valid = parsed.filter(
            (item): item is PendingOperation =>
              !!item &&
              typeof item === 'object' &&
              typeof (item as PendingOperation).id === 'string' &&
              ['search', 'identify'].includes((item as PendingOperation).kind),
          );
          operationsRef.current = valid;
          setPendingOperations(valid);
        }
      })
      .catch(() => {
        // A broken local queue should never prevent normal booth operation.
      })
      .finally(() => setIsReady(true));
  }, []);

  const queueSearch = useCallback(
    async (query: string) => {
      const cleanQuery = query.trim();
      if (!cleanQuery) return;
      if (operationsRef.current.some((operation) => operation.kind === 'search' && operation.query === cleanQuery)) {
        return;
      }
      if (operationsRef.current.length >= MAX_PENDING_OPERATIONS) {
        throw new Error('Offline queue is full. Sync or clear saved requests before adding another.');
      }
      const operation: PendingOperation = {
        id: operationId(),
        kind: 'search',
        query: cleanQuery,
        createdAt: new Date().toISOString(),
        status: 'pending',
      };
      saveOperations(
        [...operationsRef.current, operation].slice(-MAX_PENDING_OPERATIONS),
      );
    },
    [saveOperations],
  );

  const queueIdentification = useCallback(
    async (imageBase64: string, mimeType: string) => {
      // Cap payload storage so a few photos cannot exhaust local app storage.
      if (imageBase64.length > 1_500_000) {
        throw new Error('This photo is too large to queue offline. Try a closer, lower-detail photo.');
      }
      if (operationsRef.current.length >= MAX_PENDING_OPERATIONS) {
        throw new Error('Offline queue is full. Sync or clear saved requests before adding another.');
      }
      const operation: PendingOperation = {
        id: operationId(),
        kind: 'identify',
        imageBase64,
        mimeType,
        createdAt: new Date().toISOString(),
        status: 'pending',
      };
      saveOperations(
        [...operationsRef.current, operation].slice(-MAX_PENDING_OPERATIONS),
      );
    },
    [saveOperations],
  );

  const retryPending = useCallback(async () => {
    if (retryingRef.current || !operationsRef.current.length) return;
    retryingRef.current = true;
    setIsSyncing(true);
    const remaining: PendingOperation[] = [];
    const completedMessages: string[] = [];

    for (const operation of operationsRef.current) {
      try {
        if (operation.kind === 'search') {
          const products = await searchCardsLive(operation.query);
          await cacheSearchResults(operation.query, products);
          completedMessages.push(`Updated ${operation.query}`);
        } else {
          const identifiedName = await identifyCard(operation.imageBase64, operation.mimeType);
          if (!identifiedName) throw new Error('No card was found in the queued photo.');
          const products = await searchCardsLive(identifiedName);
          await cacheSearchResults(identifiedName, products);
          completedMessages.push(`Identified ${identifiedName}`);
        }
      } catch (error) {
        remaining.push({ ...operation, status: 'failed', error: errorMessage(error) });
      }
    }

    saveOperations(remaining);
    if (completedMessages.length) {
      setLastSyncMessage(`${completedMessages[0]}${completedMessages.length > 1 ? ` +${completedMessages.length - 1} more` : ''}. Search to view saved matches.`);
    }
    setIsSyncing(false);
    retryingRef.current = false;
  }, [saveOperations]);

  useEffect(() => {
    if (!isReady) return;
    const timer = setInterval(() => {
      retryPending().catch(() => undefined);
    }, 30_000);
    retryPending().catch(() => undefined);
    return () => clearInterval(timer);
  }, [isReady, retryPending]);

  const value = useMemo(
    () => ({
      pendingOperations,
      lastSyncMessage,
      isReady,
      isSyncing,
      queueSearch,
      queueIdentification,
      retryPending,
    }),
    [isReady, isSyncing, lastSyncMessage, pendingOperations, queueIdentification, queueSearch, retryPending],
  );

  return <OfflineBoothContext.Provider value={value}>{children}</OfflineBoothContext.Provider>;
}

export function useOfflineBooth(): OfflineBoothContextValue {
  const context = useContext(OfflineBoothContext);
  if (!context) throw new Error('useOfflineBooth must be used inside OfflineBoothProvider');
  return context;
}