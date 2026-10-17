import { useCallback, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';

import { BottomTabInset } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { errorMessage } from '@/lib/api';
import { staffApi, type OrderStatus, type StaffOrder } from '@/lib/staff-api';

const RED = '#DC2626';
const BG = '#F4F4F6';
const TEXT = '#1C1C1E';
const GRAY = '#74747C';
const REJECTION_REASONS = ['Item sold out', 'Item temporarily unavailable', 'Store too busy', 'Other'];

type QueueFilter = 'incoming' | 'active' | 'completed' | 'cancelled';

const FILTERS: { value: QueueFilter; label: string }[] = [
  { value: 'incoming', label: 'Incoming' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
];

const NEXT_STATUS: Partial<Record<OrderStatus, { status: OrderStatus; label: string }>> = {
  confirmed: { status: 'preparing', label: 'Start preparing' },
  preparing: { status: 'ready', label: 'Mark ready' },
};

function peso(value: number): string {
  return `₱${value.toLocaleString('en-PH', { maximumFractionDigits: 0 })}`;
}

function queueOf(status: OrderStatus): QueueFilter {
  if (status === 'pending') return 'incoming';
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  return 'active';
}

function formatMeta(order: StaffOrder): string {
  const date = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(order.placed_at),
  );
  return `${date} · ${order.user?.name ?? 'Customer'}`;
}

function OrderCard({
  order,
  busy,
  onConfirm,
  onReject,
  onAdvance,
}: {
  order: StaffOrder;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
  onAdvance: (next: OrderStatus, label: string) => void;
}) {
  const isDelivery = order.order_type === 'delivery';
  const advance = NEXT_STATUS[order.status];
  const items = order.order_items ?? [];
  return (
    <View style={styles.card}>
      <View style={styles.orderHeader}>
        <View style={styles.orderHeaderCopy}>
          <Text style={styles.orderNumber}>{order.order_number}</Text>
          <Text style={styles.orderMeta}>{formatMeta(order)}</Text>
        </View>
      </View>

      <View
        accessible
        accessibilityLabel={isDelivery ? 'Delivery order' : 'Pickup order'}
        style={[styles.typeBanner, !isDelivery && styles.pickupBanner]}>
        <Text style={styles.typeIcon}>{isDelivery ? '🛵' : '🏪'}</Text>
        <Text style={[styles.typeBannerText, !isDelivery && styles.pickupBannerText]}>
          {isDelivery ? 'DELIVERY ORDER' : 'PICKUP ORDER'}
        </Text>
      </View>

      <View style={styles.itemsBox}>
        {items.map((item) => (
          <View key={`${order.id}-${item.id}`} style={styles.itemRow}>
            <Text style={styles.itemQuantity}>{item.quantity}×</Text>
            <View style={styles.itemCopy}>
              <Text style={styles.itemName}>{item.item_name}</Text>
            </View>
          </View>
        ))}
      </View>

      {order.status === 'cancelled' && (
        <View style={styles.rejectedBox}>
          <Text style={styles.rejectedTitle}>Cancelled</Text>
        </View>
      )}

      {!!order.rider && (
        <Text style={styles.riderChip}>🛵 Rider: {order.rider.name}</Text>
      )}

      <View style={styles.paymentRow}>
        <Text style={styles.paymentLabel}>
          {order.payment_method === 'gcash' ? '📱 GCash' : '💵 COD'} · {order.payment_status === 'paid' ? 'Paid ✓' : 'Unpaid'}
        </Text>
      </View>

      <View style={styles.footer}>
        <View>
          <Text style={styles.totalLabel}>Order total</Text>
          <Text style={styles.total}>{peso(Number(order.total_amount))}</Text>
        </View>
        {order.status === 'pending' ? (
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Reject order ${order.order_number}`}
              disabled={busy}
              onPress={onReject}
              style={({ pressed }) => [styles.rejectButton, pressed && styles.pressed]}>
              <Text style={styles.rejectButtonText}>Reject</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Confirm order ${order.order_number}`}
              disabled={busy}
              onPress={onConfirm}
              style={({ pressed }) => [styles.confirmButton, pressed && styles.pressed]}>
              <Text style={styles.confirmButtonText}>✓ Confirm</Text>
            </Pressable>
          </View>
        ) : advance ? (
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${advance.label} for ${order.order_number}`}
              disabled={busy}
              onPress={() => onAdvance(advance.status, advance.label)}
              style={({ pressed }) => [styles.confirmButton, pressed && styles.pressed]}>
              <Text style={styles.confirmButtonText}>{advance.label}</Text>
            </Pressable>
          </View>
        ) : order.status === 'ready' && isDelivery ? (
          <View style={[styles.statusBadge, styles.statusReady]}>
            <Text style={[styles.statusBadgeText, styles.statusReadyText]}>Ready for rider</Text>
          </View>
        ) : order.status === 'ready' ? (
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Complete pickup ${order.order_number}`}
              disabled={busy}
              onPress={() => onAdvance('completed', 'Complete pickup')}
              style={({ pressed }) => [styles.confirmButton, pressed && styles.pressed]}>
              <Text style={styles.confirmButtonText}>✓ Complete pickup</Text>
            </Pressable>
          </View>
        ) : order.status === 'out_for_delivery' ? (
          <View style={[styles.statusBadge, styles.statusTransit]}>
            <Text style={[styles.statusBadgeText, styles.statusTransitText]}>On the way</Text>
          </View>
        ) : order.status === 'completed' ? (
          <View style={[styles.statusBadge, styles.statusDone]}>
            <Text style={[styles.statusBadgeText, styles.statusDoneText]}>✓ Done</Text>
          </View>
        ) : (
          <View style={[styles.statusBadge, styles.statusRejected]}>
            <Text style={[styles.statusBadgeText, styles.statusRejectedText]}>✕ Cancelled</Text>
          </View>
        )}
      </View>
    </View>
  );
}

