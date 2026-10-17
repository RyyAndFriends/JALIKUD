import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';

import DeliverySchematicMap from '@/components/delivery-schematic-map';

import { BottomTabInset } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { assetUrl, errorMessage } from '@/lib/api';
import { riderApi, type RiderProfile, type StaffOrder } from '@/lib/staff-api';

const RED = '#DC2626';
const BG = '#F4F4F6';
const TEXT = '#1C1C1E';
const GRAY = '#74747C';
const GREEN = '#16A34A';

const STORE_LOCATION = { latitude: 7.1904, longitude: 125.4539 };
const FALLBACK_DESTINATION = { latitude: 7.0832, longitude: 125.5907 };

type LatLng = { latitude: number; longitude: number };
type DeliveryPhase = 'assigned' | 'picked_up' | 'delivered';

type LiveDelivery = {
  id: number;
  orderNumber: string;
  customer: string;
  phone: string;
  address: string;
  destinationName: string;
  items: { name: string; quantity: number }[];
  amount: number;
  paymentMethod: 'cod' | 'gcash';
  paymentStatus: string;
  store: LatLng;
  destination: LatLng;
  phase: DeliveryPhase;
  assignedAt: string;
  placedAt: string;
  proofUri: string | null;
};

/** Interpolated waypoints (with a gentle curve) for the rider's route. */
function buildRoute(from: LatLng, to: LatLng, steps = 24): LatLng[] {
  return Array.from({ length: steps + 1 }, (_, index) => ({
    latitude: from.latitude + ((to.latitude - from.latitude) * index) / steps,
    longitude:
      from.longitude +
      ((to.longitude - from.longitude) * index) / steps +
      0.004 * Math.sin((Math.PI * index) / steps),
  }));
}

