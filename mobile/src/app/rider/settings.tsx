import { RoleSettingsScreen } from '@/components/role-settings-screen';
import { useAuth } from '@/context/auth-context';
import { errorMessage } from '@/lib/api';
import { riderApi, type RiderProfile } from '@/lib/staff-api';
import { useFocusEffect } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

function parseDutyCode(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as { code?: unknown };
    if (parsed && typeof parsed.code === 'string' && parsed.code) return parsed.code;
  } catch {
    // Not JSON; fall through to the raw-string fallback.
  }
  const trimmed = data.trim();
  return trimmed ? trimmed : null;
}

export default function RiderSettingsScreen() {
  const { token } = useAuth();
  const [profile, setProfile] = useState<RiderProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const scanLock = useRef(false);

  useFocusEffect(useCallback(() => {
    if (!token) return;
    riderApi.profile(token).then(setProfile).catch((caught) => setError(errorMessage(caught)));
  }, [token]));

  const available = profile?.availability_status === 'available';
  const onDelivery = profile?.availability_status === 'on_delivery';
  const status = onDelivery ? 'On Delivery' : available ? 'Available' : 'Not Available';

  const openScanner = async () => {
    setError('');
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setError('Camera permission is required to scan the duty QR.');
        return;
      }
    }
    scanLock.current = false;
    setScanning(true);
  };

  const handleScan = async (data: string) => {
    if (scanLock.current || busy || !token) return;
    scanLock.current = true;
    setScanning(false);

    const code = parseDutyCode(data);
    if (!code) {
      setError('Scanned code is not a valid duty QR.');
      scanLock.current = false;
      return;
    }

    setBusy(true); setError('');
    try {
      setProfile(await riderApi.checkIn(token, code));
    } catch (caught) {
      setError(errorMessage(caught, 'Could not clock in.'));
    } finally {
      setBusy(false);
      scanLock.current = false;
    }
  };

  return (
    <RoleSettingsScreen
      roleLabel="Delivery Rider"
      roleIcon="🛵"
      details={[
        { label: 'Vehicle', value: [profile?.vehicle_type, profile?.plate_number].filter(Boolean).join(' · ') || 'Not set' },
        { label: 'Duty status', value: status },
      ]}>
      <Text style={styles.sectionTitle}>DUTY CHECK-IN</Text>
      <View style={styles.card}>
        <View style={styles.qrBox}><Text style={styles.qrIcon}>📷</Text></View>
        <View style={styles.copy}>
          <Text style={styles.title}>{onDelivery ? 'On Delivery' : available ? 'You are on duty' : 'Scan the duty QR to clock in'}</Text>
          <Text style={styles.hint}>
            {onDelivery
              ? 'Complete your current delivery before ending your shift.'
              : available
                ? 'You can receive a delivery assignment from staff.'
                : "Ask staff to show today's duty QR, then scan it to clock in."}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy || available || onDelivery}
            onPress={() => void openScanner()}
            style={({ pressed }) => [styles.button, (busy || available || onDelivery) && styles.disabled, pressed && styles.pressed]}>
            {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.buttonText}>{onDelivery ? 'On Delivery' : available ? 'On duty' : 'Scan duty QR'}</Text>}
          </Pressable>
          {!!error && <Text style={styles.error}>⚠ {error}</Text>}
        </View>
      </View>

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={styles.scannerContainer}>
          {scanning && (
            <CameraView
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => void handleScan(data)}
            />
          )}
          <View style={styles.scannerHeader}>
            <Text style={styles.scannerTitle}>Scan today's duty QR</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={() => setScanning(false)} style={styles.scannerClose}>
            <Text style={styles.scannerCloseText}>Cancel</Text>
          </Pressable>
        </View>
      </Modal>
    </RoleSettingsScreen>
  );
}

const styles = StyleSheet.create({
  sectionTitle: { color: '#74747C', fontSize: 10, fontWeight: '800', letterSpacing: 0.7, marginBottom: 7, paddingHorizontal: 2 },
  card: { flexDirection: 'row', gap: 12, backgroundColor: '#FFFFFF', borderRadius: 14, padding: 14, marginBottom: 14 },
  qrBox: { width: 70, height: 70, borderRadius: 12, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' },
  qrIcon: { color: '#1C1C1E', fontSize: 48, lineHeight: 52 },
  copy: { flex: 1 },
  title: { color: '#1C1C1E', fontSize: 14, fontWeight: '900' },
  hint: { color: '#74747C', fontSize: 11, lineHeight: 15, marginTop: 3 },
  button: { alignSelf: 'flex-start', backgroundColor: '#DC2626', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 9, marginTop: 10 },
  buttonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.72 },
  error: { color: '#B91C1C', fontSize: 10, fontWeight: '700', marginTop: 8 },
  scannerContainer: { flex: 1, backgroundColor: '#000000' },
  scannerHeader: { position: 'absolute', top: 64, left: 16, right: 16, alignItems: 'center' },
  scannerTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '900' },
  scannerClose: { position: 'absolute', bottom: 48, alignSelf: 'center', backgroundColor: '#DC2626', borderRadius: 12, paddingHorizontal: 28, paddingVertical: 14 },
  scannerCloseText: { color: '#FFFFFF', fontSize: 15, fontWeight: '900' },
});
