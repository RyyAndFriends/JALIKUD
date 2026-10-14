import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset } from '@/constants/theme';
import { useAuthDemo } from '@/context/auth-context';

const RED = '#DC2626';
const BG = '#F4F4F6';
const CARD = '#FFFFFF';
const TEXT = '#1C1C1E';
const GRAY = '#74747C';

type Detail = {
  label: string;
  value: string;
};

type RoleSettingsScreenProps = {
  roleLabel: string;
  roleIcon: string;
  details?: Detail[];
  children?: ReactNode;
};

const SUPPORT_ROWS = [
  { icon: '❓', label: 'Help & Support' },
  { icon: '🛡️', label: 'Privacy Policy' },
  { icon: '📞', label: 'Contact Us' },
];

export function RoleSettingsScreen({ roleLabel, roleIcon, details = [], children }: RoleSettingsScreenProps) {
  const router = useRouter();
  const { current, signOut } = useAuthDemo();
  const [pushNotifications, setPushNotifications] = useState(true);

  const handleSignOut = async () => {
    await signOut();
    router.replace('/login');
  };

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <SafeAreaView edges={['top']} style={styles.headerSafe}>
        <View style={styles.header}>
          <View style={styles.titleIconBox}>
            <Text style={styles.titleIcon}>⚙️</Text>
          </View>
          <View>
            <Text style={styles.eyebrow}>{roleLabel.toUpperCase()} ACCOUNT</Text>
            <Text style={styles.title}>Settings</Text>
          </View>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.card}>
          <View style={styles.profileRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarIcon}>{roleIcon}</Text>
            </View>
            <View style={styles.profileCopy}>
              <Text style={styles.profileName}>{current?.name ?? roleLabel}</Text>
              <Text style={styles.profileDetail}>{current?.email ?? 'Not signed in'}</Text>
              <Text style={styles.profileDetail}>{current?.phone ?? '—'}</Text>
              <View style={styles.roleBadge}>
                <Text style={styles.roleBadgeText}>{roleLabel}</Text>
              </View>
            </View>
          </View>
          {details.map((detail) => (
            <View key={detail.label} style={styles.detailRow}>
              <Text style={styles.detailLabel}>{detail.label}</Text>
              <Text style={styles.detailValue}>{detail.value}</Text>
            </View>
          ))}
        </View>

        {children}

        <Text style={styles.sectionTitle}>PREFERENCES</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.rowIconBox}><Text style={styles.rowIcon}>🔔</Text></View>
            <Text style={styles.rowLabel}>Push Notifications</Text>
            <Switch
              accessibilityLabel="Toggle push notifications"
              value={pushNotifications}
              onValueChange={setPushNotifications}
              trackColor={{ false: '#E4E4E9', true: RED }}
              thumbColor="#FFFFFF"
            />
          </View>
        </View>

        <Text style={styles.sectionTitle}>SUPPORT</Text>
        <View style={styles.card}>
          {SUPPORT_ROWS.map((row, index) => (
            <View key={row.label}>
              {index > 0 && <View style={styles.divider} />}
              <Pressable style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                <View style={styles.rowIconBox}><Text style={styles.rowIcon}>{row.icon}</Text></View>
                <Text style={styles.rowLabel}>{row.label}</Text>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            </View>
          ))}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Log out of ${roleLabel} account`}
          onPress={() => void handleSignOut()}
          style={({ pressed }) => [styles.logoutButton, pressed && styles.pressed]}>
          <Text style={styles.logoutIcon}>🚪</Text>
          <Text style={styles.logoutText}>Log Out</Text>
        </Pressable>

        <Text style={styles.version}>Jalikud v2.4.1</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  headerSafe: { backgroundColor: RED },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 16 },
  titleIconBox: { width: 38, height: 38, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' },
  titleIcon: { fontSize: 19 },
  eyebrow: { color: 'rgba(255,255,255,0.72)', fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  title: { color: '#FFFFFF', fontSize: 23, fontWeight: '900', marginTop: 1 },
  content: { padding: 14, paddingBottom: BottomTabInset + 24 },
  card: { backgroundColor: CARD, borderRadius: 14, marginBottom: 14, overflow: 'hidden' },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  avatar: { width: 60, height: 60, borderRadius: 17, backgroundColor: '#FDE8E8', alignItems: 'center', justifyContent: 'center' },
  avatarIcon: { fontSize: 29 },
  profileCopy: { flex: 1, alignItems: 'flex-start' },
  profileName: { color: TEXT, fontSize: 16, fontWeight: '900' },
  profileDetail: { color: GRAY, fontSize: 11, marginTop: 2 },
  roleBadge: { marginTop: 6, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: '#FEE2E2' },
  roleBadgeText: { color: RED, fontSize: 9, fontWeight: '900' },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, borderTopWidth: 1, borderTopColor: '#EEEEF1', paddingHorizontal: 14, paddingVertical: 11 },
  detailLabel: { color: GRAY, fontSize: 11 },
  detailValue: { flex: 1, color: TEXT, fontSize: 11, fontWeight: '700', textAlign: 'right' },
  sectionTitle: { color: GRAY, fontSize: 10, fontWeight: '800', letterSpacing: 0.7, marginBottom: 7, paddingHorizontal: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 12 },
  rowIconBox: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#FDE8E8', alignItems: 'center', justifyContent: 'center' },
  rowIcon: { fontSize: 15 },
  rowLabel: { flex: 1, color: TEXT, fontSize: 13, fontWeight: '700' },
  divider: { height: 1, backgroundColor: '#EEEEF1', marginLeft: 59 },
  chevron: { color: '#C7C7CC', fontSize: 21, lineHeight: 22 },
  pressed: { opacity: 0.7 },
  logoutButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 13, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#FECACA', paddingVertical: 14 },
  logoutIcon: { fontSize: 15 },
  logoutText: { color: RED, fontSize: 14, fontWeight: '900' },
  version: { color: GRAY, fontSize: 10, textAlign: 'center', marginTop: 16 },
});
