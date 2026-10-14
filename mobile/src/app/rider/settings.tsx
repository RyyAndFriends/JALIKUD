import { RoleSettingsScreen } from '@/components/role-settings-screen';
import { useAuth } from '@/context/auth-context';
import { errorMessage } from '@/lib/api';
import { riderApi, type RiderProfile } from '@/lib/staff-api';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

export default function RiderSettingsScreen() {
  const { token } = useAuth();
  const [profile, setProfile] = useState<RiderProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useFocusEffect(useCallback(() => {
    if (!token) return;
    riderApi.profile(token).then(setProfile).catch((caught) => setError(errorMessage(caught)));
  }, [token]));

  const pending = profile?.duty_requested_at != null;
  const available = profile?.availability_status === 'available';
  const onDelivery = profile?.availability_status === 'on_delivery';
  const status = onDelivery ? 'On Delivery' : available ? 'Available' : 'Not Available';

  const sendDutyQr = async () => {
    if (!token || busy) return;
    setBusy(true); setError('');
    try { setProfile(await riderApi.requestDuty(token)); }
    catch (caught) { setError(errorMessage(caught, 'Could not send the duty QR.')); }
    finally { setBusy(false); }
  };

  return (
    <RoleSettingsScreen
      roleLabel="Delivery Rider"
      roleIcon="🛵"
      details={[
        { label: 'Vehicle', value: [profile?.vehicle_type, profile?.plate_number].filter(Boolean).join(' · ') || 'Not set' },
        { label: 'Duty status', value: status },
      ]}>
      <Text style={styles.sectionTitle}>DUTY QR</Text>
      <View style={styles.card}>
        <View style={styles.qrBox}><Text style={styles.qrIcon}>▦</Text></View>
        <View style={styles.copy}>
          <Text style={styles.title}>{pending ? 'Waiting for staff scan' : available ? 'You are Available' : 'Request duty activation'}</Text>
          <Text style={styles.hint}>
            {pending
              ? 'Your QR was sent to staff. You become Available after they scan it.'
              : available
                ? 'You can receive a delivery assignment from staff.'
                : 'Send your duty QR to staff when you are ready to receive deliveries.'}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy || pending || available || onDelivery}
            onPress={() => void sendDutyQr()}
            style={({ pressed }) => [styles.button, (busy || pending || available || onDelivery) && styles.disabled, pressed && styles.pressed]}>
            {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.buttonText}>{pending ? 'QR Sent' : onDelivery ? 'On Delivery' : available ? 'Available' : 'Send QR to Staff'}</Text>}
          </Pressable>
          {!!error && <Text style={styles.error}>⚠ {error}</Text>}
        </View>
      </View>
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
});