function peso(value: number): string {
  return `₱${value.toLocaleString('en-PH', { maximumFractionDigits: 0 })}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function phaseOf(order: StaffOrder): DeliveryPhase | null {
  if (order.status === 'ready') return 'assigned';
  if (order.status === 'out_for_delivery') return 'picked_up';
  if (order.status === 'completed') return 'delivered';
  return null;
}

function toDelivery(order: StaffOrder): LiveDelivery | null {
  const phase = phaseOf(order);
  if (!phase) return null;
  const address = order.address;
  const addressText = address
    ? [address.line1, address.line2, address.city].filter(Boolean).join(', ')
    : 'Customer address on file';
  const lat = Number(address?.latitude);
  const lng = Number(address?.longitude);
  return {
    id: order.id,
    orderNumber: order.order_number,
    customer: order.user?.name ?? 'Customer',
    phone: order.user?.phone ?? '—',
    address: addressText,
    destinationName: address?.label || "Customer's House",
    items: (order.order_items ?? []).map((line) => ({ name: line.item_name, quantity: line.quantity })),
    amount: Number(order.total_amount),
    paymentMethod: order.payment_method === 'gcash' ? 'gcash' : 'cod',
    paymentStatus: order.payment_status,
    store: STORE_LOCATION,
    destination: {
      latitude: Number.isFinite(lat) ? lat : FALLBACK_DESTINATION.latitude,
      longitude: Number.isFinite(lng) ? lng : FALLBACK_DESTINATION.longitude,
    },
    phase,
    assignedAt: order.assigned_at ? formatDate(order.assigned_at) : formatDate(order.placed_at),
    placedAt: order.placed_at,
    proofUri: assetUrl(order.delivery_proof_path ? `/storage/${order.delivery_proof_path}` : null),
  };
}

function Stepper({ phase }: { phase: DeliveryPhase }) {
  const steps = [
    { key: 'assigned', label: 'Assigned' },
    { key: 'picked_up', label: 'Picked up' },
    { key: 'delivered', label: 'Delivered' },
  ];
  const activeIndex = phase === 'assigned' ? 0 : phase === 'picked_up' ? 1 : 2;
  return (
    <View style={styles.stepper}>
      {steps.map((step, index) => (
        <View key={step.key} style={styles.stepperStep}>
          <View style={styles.stepperDotRow}>
            <View style={[styles.stepperDot, index <= activeIndex && styles.stepperDotDone]} />
            {index < steps.length - 1 && (
              <View style={[styles.stepperLine, index < activeIndex && styles.stepperLineDone]} />
            )}
          </View>
          <Text style={[styles.stepperLabel, index <= activeIndex && styles.stepperLabelDone]}>
            {step.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function paymentLabel(delivery: LiveDelivery): string {
  if (delivery.paymentMethod === 'gcash') return `GCash ${delivery.paymentStatus === 'paid' ? 'Paid' : 'Unpaid'}`;
  return `COD ${peso(delivery.amount)}`;
}

/** Full-screen map modal: JALIKUD store → customer's house, with simulated rider movement. */
function DeliveryMapModal({
  delivery,
  busy,
  onPickUp,
  onComplete,
  onClose,
}: {
  delivery: LiveDelivery;
  busy: boolean;
  onPickUp: () => void;
  onComplete: (proofUri: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [route] = useState<LatLng[]>(() => buildRoute(delivery.store, delivery.destination));
  const [progress, setProgress] = useState(delivery.phase === 'picked_up' ? 0.35 : 0.1);
  const [moving, setMoving] = useState(false);
  const [proofOpen, setProofOpen] = useState(false);
  const [proofUri, setProofUri] = useState<string | null>(null);
  const [proofError, setProofError] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  useEffect(() => {
    if (!moving) return;
    const interval = setInterval(() => {
      setProgress((current) => (current >= 0.92 ? 0.92 : current + 0.04));
    }, 900);
    return () => clearInterval(interval);
  }, [moving]);

  const position = route[Math.floor(progress * (route.length - 1))];

  const openProofSheet = () => {
    setProofOpen(true);
    setProofUri(null);
    setProofError('');
    // Ask for camera permission so the in-app viewfinder can render.
    if (!permission?.granted) {
      void requestPermission().then((result) => {
        if (!result.granted) {
          setProofError(result.canAskAgain
            ? 'Camera permission is required to take delivery proof.'
            : 'Enable camera permission in your device settings to continue.');
        }
      });
    }
  };

  const takeProofPhoto = async () => {
    if (capturing || busy) return;
    setCapturing(true);
    setProofError('');
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.7 });
      if (photo) setProofUri(photo.uri);
    } catch (caught) {
      setProofError(errorMessage(caught, 'Could not capture the photo.'));
    } finally {
      setCapturing(false);
    }
  };

  const retakeProof = () => {
    if (capturing || busy) return;
    setProofUri(null);
    setProofError('');
  };

  const closeProof = () => {
    if (capturing || busy) return;
    setProofOpen(false);
    setProofUri(null);
    setProofError('');
  };

  const submitProof = async () => {
    if (!proofUri || busy) return;
    if (await onComplete(proofUri)) closeProof();
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.mapModal}>
        <DeliverySchematicMap
          route={route}
          rider={delivery.phase === 'picked_up' ? position : null}
          showRider={delivery.phase === 'picked_up'}
          progress={progress}
          customerName={delivery.customer}
        />

        <SafeAreaView edges={['top']} style={styles.mapHeaderSafe}>
          <View style={styles.mapHeader}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close map"
              onPress={onClose}
              style={({ pressed }) => [styles.mapBackButton, pressed && styles.pressed]}>
              <Text style={styles.mapBackText}>←</Text>
            </Pressable>
            <View style={styles.mapHeaderCopy}>
              <Text style={styles.mapHeaderTitle}>{delivery.destinationName}</Text>
              <Text style={styles.mapHeaderSubtitle}>
                {delivery.orderNumber} · {paymentLabel(delivery)}
              </Text>
            </View>
          </View>
        </SafeAreaView>

        <View style={styles.mapBottomCard}>
          <View style={styles.mapBottomRow}>
            <View style={styles.mapBottomCopy}>
              <Text style={styles.mapBottomLabel}>Deliver to</Text>
              <Text style={styles.mapBottomName}>{delivery.customer} · {delivery.phone}</Text>
              <Text style={styles.mapBottomAddress}>{delivery.address}</Text>
            </View>
            {delivery.phase === 'picked_up' && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Simulate rider movement"
                onPress={() => setMoving((value) => !value)}
                style={({ pressed }) => [styles.simulateButton, moving && styles.simulateButtonActive, pressed && styles.pressed]}>
                <Text style={styles.simulateText}>{moving ? '⏸ Stop' : '▶ Start'}</Text>
              </Pressable>
            )}
          </View>
          {delivery.phase === 'picked_up' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={delivery.paymentMethod === 'cod' ? 'Complete delivery and confirm cash received' : 'Complete delivery'}
              disabled={busy}
              onPress={() => void openProofSheet()}
              style={({ pressed }) => [styles.completeButton, pressed && styles.pressed]}>
              {busy ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.completeButtonText}>
                  {delivery.paymentMethod === 'cod' ? 'Complete & confirm cash received' : '✓ Complete delivery'}
                </Text>
              )}
            </Pressable>
          ) : delivery.phase === 'assigned' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Mark order picked up"
              disabled={busy}
              onPress={onPickUp}
              style={({ pressed }) => [styles.completeButton, pressed && styles.pressed]}>
              {busy ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.completeButtonText}>Pick up order</Text>
              )}
            </Pressable>
          ) : (
            <Text style={styles.mapHint}>Pick up the order from the store first, then start delivery.</Text>
          )}
        </View>

        {proofOpen && (
          <View style={styles.proofBackdrop}>
            <Pressable accessibilityLabel="Close delivery proof" style={StyleSheet.absoluteFill} onPress={closeProof} />
            <View style={styles.proofSheet}>
              <View style={styles.proofHandle} />
              <Text style={styles.proofTitle}>Delivery picture proof</Text>
              <Text style={styles.proofHint}>Point the camera at the delivered order and capture a photo. Gallery photos are not allowed.</Text>

              {proofUri ? (
                <Image accessibilityLabel="Delivery proof preview" source={{ uri: proofUri }} contentFit="cover" style={styles.proofImage} />
              ) : (
                <View style={styles.proofCameraFrame}>
                  <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
                </View>
              )}

              {!!proofError && <Text style={styles.proofError}>⚠ {proofError}</Text>}

              <Pressable
                accessibilityRole="button"
                accessibilityLabel={proofUri ? 'Retake delivery proof photo' : 'Capture delivery proof photo'}
                disabled={capturing || busy}
                onPress={() => void (proofUri ? retakeProof() : takeProofPhoto())}
                style={({ pressed }) => [styles.cameraButton, (capturing || busy) && styles.buttonDisabled, pressed && styles.pressed]}>
                {capturing ? <ActivityIndicator color={RED} /> : <Text style={styles.cameraButtonText}>{proofUri ? '📷 Retake Photo' : '📷 Capture Photo'}</Text>}
              </Pressable>

              <View style={styles.proofActions}>
                <Pressable disabled={capturing || busy} onPress={closeProof} style={styles.proofCancelButton}>
                  <Text style={styles.proofCancelText}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Submit delivery proof and complete order"
                  disabled={!proofUri || busy || capturing}
                  onPress={() => void submitProof()}
                  style={[styles.proofSubmitButton, (!proofUri || busy || capturing) && styles.buttonDisabled]}>
                  {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.proofSubmitText}>Submit &amp; Complete</Text>}
                </Pressable>
              </View>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

export default function RiderDeliveriesScreen() {
  const { token, user } = useAuth();
  const router = useRouter();
  const [deliveries, setDeliveries] = useState<LiveDelivery[]>([]);
  const [profile, setProfile] = useState<RiderProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [togglingDuty, setTogglingDuty] = useState(false);
  const [error, setError] = useState('');
  const [showMap, setShowMap] = useState(false);
  const [moving, setMoving] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setError('');
    try {
      const [queue, liveProfile] = await Promise.all([riderApi.deliveries(token), riderApi.profile(token)]);
      setDeliveries(queue.map(toDelivery).filter((d): d is LiveDelivery => d !== null));
      setProfile(liveProfile);
    } catch (caught) {
      setError(errorMessage(caught, 'Could not load your deliveries.'));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(useCallback(() => { void load().catch(() => undefined); }, [load]));

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().catch(() => undefined).finally(() => setRefreshing(false));
  }, [load]);

  const active = [...deliveries].reverse().find((delivery) => delivery.phase !== 'delivered') ?? null;
  const history = deliveries.filter((delivery) => delivery.phase === 'delivered');

  const advance = async (delivery: LiveDelivery, next: 'out_for_delivery' | 'completed', proofUri?: string): Promise<boolean> => {
    if (!token || busyId !== null) return false;
    setBusyId(delivery.id);
    setError('');
    try {
      const updated = next === 'completed'
        ? await riderApi.completeDelivery(token, delivery.id, proofUri as string)
        : await riderApi.updateStatus(token, delivery.id, next);
      const mapped = toDelivery(updated);
      setDeliveries((previous) =>
        previous.map((row) => (row.id === delivery.id && mapped ? mapped : row)),
      );
      if (next === 'completed') {
        setShowMap(false);
        // Refresh readiness so the queue state stays accurate after completing.
        riderApi.profile(token).then(setProfile).catch(() => undefined);
      }
      return true;
    } catch (caught) {
      setError(errorMessage(caught, 'Could not update the delivery.'));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const toggleReadiness = (ready: boolean) => {
    if (!token || togglingDuty || onDelivery) return;
    setTogglingDuty(true);
    setError('');
    riderApi
      .setReadiness(token, ready)
      .then((updated) => setProfile(updated))
      .catch((caught) => setError(errorMessage(caught, 'Could not update your status.')))
      .finally(() => setTogglingDuty(false));
  };

  const startMoving = () => setMoving(true);
  const onDelivery = active !== null;
  const isActive = profile?.is_active === true;
  const isReady = profile?.delivery_ready_at != null;
  const available = !onDelivery && isReady;

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <SafeAreaView edges={['top']} style={styles.headerSafe}>
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <View style={styles.headerCopy}>
              <Text style={styles.eyebrow}>DELIVERY RIDER</Text>
              <Text style={styles.title}>My Deliveries</Text>
              <Text style={styles.subtitle}>{user?.name ?? 'Rider'}</Text>
            </View>
            <View style={styles.headerBadge}>
              <Text style={styles.headerBadgeText}>{history.length}</Text>
              <Text style={styles.headerBadgeLabel}>done</Text>
            </View>
          </View>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={RED} />}>
        <View style={styles.availabilityCard}>
          <View style={styles.availabilityHeader}>
            <View>
              <Text style={styles.availabilityEyebrow}>DELIVERY STATUS</Text>
              <Text style={styles.availabilityTitle}>Delivery availability</Text>
            </View>
            <View
              style={[
                styles.currentStatus,
                available && styles.currentStatusOnDuty,
                onDelivery && styles.currentStatusOnDelivery,
              ]}>
              <Text style={styles.currentStatusText}>
                {onDelivery ? 'On Delivery' : isReady ? 'Ready to Deliver' : isActive ? 'On Duty' : 'Not Clocked In'}
              </Text>
            </View>
          </View>
          <Text style={styles.availabilityHint}>
            {onDelivery
              ? 'Finish your active delivery before changing availability.'
              : isReady
                ? 'You are in the delivery queue. The next order will be assigned automatically.'
                : isActive
                  ? 'You are clocked in. Go ready to join the delivery queue.'
                  : 'Scan the duty QR from Settings to clock in.'}
          </Text>
          <View style={styles.availabilityActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                onDelivery ? 'Finish active delivery' : isReady ? 'Pause deliveries' : isActive ? 'Ready to deliver' : 'Clock in'
              }
              disabled={onDelivery || togglingDuty}
              onPress={() => {
                if (onDelivery) return;
                if (!isActive) {
                  router.push('/rider/settings');
                  return;
                }
                toggleReadiness(!isReady);
              }}
              style={({ pressed }) => [
                styles.availabilityButton,
                isActive && styles.onDutyButton,
                !isActive && styles.unavailableButton,
                !!onDelivery && styles.availabilityButtonDisabled,
                pressed && styles.pressed,
              ]}>
              {togglingDuty ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={[styles.availabilityButtonText, isActive && styles.availabilityButtonTextActive, !isActive && styles.availabilityButtonTextActive]}>
                  {onDelivery ? 'On Delivery' : isReady ? 'Pause deliveries' : isActive ? 'Ready to deliver' : 'Clock in'}
                </Text>
              )}
            </Pressable>
          </View>
        </View>

        {loading && deliveries.length === 0 ? (
          <View style={styles.card}>
            <ActivityIndicator color={RED} size="large" />
            <Text style={styles.emptyText}>Loading your deliveries…</Text>
          </View>
        ) : null}
        {!!error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>⚠ {error}</Text>
            <Pressable onPress={onRefresh} style={styles.retryButton}><Text style={styles.retryText}>Try again</Text></Pressable>
          </View>
        )}

        {active ? (
          <View style={styles.card}>
            <View style={styles.orderHeader}>
              <View>
                <Text style={styles.orderNumber}>{active.orderNumber}</Text>
                <Text style={styles.orderMeta}>Assigned {active.assignedAt}</Text>
              </View>
              <View style={[styles.paymentBadge, active.paymentMethod === 'gcash' && styles.gcashBadge]}>
                <Text style={[styles.paymentText, active.paymentMethod === 'gcash' && styles.gcashText]}>{paymentLabel(active)}</Text>
              </View>
            </View>

            <Stepper phase={active.phase} />

            <View style={styles.addressBox}>
              <Text style={styles.addressLabel}>Deliver to</Text>
              <Text style={styles.addressName}>{active.customer} · {active.phone}</Text>
              <Text style={styles.addressText}>{active.address}</Text>
            </View>

            <View style={styles.itemsBox}>
              {active.items.map((item) => (
                <View key={item.name} style={styles.itemRow}>
                  <Text style={styles.itemQuantity}>{item.quantity}×</Text>
                  <Text style={styles.itemName}>{item.name}</Text>
                </View>
              ))}
            </View>

            <View style={styles.actionsRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open delivery map"
                onPress={() => setShowMap(true)}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
                <Text style={styles.secondaryButtonText}>🗺️ View map</Text>
              </Pressable>
              {active.phase === 'assigned' ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Mark order picked up"
                  disabled={busyId === active.id}
                  onPress={() => {
                    void advance(active, 'out_for_delivery').then(() => startMoving());
                  }}
                  style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}>
                  {busyId === active.id ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.primaryButtonText}>Pick up order</Text>
                  )}
                </Pressable>
              ) : (
                <Text style={styles.movingHint}>{moving ? '🛵 On the way…' : 'Deliver via the map'}</Text>
              )}
            </View>
          </View>
        ) : (
          !loading && (
            <View style={styles.card}>
              <Text style={styles.emptyIcon}>☕</Text>
              <Text style={styles.emptyTitle}>All clear</Text>
              <Text style={styles.emptyText}>No deliveries assigned. Enjoy the break!</Text>
            </View>
          )
        )}

        {history.length > 0 && (
          <View style={styles.historySection}>
            <Text style={styles.historyTitle}>Completed ({history.length})</Text>
            {history.map((delivery) => (
              <View key={delivery.id} style={styles.historyRow}>
                <Text style={styles.historyIcon}>✓</Text>
                <View style={styles.historyCopy}>
                  <Text style={styles.historyOrder}>{delivery.orderNumber} · {delivery.customer}</Text>
                  <Text style={styles.historyMeta}>
                    {delivery.paymentMethod === 'cod' ? `COD collected ${peso(delivery.amount)}` : 'GCash Paid'}
                    {delivery.proofUri ? ' · Photo proof ✓' : ''}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {showMap && active && (
        <DeliveryMapModal
          delivery={active}
          busy={busyId === active.id}
          onPickUp={() => void advance(active, 'out_for_delivery')}
          onComplete={(proofUri) => advance(active, 'completed', proofUri)}
          onClose={() => setShowMap(false)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  headerSafe: { backgroundColor: RED },
  header: { paddingHorizontal: 16, paddingBottom: 16 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  headerCopy: { flex: 1, paddingRight: 10 },
  eyebrow: { color: 'rgba(255,255,255,0.72)', fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  title: { color: '#FFFFFF', fontSize: 25, fontWeight: '900', marginTop: 3 },
  subtitle: { color: 'rgba(255,255,255,0.78)', fontSize: 11, marginTop: 4 },
  headerBadge: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 12, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.17)' },
  headerBadgeText: { color: '#FFFFFF', fontSize: 18, fontWeight: '900' },
  headerBadgeLabel: { color: 'rgba(255,255,255,0.78)', fontSize: 9, fontWeight: '700' },
  content: { padding: 14, paddingBottom: BottomTabInset + 24 },
  availabilityCard: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 14, marginBottom: 12 },
  availabilityHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  availabilityEyebrow: { color: GRAY, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  availabilityTitle: { color: TEXT, fontSize: 15, fontWeight: '900', marginTop: 3 },
  currentStatus: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999, backgroundColor: '#F3F4F6' },
  currentStatusOnDuty: { backgroundColor: '#DCFCE7' },
  currentStatusOnDelivery: { backgroundColor: '#FEF3C7' },
  currentStatusText: { color: TEXT, fontSize: 9, fontWeight: '800' },
  availabilityHint: { color: GRAY, fontSize: 11, lineHeight: 16, marginTop: 8 },
  availabilityActions: { flexDirection: 'row', gap: 9, marginTop: 12 },
  availabilityButton: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 11, borderWidth: 1, borderColor: '#D8D8DE', backgroundColor: '#F8F8FA' },
  onDutyButton: { borderColor: GREEN, backgroundColor: GREEN },
  unavailableButton: { borderColor: '#6B7280', backgroundColor: '#6B7280' },
  availabilityButtonDisabled: { opacity: 0.45 },
  availabilityButtonText: { color: TEXT, fontSize: 12, fontWeight: '800' },
  availabilityButtonTextActive: { color: '#FFFFFF' },
  card: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 15 },
  orderHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  orderNumber: { color: TEXT, fontSize: 17, fontWeight: '900' },
  orderMeta: { color: GRAY, fontSize: 10, marginTop: 3 },
  paymentBadge: { backgroundColor: '#FEF3C7', borderRadius: 9, paddingHorizontal: 10, paddingVertical: 6 },
  gcashBadge: { backgroundColor: '#DBEAFE' },
  paymentText: { color: '#B45309', fontSize: 11, fontWeight: '900' },
  gcashText: { color: '#1D4ED8' },
  stepper: { flexDirection: 'row', marginTop: 15, marginBottom: 4 },
  stepperStep: { flex: 1 },
  stepperDotRow: { flexDirection: 'row', alignItems: 'center' },
  stepperDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: '#E4E4E9', borderWidth: 2, borderColor: '#E4E4E9' },
  stepperDotDone: { backgroundColor: GREEN, borderColor: GREEN },
  stepperLine: { flex: 1, height: 2, backgroundColor: '#E4E4E9', marginHorizontal: 3 },
  stepperLineDone: { backgroundColor: GREEN },
  stepperLabel: { color: GRAY, fontSize: 9, fontWeight: '700', marginTop: 6 },
  stepperLabelDone: { color: GREEN },
  addressBox: { marginTop: 14, padding: 11, borderRadius: 11, backgroundColor: '#F8F8FA' },
  addressLabel: { color: GRAY, fontSize: 9, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  addressName: { color: TEXT, fontSize: 13, fontWeight: '800', marginTop: 4 },
  addressText: { color: GRAY, fontSize: 11, lineHeight: 16, marginTop: 2 },
  itemsBox: { marginTop: 11, paddingVertical: 10, borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#EEEEF1', gap: 8 },
  itemRow: { flexDirection: 'row', gap: 9 },
  itemQuantity: { width: 24, color: RED, fontSize: 13, fontWeight: '900' },
  itemName: { color: TEXT, fontSize: 13, fontWeight: '700', flex: 1 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 13 },
  secondaryButton: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 11, borderWidth: 1, borderColor: '#F0A5A5' },
  secondaryButtonText: { color: RED, fontSize: 12, fontWeight: '800' },
  primaryButton: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 11, backgroundColor: RED },
  primaryButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  movingHint: { flex: 1, color: GRAY, fontSize: 11, fontWeight: '600', textAlign: 'center' },
  emptyIcon: { fontSize: 42, textAlign: 'center' },
  emptyTitle: { color: TEXT, fontSize: 16, fontWeight: '900', textAlign: 'center', marginTop: 8 },
  emptyText: { color: GRAY, fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 5 },
  errorBox: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA', marginBottom: 12 },
  errorText: { color: '#B91C1C', fontSize: 12, fontWeight: '700' },
  retryButton: { alignSelf: 'flex-start', backgroundColor: RED, borderRadius: 9, paddingHorizontal: 14, paddingVertical: 8 },
  retryText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  historySection: { marginTop: 18 },
  historyTitle: { color: TEXT, fontSize: 13, fontWeight: '900', marginBottom: 8, paddingHorizontal: 2 },
  historyRow: { flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 13, padding: 12, marginBottom: 8 },
  historyIcon: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#DCFCE7', color: '#15803D', fontSize: 13, fontWeight: '900', textAlign: 'center', lineHeight: 26 },
  historyCopy: { flex: 1 },
  historyOrder: { color: TEXT, fontSize: 12, fontWeight: '800' },
  historyMeta: { color: GRAY, fontSize: 10, marginTop: 2 },
  mapModal: { flex: 1, backgroundColor: '#E5E7EB', overflow: 'hidden' },
  mapHeaderSafe: { position: 'absolute', top: 0, left: 0, right: 0 },
  mapHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 14, marginTop: 8, padding: 11, borderRadius: 14, backgroundColor: '#FFFFFF', elevation: 4, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  mapBackButton: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#F0F0F3', alignItems: 'center', justifyContent: 'center' },
  mapBackText: { color: TEXT, fontSize: 17, fontWeight: '900' },
  mapHeaderCopy: { flex: 1 },
  mapHeaderTitle: { color: TEXT, fontSize: 13, fontWeight: '900' },
  mapHeaderSubtitle: { color: GRAY, fontSize: 10, marginTop: 2 },
  mapBottomCard: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#FFFFFF', borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 26, elevation: 8, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: -3 } },
  mapBottomRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  mapBottomCopy: { flex: 1 },
  mapBottomLabel: { color: GRAY, fontSize: 9, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  mapBottomName: { color: TEXT, fontSize: 14, fontWeight: '900', marginTop: 4 },
  mapBottomAddress: { color: GRAY, fontSize: 11, lineHeight: 15, marginTop: 2 },
  simulateButton: { paddingVertical: 9, paddingHorizontal: 13, borderRadius: 10, backgroundColor: '#EFF6FF' },
  simulateButtonActive: { backgroundColor: '#DCFCE7' },
  simulateText: { color: '#1D4ED8', fontSize: 11, fontWeight: '900' },
  completeButton: { marginTop: 13, alignItems: 'center', paddingVertical: 14, borderRadius: 12, backgroundColor: GREEN },
  completeButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  mapHint: { marginTop: 13, color: GRAY, fontSize: 11, textAlign: 'center' },
  proofBackdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 10, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  proofSheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 28 },
  proofHandle: { alignSelf: 'center', width: 42, height: 4, borderRadius: 2, backgroundColor: '#D1D1D6', marginBottom: 16 },
  proofTitle: { color: TEXT, fontSize: 20, fontWeight: '900' },
  proofHint: { color: GRAY, fontSize: 12, lineHeight: 17, marginTop: 4, marginBottom: 14 },
  proofImage: { width: '100%', height: 210, borderRadius: 14, backgroundColor: '#F3F4F6' },
  proofCameraFrame: { width: '100%', height: 210, borderRadius: 14, overflow: 'hidden', backgroundColor: '#000000' },
  proofPlaceholder: { height: 180, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: '#D1D5DB', backgroundColor: '#F9FAFB', alignItems: 'center', justifyContent: 'center' },
  proofPlaceholderIcon: { fontSize: 40 },
  proofPlaceholderText: { color: GRAY, fontSize: 12, fontWeight: '700', marginTop: 7 },
  proofError: { color: '#B91C1C', fontSize: 11, fontWeight: '700', marginTop: 10 },
  cameraButton: { alignItems: 'center', borderWidth: 1, borderColor: '#F0A5A5', borderRadius: 11, paddingVertical: 12, marginTop: 12 },
  cameraButtonText: { color: RED, fontSize: 12, fontWeight: '900' },
  proofActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  proofCancelButton: { flex: 1, alignItems: 'center', borderRadius: 11, backgroundColor: '#EEEEF1', paddingVertical: 13 },
  proofCancelText: { color: TEXT, fontSize: 12, fontWeight: '800' },
  proofSubmitButton: { flex: 2, alignItems: 'center', borderRadius: 11, backgroundColor: GREEN, paddingVertical: 13 },
  proofSubmitText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  buttonDisabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
});
