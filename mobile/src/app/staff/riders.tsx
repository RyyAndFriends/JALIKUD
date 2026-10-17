import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import QRCode from 'react-native-qrcode-svg';

import { BottomTabInset } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { errorMessage } from '@/lib/api';
import { staffApi, type StaffRider } from '@/lib/staff-api';

const RED = '#DC2626';
const BG = '#F4F4F6';
const TEXT = '#1C1C1E';
const GRAY = '#74747C';

type RiderStatus = NonNullable<StaffRider['availability_status']>;
const STATUS_META: Record<RiderStatus, { label: string; dot: string; chipBg: string; chipText: string }> = {
  available: { label: 'Available', dot: '#16A34A', chipBg: '#DCFCE7', chipText: '#15803D' },
  on_delivery: { label: 'On Delivery', dot: '#F59E0B', chipBg: '#FEF3C7', chipText: '#B45309' },
  not_available: { label: 'Not Available', dot: '#9CA3AF', chipBg: '#F3F4F6', chipText: '#6B7280' },
};

function riderStatus(rider: StaffRider): RiderStatus {
  const status = rider.availability_status;
  if (status && status in STATUS_META) return status;
  return rider.rider_profile?.is_active ? 'available' : 'not_available';
}

function dutyQrValue(code: string): string {
  return JSON.stringify({ type: 'duty_code', code });
}

export default function StaffRidersScreen() {
  const { token } = useAuth();
  const [riders, setRiders] = useState<StaffRider[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [dutyCode, setDutyCode] = useState<string | null>(null);
  const readyCount = riders.filter((rider) => riderStatus(rider) === 'available').length;
  const activeCount = riders.filter((rider) => riderStatus(rider) === 'on_delivery').length;

  const load = useCallback(async () => {
    if (!token) return;
    setError('');
    try {
      const [riderList, code] = await Promise.all([staffApi.riders(token), staffApi.dutyCode(token)]);
      setRiders(riderList);
      setDutyCode(code.code);
    } catch (caught) {
      setError(errorMessage(caught, 'Could not load riders.'));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  }, [load]);

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <SafeAreaView edges={['top']} style={styles.headerSafe}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>SM LANANG PREMIER · JAL-01</Text>
          <Text style={styles.title}>Riders</Text>
          <Text style={styles.subtitle}>Availability of the delivery team.</Text>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={RED} />}>
        <View style={styles.summaryRow}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryNumber}>{readyCount}</Text>
            <Text style={styles.summaryLabel}>Available</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryNumber}>{activeCount}</Text>
            <Text style={styles.summaryLabel}>Out for delivery</Text>
          </View>
        </View>

        {dutyCode && (
          <View style={styles.scanCard}>
            <QRCode value={dutyQrValue(dutyCode)} size={72} backgroundColor="#FFFFFF" color="#1C1C1E" />
            <View style={styles.scanCopy}>
              <Text style={styles.scanTitle}>Today's duty QR</Text>
              <Text style={styles.scanText}>Riders scan this code to clock in for the day.</Text>
            </View>
          </View>
        )}

        <Text style={styles.sectionTitle}>Delivery team</Text>
        {!!error && <Text style={styles.errorText}>⚠ {error}</Text>}
        {loading && riders.length === 0 && <ActivityIndicator color={RED} size="large" />}
        {riders.map((rider) => {
          const meta = STATUS_META[riderStatus(rider)];
          return (
            <View key={rider.id} style={styles.card}>
              <View style={styles.cardTop}>
                <View style={styles.avatar}><Text style={styles.avatarText}>🛵</Text></View>
                <View style={styles.copy}>
                  <Text style={styles.riderName}>{rider.name}</Text>
                  <Text style={styles.riderMeta}>{[rider.rider_profile?.vehicle_type, rider.rider_profile?.plate_number].filter(Boolean).join(' · ') || 'No vehicle on file'}</Text>
                  <Text style={styles.riderMeta}>{rider.phone || 'No phone on file'}</Text>
                </View>
                <View style={[styles.statusChip, { backgroundColor: meta.chipBg }]}>
                  <View style={[styles.statusDot, { backgroundColor: meta.dot }]} />
                  <Text style={[styles.statusText, { color: meta.chipText }]}>{meta.label}</Text>
                </View>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  headerSafe: { backgroundColor: RED },
  header: { paddingHorizontal: 16, paddingBottom: 17 },
  eyebrow: { color: 'rgba(255,255,255,0.72)', fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  title: { color: '#FFFFFF', fontSize: 25, fontWeight: '900', marginTop: 3 },
  subtitle: { color: 'rgba(255,255,255,0.76)', fontSize: 11, marginTop: 4 },
  content: { padding: 14, paddingBottom: BottomTabInset + 24 },
  errorText: { color: '#B91C1C', fontSize: 11, fontWeight: '700', marginBottom: 10 },
  summaryRow: { flexDirection: 'row', gap: 10 },
  summaryCard: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 13, padding: 12 },
  summaryNumber: { color: TEXT, fontSize: 22, fontWeight: '900' },
  summaryLabel: { color: GRAY, fontSize: 10, marginTop: 1 },
  scanCard: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12, backgroundColor: '#FFF7ED', borderWidth: 1, borderColor: '#FDBA74', borderRadius: 13, padding: 12 },
  scanIcon: { width: 38, height: 38, borderRadius: 10, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  scanIconText: { color: TEXT, fontSize: 27 },
  scanCopy: { flex: 1 },
  scanTitle: { color: TEXT, fontSize: 12, fontWeight: '900' },
  scanText: { color: GRAY, fontSize: 10, marginTop: 2 },
  scanButton: { backgroundColor: RED, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 9 },
  scanButtonText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },
  pressed: { opacity: 0.72 },
  sectionTitle: { color: TEXT, fontSize: 15, fontWeight: '900', marginTop: 20, marginBottom: 11, paddingHorizontal: 2 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 13, padding: 13, marginBottom: 10 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#FEF2F2', alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 19 },
  copy: { flex: 1 },
  riderName: { color: TEXT, fontSize: 14, fontWeight: '900' },
  riderMeta: { color: GRAY, fontSize: 10, marginTop: 2 },
  statusChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 999 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 9, fontWeight: '800' },
});
