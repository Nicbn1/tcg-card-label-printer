const API_BASE = 'https://www.pricecharting.com/api';

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

export async function searchCards(query: string): Promise<CardProduct[]> {
  const url = `${API_BASE}/products?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`PriceCharting error: ${resp.status}`);
  const data = await resp.json();
  if (data.status !== 'success') return [];
  return (data.products as CardProduct[]) ?? [];
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
