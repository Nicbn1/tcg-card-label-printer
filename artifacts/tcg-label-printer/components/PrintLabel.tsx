import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { formatGeneratedDate, type LabelData } from '@/services/printer';
import { Barcode } from '@/components/Barcode';
import { getLabelFields } from '@/services/labelPresets';

interface Props {
  label: LabelData;
}

/**
 * Visual preview of the label as it will appear on 12 mm × ~50 mm tape
 * from the NIIMBOT D11 printer.
 *
 * Includes:
 *  - Card name, series, price (bigger + darker)
 *  - Code 128B barcode from the card's unique ID
 *  - Figureheadz logo on the right
 */
export function PrintLabel({ label }: Props) {
  const name   = label.cardName.length > 22 ? label.cardName.slice(0, 20) + '…' : label.cardName;
  const series = label.series.length  > 22 ? label.series.slice(0, 20)  + '…' : label.series;

  const barcodeValue = label.cardId ?? label.cardName.slice(0, 20);
  const generatedDate = formatGeneratedDate(label.generatedAt);
  const fields = getLabelFields(label);
  const includes = (field: (typeof fields)[number]) => fields.includes(field);
  const showBranding = includes('website');

  return (
    <View style={styles.outer}>
      {/* Tape spool edge — top */}
      <View style={styles.tapeEdge} />

      {/* Label body */}
      <View style={styles.labelStrip}>
        {/* Left accent bar */}
        <View style={styles.accentBar} />

        {/* Main label content */}
        <View style={styles.content}>
          {includes('name') && (
            <Text style={[styles.cardName, includes('price') && fields.length === 2 && styles.showName]} numberOfLines={1}>
              {name.toUpperCase()}
            </Text>
          )}

          {includes('set') && <Text style={styles.series} numberOfLines={1}>{series}</Text>}

          {includes('condition') && (
            <Text style={styles.condition} numberOfLines={1}>
              {label.condition ?? 'Price'}
            </Text>
          )}

          {includes('price') && (
            <Text style={[styles.value, fields.length === 2 && styles.showPrice]}>{label.value}</Text>
          )}
          {includes('sku') && <Text style={styles.inventoryText}>SKU: {label.sku ?? label.cardId ?? '—'}</Text>}
          {includes('quantity') && <Text style={styles.inventoryText}>Qty: {Math.max(1, label.quantity ?? 1)}</Text>}

          {includes('barcode') && (
            <>
              <View style={styles.barcodeRow}>
                <Barcode value={barcodeValue} height={20} unitWidth={1.2} color="#111111" />
              </View>
              <Text style={styles.barcodeLabel}>{barcodeValue}</Text>
            </>
          )}

          {(includes('website') || includes('date')) && (
            <View style={styles.footer}>
              {includes('website') && <Text style={styles.website}>figureheadz.com</Text>}
              {includes('date') && <Text style={styles.generatedDate}>Generated: {generatedDate}</Text>}
            </View>
          )}
          {label.stale && <Text style={styles.stale}>STALE PRICE · CHECK ONLINE</Text>}
        </View>

        {showBranding && (
          <>
            <View style={styles.divider} />
            <View style={styles.logoSection}>
              <Image
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                source={require('@/assets/images/figureheadz-logo.png')}
                style={styles.logo}
                resizeMode="contain"
              />
            </View>
          </>
        )}
      </View>

      {/* Tape spool edge — bottom */}
      <View style={styles.tapeEdge} />

      {/* Cut mark */}
      <View style={styles.cutRow}>
        <View style={styles.cutDash} />
        <View style={styles.cutMarker}>
          <Text style={styles.cutText}>✂</Text>
        </View>
        <View style={styles.cutDash} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    alignSelf: 'stretch',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
    elevation: 5,
    marginVertical: 4,
  },
  tapeEdge: {
    height: 6,
    backgroundColor: '#C8C2B0',
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
  },
  labelStrip: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: '#FAFAF5',
    minHeight: 116,
  },
  accentBar: {
    width: 5,
    backgroundColor: '#1A1A2E',
  },
  content: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 10,
    justifyContent: 'center',
    gap: 3,
  },
  cardName: {
    fontFamily: 'Courier New',
    fontSize: 15,
    fontWeight: '900',
    color: '#000000',
    letterSpacing: 0.6,
  },
  showName: { fontSize: 18 },
  series: {
    fontFamily: 'Courier New',
    fontSize: 11,
    fontWeight: '700',
    color: '#1A1A1A',
    letterSpacing: 0.2,
  },
  condition: {
    fontFamily: 'Courier New',
    fontSize: 8,
    fontWeight: '700',
    color: '#45413A',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  value: {
    fontFamily: 'Courier New',
    fontSize: 18,
    fontWeight: '900',
    color: '#000000',
  },
  showPrice: { fontSize: 26, marginTop: 3 },
  inventoryText: {
    fontFamily: 'Courier New',
    fontSize: 10,
    fontWeight: '700',
    color: '#1A1A1A',
  },
  stale: {
    fontFamily: 'Courier New',
    fontSize: 8,
    fontWeight: '900',
    color: '#A72F1E',
    marginTop: 2,
  },
  barcodeRow: {
    marginTop: 4,
    alignItems: 'flex-start',
  },
  barcodeLabel: {
    fontFamily: 'Courier New',
    fontSize: 7,
    color: '#444444',
    letterSpacing: 1.5,
  },
  footer: {
    marginTop: 3,
    gap: 1,
  },
  website: {
    fontFamily: 'Courier New',
    fontSize: 8,
    fontWeight: '700',
    color: '#1A1A1A',
  },
  generatedDate: {
    fontFamily: 'Courier New',
    fontSize: 7,
    color: '#555555',
  },
  divider: {
    width: 1,
    backgroundColor: '#DEDAD0',
    marginVertical: 8,
  },
  logoSection: {
    width: 90,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  logo: {
    width: 78,
    height: 72,
  },
  cutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#C8C2B0',
    height: 14,
    paddingHorizontal: 4,
  },
  cutDash: {
    flex: 1,
    height: 1,
    backgroundColor: '#888',
    marginHorizontal: 4,
  },
  cutMarker: { paddingHorizontal: 4 },
  cutText: { fontSize: 10, color: '#555' },
});
