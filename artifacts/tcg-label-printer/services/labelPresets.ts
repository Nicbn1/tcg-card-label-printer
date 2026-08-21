import type { LabelData } from '@/services/printer';

export type LabelPresetId = 'full' | 'compact' | 'inventory' | 'show' | 'custom';

export type LabelField =
  | 'name'
  | 'set'
  | 'price'
  | 'condition'
  | 'barcode'
  | 'website'
  | 'date'
  | 'sku'
  | 'quantity';

export const LABEL_FIELDS: ReadonlyArray<{ key: LabelField; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'set', label: 'Set' },
  { key: 'price', label: 'Price' },
  { key: 'condition', label: 'Condition' },
  { key: 'barcode', label: 'Barcode' },
  { key: 'website', label: 'Website' },
  { key: 'date', label: 'Date' },
  { key: 'sku', label: 'SKU' },
  { key: 'quantity', label: 'Qty' },
];

export const LABEL_PRESETS: ReadonlyArray<{
  key: LabelPresetId;
  label: string;
  description: string;
}> = [
  {
    key: 'full',
    label: 'Full',
    description: 'Name, set, price, barcode, website, date',
  },
  { key: 'compact', label: 'Compact', description: 'Name and price' },
  {
    key: 'inventory',
    label: 'Inventory',
    description: 'Name, set, SKU, and quantity',
  },
  { key: 'show', label: 'Show table', description: 'Large name and price' },
  { key: 'custom', label: 'Custom', description: 'Choose your own fields' },
];

const PRESET_FIELDS: Record<Exclude<LabelPresetId, 'custom'>, LabelField[]> = {
  full: ['name', 'set', 'condition', 'price', 'barcode', 'website', 'date'],
  compact: ['name', 'price'],
  inventory: ['name', 'set', 'sku', 'quantity'],
  show: ['name', 'price'],
};

export const DEFAULT_LABEL_PRESET: LabelPresetId = 'full';
export const DEFAULT_CUSTOM_FIELDS: LabelField[] = [...PRESET_FIELDS.full];

export function getPresetFields(
  preset: LabelPresetId | undefined,
  customFields?: LabelField[],
): LabelField[] {
  if (preset === 'custom') {
    return customFields?.length ? customFields : DEFAULT_CUSTOM_FIELDS;
  }
  const resolvedPreset = preset ?? DEFAULT_LABEL_PRESET;
  return PRESET_FIELDS[resolvedPreset === 'custom' ? 'full' : resolvedPreset];
}

export function getLabelFields(label: LabelData): LabelField[] {
  return getPresetFields(label.preset, label.customFields);
}

export function getLabelPresetLabel(preset?: LabelPresetId): string {
  return LABEL_PRESETS.find((option) => option.key === (preset ?? DEFAULT_LABEL_PRESET))
    ?.label ?? 'Full';
}