export default function StaffOrdersScreen() {
  const { token, user } = useAuth();
  const insets = useSafeAreaInsets();
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState<QueueFilter>('incoming');
  const [rejectingOrder, setRejectingOrder] = useState<StaffOrder | null>(null);
  const [reason, setReason] = useState(REJECTION_REASONS[0]);
  const [note, setNote] = useState('');
  const [feedback, setFeedback] = useState('');

  const staffInitials = (user?.name ?? 'ST')
    .split(' ')
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const load = useCallback(async () => {
    if (!token) return;
    setLoadError('');
    try {
      const liveOrders = await staffApi.orders(token);
      setOrders(liveOrders);
    } catch (caught) {
      setLoadError(errorMessage(caught, 'Could not load the order queue.'));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(useCallback(() => { void load().catch(() => undefined); }, [load]));

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().catch(() => undefined).finally(() => setRefreshing(false));
  }, [load]);

  const counts = useMemo(() => {
    const grouped: Record<QueueFilter, number> = { incoming: 0, active: 0, completed: 0, cancelled: 0 };
    for (const order of orders) grouped[queueOf(order.status)] += 1;
    return grouped;
  }, [orders]);
  const shownOrders = orders.filter((order) => queueOf(order.status) === filter);

  const runOn = async (id: number, operation: () => Promise<StaffOrder>, done: string) => {
    if (!token || busyId !== null) return;
    setBusyId(id);
    setLoadError('');
    try {
      const updated = await operation();
      setOrders((previous) => previous.map((order) => (order.id === id ? updated : order)));
      // Assignment details (rider chip) arrive on a fresh fetch.
      if (updated.rider_id !== undefined) void load().catch(() => undefined);
      setFeedback(done);
    } catch (caught) {
      setLoadError(errorMessage(caught, 'That action failed. Try again.'));
    } finally {
      setBusyId(null);
    }
  };

  const handleStatus = (order: StaffOrder, next: OrderStatus, label: string) => {
    if (!token) return;
    void runOn(order.id, () => staffApi.updateOrderStatus(token, order.id, next), `${order.order_number}: ${label}.`);
  };

  const handleConfirm = (order: StaffOrder) => {
    if (!token) return;
    void runOn(
      order.id,
      () => staffApi.updateOrderStatus(token, order.id, 'confirmed'),
      order.order_type === 'delivery'
        ? `${order.order_number} confirmed. A rider will be assigned automatically when it is ready.`
        : `${order.order_number} confirmed. The kitchen can start preparing it.`,
    );
  };

  const closeRejectModal = () => {
    setRejectingOrder(null);
    setReason(REJECTION_REASONS[0]);
    setNote('');
  };

  const handleReject = () => {
    if (!rejectingOrder || !token) return;
    const detail = note.trim() ? `${reason} — ${note.trim()}` : reason;
    void runOn(
      rejectingOrder.id,
      () => staffApi.updateOrderStatus(token, rejectingOrder.id, 'cancelled', detail),
      `${rejectingOrder.order_number} rejected: ${reason}.`,
    );
    closeRejectModal();
  };

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <SafeAreaView edges={['top']} style={styles.headerSafe}>
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <View>
              <Text style={styles.eyebrow}>SM LANANG PREMIER · JAL-01</Text>
              <Text style={styles.title}>Staff Orders</Text>
            </View>
            <View style={styles.staffBadge}><Text style={styles.staffBadgeText}>{staffInitials}</Text></View>
          </View>
          <View style={styles.queueSummary}>
            <Text style={styles.queueNumber}>{counts.incoming}</Text>
            <View><Text style={styles.queueTitle}>orders need action</Text><Text style={styles.queueHint}>Review newest orders first</Text></View>
          </View>
        </View>
      </SafeAreaView>

      <View style={styles.filters}>
        {FILTERS.map((item) => (
          <Pressable
            key={item.value}
            onPress={() => { setFilter(item.value); setFeedback(''); }}
            style={[styles.filter, filter === item.value && styles.filterActive]}>
            <Text style={[styles.filterText, filter === item.value && styles.filterTextActive]}>
              {item.label} ({counts[item.value]})
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={RED} />}>
        {loading && orders.length === 0 ? (
          <View style={styles.empty}><Text style={styles.emptyIcon}>📦</Text><Text style={styles.emptyTitle}>Loading queue…</Text></View>
        ) : null}
        {!!loadError && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>⚠ {loadError}</Text>
            <Pressable onPress={onRefresh} style={styles.retryButton}><Text style={styles.retryText}>Try again</Text></Pressable>
          </View>
        )}
        {feedback ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss message" onPress={() => setFeedback('')} style={styles.feedback}>
            <Text style={styles.feedbackIcon}>✓</Text><Text style={styles.feedbackText}>{feedback}</Text><Text style={styles.feedbackClose}>×</Text>
          </Pressable>
        ) : null}
        {shownOrders.length ? shownOrders.map((order) => (
          <OrderCard
            key={order.id}
            order={order}
            busy={busyId === order.id}
            onConfirm={() => handleConfirm(order)}
            onReject={() => setRejectingOrder(order)}
            onAdvance={(next, label) => handleStatus(order, next, `${order.order_number}: ${label}.`)}
          />
        )) : (
          !loading && <View style={styles.empty}><Text style={styles.emptyIcon}>🎉</Text><Text style={styles.emptyTitle}>Queue is clear</Text><Text style={styles.emptyText}>No {filter} orders right now.</Text></View>
        )}
        <View style={{ height: Math.max(insets.bottom, 12) }} />
      </ScrollView>

      <Modal visible={rejectingOrder != null} transparent animationType="slide" onRequestClose={closeRejectModal}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeRejectModal} accessibilityLabel="Close rejection dialog" />
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Reject {rejectingOrder?.order_number}</Text>
            <Text style={styles.modalSubtitle}>Select a reason. The order moves to Cancelled.</Text>
            <View style={styles.reasonList}>
              {REJECTION_REASONS.map((option) => (
                <Pressable key={option} onPress={() => setReason(option)} style={[styles.reasonOption, reason === option && styles.reasonOptionActive]}>
                  <View style={[styles.radio, reason === option && styles.radioActive]}>{reason === option && <View style={styles.radioDot} />}</View>
                  <Text style={[styles.reasonText, reason === option && styles.reasonTextActive]}>{option}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.inputLabel}>Staff note (optional)</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Add useful details..."
              placeholderTextColor="#A0A0A8"
              multiline
              maxLength={180}
              style={styles.noteInput}
            />
            <View style={styles.modalActions}>
              <Pressable onPress={closeRejectModal} style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}><Text style={styles.cancelButtonText}>Cancel</Text></Pressable>
              <Pressable onPress={handleReject} style={({ pressed }) => [styles.modalRejectButton, pressed && styles.pressed]}><Text style={styles.modalRejectText}>Reject Order</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  headerSafe: { backgroundColor: RED },
  header: { paddingHorizontal: 16, paddingBottom: 18, gap: 16 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: { color: 'rgba(255,255,255,0.75)', fontSize: 10, fontWeight: '800', letterSpacing: 0.7 },
  title: { color: '#FFFFFF', fontSize: 25, fontWeight: '900', marginTop: 3 },
  staffBadge: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  staffBadgeText: { color: RED, fontSize: 13, fontWeight: '900' },
  queueSummary: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.16)' },
  queueNumber: { color: '#FFFFFF', fontSize: 32, lineHeight: 36, fontWeight: '900' },
  queueTitle: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  queueHint: { color: 'rgba(255,255,255,0.72)', fontSize: 11, marginTop: 1 },
  filters: { flexDirection: 'row', gap: 6, padding: 12, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E7E7EB' },
  filter: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10 },
  filterActive: { backgroundColor: '#FDE8E8' },
  filterText: { color: GRAY, fontSize: 11, fontWeight: '700' },
  filterTextActive: { color: RED, fontWeight: '900' },
  content: { padding: 14, paddingBottom: BottomTabInset + 24, gap: 12 },
  feedback: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 12, borderRadius: 12, backgroundColor: '#DCFCE7', borderWidth: 1, borderColor: '#BBF7D0' },
  feedbackIcon: { color: '#15803D', fontWeight: '900' },
  feedbackText: { flex: 1, color: '#166534', fontSize: 12, fontWeight: '600' },
  feedbackClose: { color: '#15803D', fontSize: 20 },
  errorBox: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA' },
  errorText: { color: '#B91C1C', fontSize: 12, fontWeight: '700' },
  retryButton: { alignSelf: 'flex-start', backgroundColor: RED, borderRadius: 9, paddingHorizontal: 14, paddingVertical: 8 },
  retryText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  card: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 14, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  orderHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  orderHeaderCopy: { flex: 1 },
  orderNumber: { color: TEXT, fontSize: 16, fontWeight: '900' },
  orderMeta: { color: GRAY, fontSize: 11, marginTop: 3 },
  typeBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, backgroundColor: '#E0E7FF', borderWidth: 1, borderColor: '#C7D2FE' },
  pickupBanner: { backgroundColor: '#FEF3C7', borderColor: '#FDE68A' },
  typeIcon: { fontSize: 16 },
  typeBannerText: { color: '#3730A3', fontSize: 11, fontWeight: '900', letterSpacing: 0.5 },
  pickupBannerText: { color: '#92400E' },
  itemsBox: { marginTop: 13, paddingVertical: 10, borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#EEEEF1', gap: 9 },
  itemRow: { flexDirection: 'row', gap: 9 },
  itemQuantity: { width: 24, color: RED, fontSize: 13, fontWeight: '900' },
  itemCopy: { flex: 1 },
  itemName: { color: TEXT, fontSize: 13, fontWeight: '700' },
  rejectedBox: { marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: '#FEF2F2' },
  rejectedTitle: { color: '#B91C1C', fontSize: 11, fontWeight: '800' },
  riderChip: { marginTop: 10, color: '#C2410C', fontSize: 11, fontWeight: '800' },
  paymentRow: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#EEEEF1' },
  paymentLabel: { color: GRAY, fontSize: 11, fontWeight: '700' },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  totalLabel: { color: GRAY, fontSize: 9, textTransform: 'uppercase', fontWeight: '700' },
  total: { color: TEXT, fontSize: 17, fontWeight: '900', marginTop: 1 },
  actions: { flexDirection: 'row', gap: 8 },
  rejectButton: { borderWidth: 1, borderColor: '#F0A5A5', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  rejectButtonText: { color: RED, fontSize: 12, fontWeight: '800' },
  confirmButton: { backgroundColor: '#16A34A', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  confirmButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  statusBadge: { backgroundColor: '#DCFCE7', borderRadius: 9, paddingHorizontal: 11, paddingVertical: 7 },
  statusRejected: { backgroundColor: '#F3F4F6' },
  statusReady: { backgroundColor: '#FFEDD5' },
  statusTransit: { backgroundColor: '#E0E7FF' },
  statusDone: { backgroundColor: '#DCFCE7' },
  statusBadgeText: { color: '#15803D', fontSize: 11, fontWeight: '800' },
  statusRejectedText: { color: GRAY },
  statusReadyText: { color: '#C2410C' },
  statusTransitText: { color: '#4338CA' },
  statusDoneText: { color: '#15803D' },
  pressed: { opacity: 0.72 },
  empty: { alignItems: 'center', paddingVertical: 70 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { color: TEXT, fontSize: 18, fontWeight: '900', marginTop: 10 },
  emptyText: { color: GRAY, fontSize: 12, marginTop: 4 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  modalSheet: { backgroundColor: '#FFFFFF', paddingHorizontal: 18, paddingTop: 10, paddingBottom: 28, borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  modalHandle: { alignSelf: 'center', width: 42, height: 4, borderRadius: 2, backgroundColor: '#D1D1D6', marginBottom: 16 },
  modalTitle: { color: TEXT, fontSize: 20, fontWeight: '900' },
  modalSubtitle: { color: GRAY, fontSize: 12, lineHeight: 17, marginTop: 4 },
  reasonList: { marginTop: 14, gap: 7 },
  reasonOption: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 11, borderRadius: 11, borderWidth: 1, borderColor: '#E4E4E9' },
  reasonOptionActive: { borderColor: RED, backgroundColor: '#FFF5F5' },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#C7C7CC', alignItems: 'center', justifyContent: 'center' },
  radioActive: { borderColor: RED },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: RED },
  reasonText: { color: TEXT, fontSize: 13, fontWeight: '600' },
  reasonTextActive: { color: RED, fontWeight: '800' },
  inputLabel: { color: TEXT, fontSize: 12, fontWeight: '800', marginTop: 15, marginBottom: 6 },
  noteInput: { minHeight: 78, borderWidth: 1, borderColor: '#D8D8DE', borderRadius: 11, padding: 11, color: TEXT, fontSize: 13, textAlignVertical: 'top' },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  cancelButton: { flex: 1, paddingVertical: 13, alignItems: 'center', borderRadius: 11, backgroundColor: '#EEEEF1' },
  cancelButtonText: { color: TEXT, fontSize: 13, fontWeight: '800' },
  modalRejectButton: { flex: 1, paddingVertical: 13, alignItems: 'center', borderRadius: 11, backgroundColor: RED },
  modalRejectText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  assignButton: { backgroundColor: '#FFF7ED', borderWidth: 1, borderColor: '#FDBA74', paddingHorizontal: 10, paddingVertical: 9, borderRadius: 10 },
  assignButtonText: { color: '#C2410C', fontSize: 11, fontWeight: '900' },
  riderOption: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 11, borderRadius: 11, borderWidth: 1, borderColor: '#E4E4E9' },
  riderOptionActive: { borderColor: RED, backgroundColor: '#FFF5F5' },
  riderOptionDisabled: { opacity: 0.55 },
  riderAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#FEF2F2', alignItems: 'center', justifyContent: 'center' },
  riderAvatarText: { fontSize: 16 },
  riderCopy: { flex: 1 },
  riderName: { color: TEXT, fontSize: 13, fontWeight: '800' },
  riderNameDisabled: { color: GRAY },
  riderMeta: { color: GRAY, fontSize: 10, marginTop: 2 },
  riderStatusChip: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 999, backgroundColor: '#F3F4F6' },
  riderStatusAvailable: { backgroundColor: '#DCFCE7' },
  riderStatusText: { color: '#374151', fontSize: 9, fontWeight: '800' },
  assignError: { color: RED, fontSize: 11, fontWeight: '700', marginTop: 8 },
  modalAssignButton: { flex: 1, paddingVertical: 13, alignItems: 'center', borderRadius: 11, backgroundColor: RED },
  modalAssignText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
});
