import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import {
  LABEL_FIELDS,
  LABEL_PRESETS,
  type LabelField,
  type LabelPresetId,
} from '@/services/labelPresets';

interface Props {
  preset: LabelPresetId;
  customFields?: LabelField[];
  onPresetChange: (preset: LabelPresetId) => void;
  onCustomFieldsChange: (fields: LabelField[]) => void;
  compact?: boolean;
}

export function LabelPresetPicker({
  preset,
  customFields = [],
  onPresetChange,
  onCustomFieldsChange,
  compact = false,
}: Props) {
  const colors = useColors();

  const toggleField = (field: LabelField) => {
    onCustomFieldsChange(
      customFields.includes(field)
        ? customFields.filter((current) => current !== field)
        : [...customFields, field],
    );
  };

  return (
    <View style={styles.wrapper}>
      {!compact && (
        <Text style={[styles.heading, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
          LABEL FORMAT
        </Text>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presetRow}>
        {LABEL_PRESETS.map((option) => {
          const selected = preset === option.key;
          return (
            <TouchableOpacity
              key={option.key}
              onPress={() => onPresetChange(option.key)}
              style={[
                styles.preset,
                {
                  backgroundColor: selected ? colors.primary : colors.accent,
                  borderColor: selected ? colors.primary : colors.border,
                },
              ]}
              accessibilityLabel={`${option.label} label preset`}
            >
              <Text
                style={[
                  styles.presetText,
                  {
                    color: selected ? colors.primaryForeground : colors.foreground,
                    fontFamily: 'Inter_600SemiBold',
                  },
                ]}
              >
                {option.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      {!compact && (
        <Text style={[styles.description, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
          {LABEL_PRESETS.find((option) => option.key === preset)?.description}
        </Text>
      )}
      {preset === 'custom' && (
        <View style={styles.customFields}>
          <Text style={[styles.customTitle, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
            CUSTOM FIELDS
          </Text>
          <View style={styles.fieldGrid}>
            {LABEL_FIELDS.map((field) => {
              const selected = customFields.includes(field.key);
              return (
                <TouchableOpacity
                  key={field.key}
                  onPress={() => toggleField(field.key)}
                  style={[
                    styles.field,
                    {
                      backgroundColor: selected ? colors.primary : colors.card,
                      borderColor: selected ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.fieldText,
                      {
                        color: selected ? colors.primaryForeground : colors.foreground,
                        fontFamily: 'Inter_500Medium',
                      },
                    ]}
                  >
                    {field.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {!customFields.length && (
            <Text style={[styles.helper, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
              Select at least one field. Full fields are shown until you choose.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: 7 },
  heading: { fontSize: 11, letterSpacing: 0.8 },
  presetRow: { gap: 7, paddingRight: 4 },
  preset: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  presetText: { fontSize: 12 },
  description: { fontSize: 12, lineHeight: 17 },
  customFields: { gap: 8, marginTop: 2 },
  customTitle: { fontSize: 10, letterSpacing: 0.7 },
  fieldGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  field: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6 },
  fieldText: { fontSize: 12 },
  helper: { fontSize: 11, lineHeight: 16 },
});