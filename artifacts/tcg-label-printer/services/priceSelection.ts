import { formatPrice } from '@/services/pricecharting';
import type { LabelData } from '@/services/printer';
import {
  DEFAULT_LABEL_PRESET,
  type LabelField,
  type LabelPresetId,
} from '@/services/labelPresets';

export type PriceCondition = 'loose' | 'cib' | 'new' | 'graded' | 'custom';

export interface CardPriceData {
  cardId?: string;
  cardName: string;
  series: string;
  loose: number;
  cib: number;
  newPrice: number;
  graded: number;
}

export const PRICE_CONDITIONS: ReadonlyArray<{
  key: PriceCondition;
  label: string;
}> = [
  { key: 'loose', label: 'Loose' },
  { key: 'cib', label: 'CIB' },
  { key: 'new', label: 'New' },
  { key: 'graded', label: 'Graded' },
  { key: 'custom', label: 'Custom' },
];

export function getConditionLabel(condition: PriceCondition): string {
  return PRICE_CONDITIONS.find((option) => option.key === condition)?.label ?? 'Custom';
}

export function getDefaultCondition(card: CardPriceData): PriceCondition {
  if (card.loose > 0) return 'loose';
  if (card.cib > 0) return 'cib';
  if (card.newPrice > 0) return 'new';
  if (card.graded > 0) return 'graded';
  return 'custom';
}

export function customPriceToCents(value?: string): number {
  if (!value?.trim()) return 0;
  const parsed = Number.parseFloat(value.replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
}

export function getSelectedPriceCents(
  card: CardPriceData,
  condition: PriceCondition,
  customPrice?: string,
): number {
  switch (condition) {
    case 'loose':
      return card.loose;
    case 'cib':
      return card.cib;
    case 'new':
      return card.newPrice;
    case 'graded':
      return card.graded;
    case 'custom':
      return customPriceToCents(customPrice);
  }
}

export function makeLabelData(
  card: CardPriceData,
  condition: PriceCondition,
  customPrice?: string,
  generatedAt = new Date().toISOString(),
  preset: LabelPresetId = DEFAULT_LABEL_PRESET,
  customFields?: LabelField[],
  quantity = 1,
  stale = false,
): LabelData {
  const priceCents = getSelectedPriceCents(card, condition, customPrice);
  const conditionLabel = getConditionLabel(condition);
  return {
    cardName: card.cardName,
    series: card.series,
    value: formatPrice(priceCents),
    cardId: card.cardId,
    condition: conditionLabel,
    generatedAt,
    preset,
    customFields,
    quantity,
    sku: card.cardId ? `PC-${card.cardId}-${conditionLabel.toUpperCase()}` : undefined,
    priceCents,
    stale,
  };
}