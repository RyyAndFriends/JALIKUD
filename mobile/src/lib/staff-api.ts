import { apiRequest, uploadRequest } from '@/lib/api';

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'completed'
  | 'cancelled';

export type OrderItemLine = {
  id: number;
  item_name: string;
  quantity: number;
  subtotal: string;
};

export type OrderAddress = {
  id: number;
  label: string | null;
  line1: string;
  line2: string | null;
  city: string;
  latitude: string | null;
  longitude: string | null;
};

export type OrderUser = { id: number; name: string; phone: string | null };

export type StaffOrder = {
  id: number;
  order_number: string;
  order_type: 'delivery' | 'pickup';
  status: OrderStatus;
  subtotal: string;
  discount_amount: string;
  delivery_fee: string;
  tax_amount: string;
  total_amount: string;
  payment_method: 'cod' | 'gcash' | null;
  payment_status: string;
  notes: string | null;
  placed_at: string;
  rider_id: number | null;
  assigned_at: string | null;
  user?: OrderUser | null;
  address?: OrderAddress | null;
  rider?: { id: number; name: string; phone: string | null } | null;
  order_items?: OrderItemLine[];
  delivery_proof_path?: string | null;
};

export type StaffRider = {
  id: number;
  name: string;
  phone: string | null;
  availability_status?: 'available' | 'on_delivery' | 'not_available';
  rider_profile?: {
    vehicle_type: string | null;
    plate_number: string | null;
    is_active: boolean;
    duty_checked_in_at?: string | null;
    delivery_ready_at?: string | null;
  } | null;
};

export type RiderProfile = {
  user_id: number;
  vehicle_type: string | null;
  plate_number: string | null;
  is_active: boolean;
  duty_checked_in_at: string | null;
  delivery_ready_at: string | null;
  availability_status: 'available' | 'on_delivery' | 'not_available';
};

export type StaffMenuItem = {
  id: number;
  name: string;
  base_price: string;
  is_available: boolean;
  is_featured: boolean;
  image_url: string | null;
  category_id: number;
  category?: { id: number; name: string; slug: string } | null;
};

export type StaffCategory = { id: number; name: string; slug: string };

export type StaffActivity = {
  id: number;
  status: OrderStatus;
  note: string | null;
  created_at: string;
  order: { id: number; order_number: string };
  actor: { id: number; name: string } | null;
};

export type PaginationMeta = {
  current_page: number;
  per_page: number;
  total: number;
  last_page: number;
};

type DataResponse<T> = { data: T };
type Paginated<T> = { data: T[]; total: number };
type PaginatedResponse<T> = { data: T[]; meta: PaginationMeta };

function list<T>(response: DataResponse<Paginated<T> | T[]>): T[] {
  return Array.isArray(response.data) ? response.data : response.data.data;
}

export const staffApi = {
  activity: (token: string, page = 1) =>
    apiRequest<PaginatedResponse<StaffActivity>>(`/admin/activity?page=${page}&per_page=20`, { token }),
  orders: (token: string) =>
    apiRequest<DataResponse<Paginated<StaffOrder>>>('/admin/orders?per_page=100', { token }).then(list),
  updateOrderStatus: (token: string, id: number, status: OrderStatus, note?: string) =>
    apiRequest<DataResponse<StaffOrder>>(`/admin/orders/${id}/status`, {
      token,
      method: 'PUT',
      body: { status, ...(note ? { note } : {}) },
    }).then((response) => response.data),
  riders: (token: string) =>
    apiRequest<DataResponse<Paginated<StaffRider>>>('/admin/riders?per_page=100', { token }).then(list),
  dutyCode: (token: string) =>
    apiRequest<DataResponse<{ code: string; date: string }>>('/admin/duty-code', { token }).then((response) => response.data),
  menu: () =>
    apiRequest<DataResponse<Paginated<StaffMenuItem>>>('/menu?per_page=100').then(list),
  categories: () =>
    apiRequest<DataResponse<Paginated<StaffCategory>>>('/categories?per_page=100').then(list),
  updateMenuAvailability: (token: string, id: number, isAvailable: boolean) =>
    apiRequest<DataResponse<StaffMenuItem>>(`/admin/menu-items/${id}`, {
      token,
      method: 'PUT',
      body: { is_available: isAvailable },
    }).then((response) => response.data),
};

export const riderApi = {
  deliveries: (token: string) =>
    apiRequest<DataResponse<Paginated<StaffOrder>>>('/rider/deliveries?per_page=100', { token }).then(list),
  updateStatus: (token: string, id: number, status: 'out_for_delivery', note?: string) =>
    apiRequest<DataResponse<StaffOrder>>(`/rider/deliveries/${id}/status`, {
      token,
      method: 'PUT',
      body: { status, ...(note ? { note } : {}) },
    }).then((response) => response.data),
  completeDelivery: (token: string, id: number, uri: string, note?: string) => {
    const name = uri.split('/').pop() || `delivery-${id}.jpg`;
    const extension = name.split('.').pop()?.toLowerCase();
    const type = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
    const form = new FormData();
    form.append('image', { uri, name, type } as unknown as Blob);
    if (note) form.append('note', note);
    return uploadRequest<DataResponse<StaffOrder>>(`/rider/deliveries/${id}/complete`, token, form).then((response) => response.data);
  },
  profile: (token: string) =>
    apiRequest<DataResponse<RiderProfile>>('/rider/profile', { token }).then((response) => response.data),
  checkIn: (token: string, code: string) =>
    apiRequest<DataResponse<RiderProfile>>('/rider/duty/check-in', { token, method: 'POST', body: { code } }).then((response) => response.data),
  setAvailability: (token: string, isAvailable: boolean) =>
    apiRequest<DataResponse<{ is_active: boolean }>>('/rider/availability', {
      token,
      method: 'PUT',
      body: { is_available: isAvailable },
    }).then((response) => response.data),
  setReadiness: (token: string, ready: boolean) =>
    apiRequest<DataResponse<RiderProfile>>('/rider/readiness', {
      token,
      method: 'PUT',
      body: { ready },
    }).then((response) => response.data),
};
