// PriceCharting prices are fetched via our API server proxy (which scrapes
// pricecharting.com server-side). The direct pricecharting.com API requires
// an auth token that we don't have.
import { cacheSearchResults, getCachedSearch } from '@/services/cardCache';
import { API_BASE } from '@/services/apiBase';

export interface CardProduct {
  id: number;
  'product-name': string;
  'console-name': string;
  'loose-price': number;
  'cib-price': number;
  'new-price': number;
  'graded-price'?: number;
  'box-only-price'?: number;
  'manual-only-price'?: number;
}

export async function searchCardsLive(query: string): Promise<CardProduct[]> {
  const url = `${API_BASE}/search?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Search error: ${resp.status}`);
  const data = await resp.json();
  if (data.status !== 'success') return [];
  return (data.products as CardProduct[]) ?? [];
}

export interface CardSearchResult {
  products: CardProduct[];
  source: 'live' | 'cache';
  fetchedAt: string;
}

/**
 * Search online first, then safely fall back to a locally cached match.
 * Cached results are always marked as stale by callers instead of appearing
 * to be live PriceCharting data.
 */
export async function searchCardsWithCache(query: string): Promise<CardSearchResult> {
  const cached = await getCachedSearch(query);
  if (cached) {
    return {
      products: cached.products,
      source: 'cache',
      fetchedAt: cached.fetchedAt,
    };
  }

  try {
    const products = await searchCardsLive(query);
    const fetchedAt = new Date().toISOString();
    await cacheSearchResults(query, products, fetchedAt);
    return { products, source: 'live', fetchedAt };
  } catch (error) {
    throw error;
  }
}

/** Backwards-compatible shortcut for screens that only need the products. */
export async function searchCards(query: string): Promise<CardProduct[]> {
  return (await searchCardsWithCache(query)).products;
}

/** Refresh one cached/watchlisted card through the existing proxy. */
export async function refreshCardProduct(
  cardId: string,
  cardName: string,
): Promise<CardProduct> {
  const products = await searchCardsLive(cardName);
  const matching = products.find((product) => String(product.id) === String(cardId));
  if (!matching) {
    throw new Error('PriceCharting no longer returned this exact card.');
  }
  await cacheSearchResults(cardName, products);
  return matching;
}

export function formatPrice(cents: number | undefined | null): string {
  if (!cents || cents === 0) return 'N/A';
  return `$${(cents / 100).toFixed(2)}`;
}

export function getBestPrice(product: CardProduct): string {
  const v =
    product['loose-price'] ||
    product['cib-price'] ||
    product['new-price'] ||
    product['graded-price'];
  return formatPrice(v);
}
