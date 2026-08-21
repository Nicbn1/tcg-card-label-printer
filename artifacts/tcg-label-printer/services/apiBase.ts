const PRODUCTION_API_DOMAIN = 'card-printer-connect.replit.app';

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

export const API_BASE = `https://${normalizeDomain(
  process.env.EXPO_PUBLIC_DOMAIN || PRODUCTION_API_DOMAIN,
)}/api`;