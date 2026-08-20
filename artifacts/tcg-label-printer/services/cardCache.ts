import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CardProduct } from '@/services/pricecharting';

const CACHE_KEY = '@pricetag_card_cache_v1';
const CACHE_VERSION = 1;
const MAX_PRODUCTS = 350;
const MAX_QUERIES = 100;

export interface CachedSearch {
  products: CardProduct[];
  fetchedAt: string;
}

interface CachePayload {
  version: number;
  products: Record<string, { product: CardProduct; fetchedAt: string }>;
  queries: Record<string, { cardIds: string[]; fetchedAt: string }>;
}

function emptyCache(): CachePayload {
  return { version: CACHE_VERSION, products: {}, queries: {} };
}

function normalizedQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function readCache(): Promise<CachePayload> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return emptyCache();
    const parsed = JSON.parse(raw) as Partial<CachePayload>;
    if (parsed.version !== CACHE_VERSION || !parsed.products || !parsed.queries) {
      return emptyCache();
    }
    return {
      version: CACHE_VERSION,
      products: parsed.products,
      queries: parsed.queries,
    };
  } catch {
    return emptyCache();
  }
}

async function writeCache(cache: CachePayload): Promise<void> {
  await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

function trimCache(cache: CachePayload): CachePayload {
  const products = Object.entries(cache.products)
    .sort(([, left], [, right]) => Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt))
    .slice(0, MAX_PRODUCTS);
  const productIds = new Set(products.map(([id]) => id));
  const queries = Object.entries(cache.queries)
    .sort(([, left], [, right]) => Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt))
    .filter(([, entry]) => entry.cardIds.some((id) => productIds.has(id)))
    .slice(0, MAX_QUERIES);

  return {
    version: CACHE_VERSION,
    products: Object.fromEntries(products),
    queries: Object.fromEntries(queries),
  };
}

export async function cacheSearchResults(
  query: string,
  products: CardProduct[],
  fetchedAt = new Date().toISOString(),
): Promise<void> {
  const key = normalizedQuery(query);
  if (!key) return;

  const cache = await readCache();
  products.forEach((product) => {
    cache.products[String(product.id)] = { product, fetchedAt };
  });
  cache.queries[key] = {
    cardIds: products.map((product) => String(product.id)),
    fetchedAt,
  };
  await writeCache(trimCache(cache));
}

export async function getCachedSearch(query: string): Promise<CachedSearch | null> {
  const key = normalizedQuery(query);
  if (!key) return null;
  const cache = await readCache();
  const savedSearch = cache.queries[key];
  if (!savedSearch) return null;

  const products = savedSearch.cardIds
    .map((id) => cache.products[id]?.product)
    .filter((product): product is CardProduct => !!product);
  return products.length ? { products, fetchedAt: savedSearch.fetchedAt } : null;
}

export async function getCachedCard(cardId: string | number): Promise<CardProduct | null> {
  const cache = await readCache();
  return cache.products[String(cardId)]?.product ?? null;
}

export async function cacheCardProduct(
  product: CardProduct,
  fetchedAt = new Date().toISOString(),
): Promise<void> {
  const cache = await readCache();
  cache.products[String(product.id)] = { product, fetchedAt };
  await writeCache(trimCache(cache));
}