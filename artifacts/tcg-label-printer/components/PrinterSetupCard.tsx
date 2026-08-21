import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import {
  clearSavedPrinterAddress,
  connectToPrinter,
  disconnectPrinter,
  getBluetoothPermissionStatus,
  getSavedPrinterAddress,
  isNativePrinterAvailable,
  requestBluetoothPermissions,
  scanForPrinters,
  setSavedPrinterAddress,
  type PrinterDevice,
} from '@/services/printer';

export function PrinterSetupCard() {
  const colors = useColors();
  const [devices, setDevices] = useState<PrinterDevice[]>([]);
  const [savedAddress, setSavedAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isNativeBuild = isNativePrinterAvailable();

  const loadSavedPrinter = useCallback(async () => {
    setSavedAddress(await getSavedPrinterAddress());
  }, []);

  useEffect(() => {
    loadSavedPrinter().catch(() => undefined);
  }, [loadSavedPrinter]);

  const findNearbyPrinters = async () => {
    if (!isNativeBuild || loading) return;
    setLoading(true);
    setMessage(null);
    try {
      const permission = await getBluetoothPermissionStatus();
      const allowed = permission.granted ? permission : await requestBluetoothPermissions();
      if (!allowed.granted) {
        setMessage('Allow Nearby devices access to find your N12.');
        return;
      }
      const nearbyDevices = await scanForPrinters();
      setDevices(nearbyDevices);
      setMessage(
        nearbyDevices.length
          ? 'Choose your N12 from the paired or nearby Bluetooth devices.'
          : 'No paired or nearby Bluetooth devices found. Turn on the N12, then scan again.',
      );
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : 'Could not find nearby Bluetooth printers.');
    } finally {
      setLoading(false);
    }
  };

  const selectPrinter = async (device: PrinterDevice) => {
    if (loading) return;
    setLoading(true);
    setMessage(null);
    try {
      await setSavedPrinterAddress(device.address);
      await connectToPrinter(device.address);
      setSavedAddress(device.address);
      setMessage(`${device.name} is ready for labels.`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : 'Could not connect to the selected printer.');
    } finally {
      setLoading(false);
    }
  };

  const forgetPrinter = async () => {
    await disconnectPrinter();
    await clearSavedPrinterAddress();
    setSavedAddress(null);
    setMessage('Printer selection cleared.');
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.header}>
        <View style={[styles.iconBox, { backgroundColor: colors.accent }]}>
          <Feather name="bluetooth" size={18} color={colors.primary} />
        </View>
        <View style={styles.copy}>
          <Text style={[styles.title, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
            Core Tech N12
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            {isNativeBuild ? 'Find your nearby printer for labels' : 'Native Android build required'}
          </Text>
        </View>
        <View style={[styles.badge, { backgroundColor: colors.muted }]}>
          <Text style={[styles.badgeText, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
            12 mm labels
          </Text>
        </View>
      </View>

      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      {!isNativeBuild ? (
        <Text style={[styles.body, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
          Pair your N12 in Android settings, then install an Android APK to choose it and transmit labels. Expo Go and web safely save labels to history.
        </Text>
      ) : (
        <>
          <Text style={[styles.body, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            {savedAddress
              ? `Selected printer: ${savedAddress}`
              : 'Turn on or pair the N12, then find it below.'}
          </Text>

          <View style={styles.actions}>
            <TouchableOpacity
              onPress={findNearbyPrinters}
              disabled={loading}
              style={[styles.actionButton, { backgroundColor: colors.primary }]}
              testID="find-nearby-printers"
            >
              {loading ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Feather name="search" size={16} color={colors.primaryForeground} />
              )}
              <Text style={[styles.actionText, { color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold' }]}>
                Find nearby N12
              </Text>
            </TouchableOpacity>
            {!!savedAddress && (
              <TouchableOpacity onPress={forgetPrinter} disabled={loading} style={styles.forgetButton}>
                <Text style={[styles.forgetText, { color: colors.destructive, fontFamily: 'Inter_500Medium' }]}>
                  Forget
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {devices.map((device) => (
            <TouchableOpacity
              key={device.address}
              onPress={() => selectPrinter(device)}
              disabled={loading}
              style={[
                styles.deviceRow,
                {
                  backgroundColor: device.address === savedAddress ? colors.accent : colors.background,
                  borderColor: device.address === savedAddress ? colors.primary : colors.border,
                },
              ]}
            >
              <Feather name="printer" size={16} color={colors.primary} />
              <View style={styles.deviceCopy}>
                <Text style={[styles.deviceName, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
                  {device.name}
                </Text>
                <Text style={[styles.deviceAddress, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  {device.address}
                </Text>
              </View>
              {device.address === savedAddress && <Feather name="check" size={17} color={colors.primary} />}
            </TouchableOpacity>
          ))}
        </>
      )}

      {!!message && (
        <Text style={[styles.message, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
          {message}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginBottom: 18, padding: 16, borderRadius: 14, borderWidth: 1, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBox: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1 },
  title: { fontSize: 15 },
  subtitle: { fontSize: 12, marginTop: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  badgeText: { fontSize: 11 },
  divider: { height: 1 },
  body: { fontSize: 13, lineHeight: 20 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  actionButton: { flex: 1, minHeight: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7, paddingHorizontal: 12 },
  actionText: { fontSize: 13 },
  forgetButton: { paddingVertical: 10, paddingHorizontal: 4 },
  forgetText: { fontSize: 13 },
  deviceRow: { borderWidth: 1, borderRadius: 10, padding: 11, flexDirection: 'row', alignItems: 'center', gap: 10 },
  deviceCopy: { flex: 1 },
  deviceName: { fontSize: 13 },
  deviceAddress: { fontSize: 11, marginTop: 2 },
  message: { fontSize: 12, lineHeight: 17 },
});