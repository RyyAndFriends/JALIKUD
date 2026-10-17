<?php

namespace App\Http\Controllers;

use App\Http\Requests\General\PaginationRequest;
use App\Models\Cart;
use App\Models\Coupon;
use App\Models\CouponRedemption;
use App\Models\Order;
use App\Models\OrderStatusHistory;
use App\Models\StoreSetting;
use App\Services\CartPricingService;
use App\Services\DeliveryAssignmentService;
use App\Services\PointLedger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

/**
 * Browse and manage orders for the authenticated user.
 */
class OrderController extends Controller
{
    /**
     * Allowed status transitions (server-side; keeps the in: rule honest).
     */
    private const STATUS_TRANSITIONS = [
        Order::STATUS_PENDING => [Order::STATUS_CONFIRMED, Order::STATUS_CANCELLED],
        Order::STATUS_CONFIRMED => [Order::STATUS_PREPARING, Order::STATUS_CANCELLED],
        Order::STATUS_PREPARING => [Order::STATUS_READY, Order::STATUS_CANCELLED],
        Order::STATUS_READY => [Order::STATUS_OUT_FOR_DELIVERY, Order::STATUS_COMPLETED, Order::STATUS_CANCELLED],
        Order::STATUS_OUT_FOR_DELIVERY => [Order::STATUS_COMPLETED, Order::STATUS_CANCELLED],
        Order::STATUS_COMPLETED => [],
        Order::STATUS_CANCELLED => [],
    ];

    /**
     * GET /api/admin/activity - status changes made by the signed-in staff member.
     */
    public function activity(PaginationRequest $request): JsonResponse
    {
        $history = OrderStatusHistory::query()
            ->with([
                'order:id,order_number',
                'changedBy:id,name',
            ])
            ->where('changed_by', $request->user()->id)
            ->orderByDesc('created_at')
            ->orderByDesc('id')
            ->paginate($request->perPage(20));

        return $this->paginated($history, fn (OrderStatusHistory $entry) => [
            'id' => $entry->id,
            'status' => $entry->status,
            'note' => $entry->note,
            'created_at' => $entry->created_at,
            'order' => $entry->order,
            'actor' => $entry->changedBy,
        ]);
    }

    public function index(PaginationRequest $request): JsonResponse
    {
        $user = $request->user();
        $with = [
            'address:id,label,line1,line2,city,state,postal_code,country,is_default',
            'orderItems:id,order_id,item_name,quantity,subtotal',
        ];

        // The customer surface must not leak user objects (see
        // CustomerMobileIntegrationTest); staff need names for the queue and
        // the auto-assigned rider for the delivery chip.
        if ($user->isStaff()) {
            $with[] = 'user:id,name,phone';
            $with[] = 'rider:id,name,phone';
        }

        $filters = $request->validate([
            'order_type' => ['sometimes', 'nullable', 'string', Rule::in(['delivery', 'pickup'])],
            'status' => ['sometimes', 'nullable', 'string', Rule::in([
                Order::STATUS_PENDING,
                Order::STATUS_CONFIRMED,
                Order::STATUS_PREPARING,
                Order::STATUS_READY,
                Order::STATUS_OUT_FOR_DELIVERY,
                Order::STATUS_COMPLETED,
                Order::STATUS_CANCELLED,
            ])],
        ]);

        $query = Order::query()
            ->with($with)
            ->when($request->query('search'), function ($q, $search) {
                $q->where(function ($sub) use ($search) {
                    $sub->where('order_number', 'like', "%{$search}%")
                        ->orWhereHas('user', fn ($u) => $u->where('name', 'like', "%{$search}%")
                            ->orWhere('email', 'like', "%{$search}%"));
                });
            })
            ->when($filters['order_type'] ?? null, fn ($q, $type) => $q->where('order_type', $type))
            ->when($filters['status'] ?? null, fn ($q, $status) => $q->where('status', $status))
            ->orderByDesc('placed_at');

        // Admins and staff see all orders; customers see their own.
        if (! $user->isStaff()) {
            $query->where('user_id', $user->id);
        }

        $orders = $query->paginate($request->perPage(10));

        return $this->paginated($orders);
    }

    public function show(Request $request, Order $order): JsonResponse
    {
        if ($order->user_id !== $request->user()->id && ! $request->user()->isStaff()) {
            return response()->json(['message' => 'Forbidden.'], 403);
        }

        $order->load(['user', 'address', 'rider', 'coupon', 'orderItems.options', 'statusHistory', 'payments', 'reviews']);

        return response()->json(['data' => $order]);
    }

    /**
     * POST /api/orders - place an order from the current cart.
     */
    public function store(Request $request, CartPricingService $pricing): JsonResponse
    {
        $data = $request->validate([
            'order_type' => ['required', 'in:delivery,pickup'],
            'address_id' => [
                'required_if:order_type,delivery',
                'nullable',
                Rule::exists('addresses', 'id')->where('user_id', $request->user()->id),
            ],
            'coupon_code' => ['nullable', 'string', 'max:50'],
            'notes' => ['nullable', 'string', 'max:2000'],
            'scheduled_for' => ['nullable', 'date'],
            'payment_method' => ['nullable', 'in:cod,gcash'],
        ]);

        $user = $request->user();
        $paymentMethod = $data['payment_method'] ?? ($data['order_type'] === 'pickup' ? 'gcash' : 'cod');

        if ($data['order_type'] === 'pickup' && $paymentMethod === 'cod') {
            return response()->json([
                'message' => 'Pickup orders must be paid with GCash.',
                'errors' => ['payment_method' => ['Pickup orders must be paid with GCash.']],
            ], 422);
        }

        // The store must be able to accept the order right now.
        if (! StoreSetting::isOpenNow()) {
            return response()->json(['message' => 'The store is currently closed.'], 422);
        }

        return DB::transaction(function () use ($data, $user, $pricing, $paymentMethod) {
            $cart = Cart::where('user_id', $user->id)
                ->lockForUpdate()
                ->first();

            $cart?->load(['cartItems.menuItem', 'cartItems.options.variantOption', 'coupon']);

            if (! $cart || $cart->cartItems->isEmpty()) {
                return response()->json(['message' => 'Your cart is empty.'], 422);
            }

            // Re-price lines against the live catalog; stale/unavailable carts fail closed.
            $priced = $pricing->price($cart);

            if (! empty($priced['errors'])) {
                return response()->json(['message' => implode(' ', $priced['errors']), 'errors' => ['items' => $priced['errors']]], 422);
            }

            $subtotal = $priced['subtotal'];

            $coupon = null;
            $discountAmount = 0.0;
            $code = $data['coupon_code'] ?? $cart->coupon?->code;

            if (! empty($code)) {
                // Row lock serialises concurrent redemptions of the same coupon.
                $coupon = Coupon::query()->lockForUpdate()->where('code', $code)->first();

                $reason = $coupon
                    ? $coupon->rejectionReason($subtotal, $user->id)
                    : 'Coupon code not found or inactive.';

                if ($reason !== null) {
                    return response()->json(['message' => $reason, 'errors' => ['coupon_code' => [$reason]]], 422);
                }

                $discountAmount = $coupon->discountFor($subtotal);
            }

            // Reserved reward: revalidated here because the cart, catalog, or
            // points balance may have changed since selection. Points move
            // only after every other validation has passed.
            $rewardKey = $cart->reward_key;
            $rewardDiscount = 0.0;
            $rewardCost = 0;

            if ($rewardKey !== null && $rewardKey !== '') {
                $definition = PointLedger::definition($rewardKey);

                if ($definition === null) {
                    return response()->json(['message' => 'Selected reward is no longer available.'], 422);
                }

                if ($coupon !== null) {
                    return response()->json(['message' => 'Rewards cannot be combined with a coupon.'], 422);
                }

                $rewardCost = (int) ($definition['points_cost'] ?? 0);

                if (($definition['type'] ?? null) === 'free_item') {
                    $menuItemId = (int) ($definition['menu_item_id'] ?? 0);
                    $match = $priced['lines']->first(fn ($line) => $line['menu_item']->id === $menuItemId);

                    if ($match === null) {
                        return response()->json([
                            'message' => "Add {$definition['label']} to your cart to use this reward.",
                            'errors' => ['reward' => ["Add {$definition['label']} to your cart to use this reward."]],
                        ], 422);
                    }

                    $rewardDiscount = round((float) $match['unit_price'], 2);
                } elseif (($definition['type'] ?? null) === 'voucher') {
                    $minimum = (float) ($definition['min_order_amount'] ?? 0);

                    if ($subtotal < $minimum) {
                        return response()->json([
                            'message' => 'This reward needs a subtotal of at least ₱'.number_format($minimum, 2).'.',
                            'errors' => ['reward' => ['Reward minimum not met.']],
                        ], 422);
                    }

                    $rewardDiscount = round((float) ($definition['discount_amount'] ?? 0), 2);
                } else {
                    return response()->json(['message' => 'Selected reward is no longer available.'], 422);
                }

                $rewardDiscount = max(0.0, min($rewardDiscount, $subtotal - $discountAmount));
            }

            $settings = StoreSetting::query()->first();

            if ($settings && $subtotal < (float) $settings->min_order_amount) {
                return response()->json(['message' => 'Order subtotal is below the store minimum.'], 422);
            }

            $accepts = $data['order_type'] === 'delivery'
                ? ($settings?->accepts_delivery ?? true)
                : ($settings?->accepts_pickup ?? true);

            if (! $accepts) {
                return response()->json(['message' => 'The store does not accept '.$data['order_type'].' orders.'], 422);
            }

            $deliveryFee = $data['order_type'] === 'delivery' ? round((float) ($settings?->delivery_fee ?? 0), 2) : 0.0;
            $taxAmount = round($subtotal * ((float) ($settings?->tax_rate_percent ?? 0) / 100), 2);
            $totalAmount = round($subtotal - $discountAmount - $rewardDiscount + $deliveryFee + $taxAmount, 2);

            $order = Order::create([
                'order_number' => $this->generateOrderNumber(),
                'user_id' => $user->id,
                'address_id' => $data['address_id'] ?? null,
                'order_type' => $data['order_type'],
                'status' => Order::STATUS_PENDING,
                'payment_status' => $paymentMethod === 'gcash' ? Order::PAYMENT_PAID : Order::PAYMENT_UNPAID,
                'payment_method' => $paymentMethod,
                'subtotal' => $subtotal,
                'discount_amount' => $discountAmount,
                'reward_key' => $rewardKey,
                'reward_discount_amount' => $rewardDiscount,
                'delivery_fee' => $deliveryFee,
                'tax_amount' => $taxAmount,
                'total_amount' => $totalAmount,
                'coupon_id' => $coupon?->id,
                'notes' => $data['notes'] ?? null,
                'scheduled_for' => $data['scheduled_for'] ?? null,
                'placed_at' => now(),
            ]);

            if ($paymentMethod === 'gcash') {
                $order->payments()->create([
                    'provider' => 'gcash',
                    'provider_transaction_id' => 'demo-checkout-'.$order->id,
                    'amount' => $totalAmount,
                    'currency' => 'PHP',
                    'status' => 'succeeded',
                    'paid_at' => now(),
                    'raw_response' => ['source' => 'checkout_demo'],
                ]);
            }

            // Snapshot freshly priced lines into order items.
            foreach ($priced['lines'] as $line) {
                $orderItem = $order->orderItems()->create([
                    'menu_item_id' => $line['menu_item']->id,
                    'item_name' => $line['menu_item']->name,
                    'unit_price' => $line['unit_price'],
                    'quantity' => $line['quantity'],
                    'subtotal' => $line['line_total'],
                    'notes' => $line['cart_item']->notes,
                ]);

                foreach ($line['options'] as $option) {
                    $orderItem->options()->create([
                        'option_name' => $option['option_name'],
                        'price_delta' => $option['price_delta'],
                    ]);
                }
            }

            // Clear the cart after ordering
            $cart->cartItems()->delete();
            $cart->update(['address_id' => null, 'coupon_id' => null, 'reward_key' => null]);

            // Record initial status
            $order->statusHistory()->create([
                'status' => Order::STATUS_PENDING,
                'changed_by' => $user->id,
                'note' => 'Order placed.',
            ]);

            if ($coupon) {
                CouponRedemption::create([
                    'coupon_id' => $coupon->id,
                    'user_id' => $user->id,
                    'order_id' => $order->id,
                ]);
            }

            // Deduct reserved points last: every other validation has passed,
            // so a failure here cannot leave a half-built order behind.
            if ($rewardKey !== null && $rewardKey !== '' && $rewardCost > 0) {
                $definition = PointLedger::definition($rewardKey);
                PointLedger::spendForOrder(
                    $user->id,
                    $order,
                    $rewardCost,
                    'Redeemed '.($definition['label'] ?? $rewardKey)." on {$order->order_number}"
                );
            }

            $order->load(['orderItems.options', 'coupon', 'address']);

            return response()->json(['data' => $order], 201);
        });
    }

    /**
     * POST /api/orders/{order}/cancel - customer cancels their own order while
     * it is still pending/confirmed. Points spent on a reward are refunded.
     */
    public function cancel(Request $request, Order $order): JsonResponse
    {
        $user = $request->user();

        if ($order->user_id !== $user->id) {
            return response()->json(['message' => 'Forbidden.'], 403);
        }

        if (! in_array($order->status, [Order::STATUS_PENDING, Order::STATUS_CONFIRMED], true)) {
            return response()->json([
                'message' => "An order with status {$order->status} can no longer be cancelled.",
            ], 422);
        }

        $order->update(['status' => Order::STATUS_CANCELLED]);
        $this->refundDemoGcashPayment($order);

        $order->statusHistory()->create([
            'status' => Order::STATUS_CANCELLED,
            'changed_by' => $user->id,
            'note' => 'Cancelled by customer.',
        ]);

        PointLedger::refundForOrder($order->fresh());

        return response()->json(['data' => $order->fresh()]);
    }

    /**
     * PUT /api/admin/orders/{order}/status - change order status (staff/admin).
     */
    public function updateStatus(Request $request, Order $order, DeliveryAssignmentService $assignments): JsonResponse
    {
        if (! $request->user()->isStaff()) {
            return response()->json(['message' => 'Forbidden.'], 403);
        }

        $data = $request->validate([
            'status' => ['required', 'in:pending,confirmed,preparing,ready,out_for_delivery,completed,cancelled'],
            'note' => ['nullable', 'string', 'max:500'],
        ]);

        if ($data['status'] !== $order->status
            && ! in_array($data['status'], self::STATUS_TRANSITIONS[$order->status] ?? [], true)) {
            return response()->json([
                'message' => "Cannot move an order from {$order->status} to {$data['status']}.",
            ], 422);
        }

        if ($order->order_type === 'delivery'
            && in_array($data['status'], [Order::STATUS_OUT_FOR_DELIVERY, Order::STATUS_COMPLETED], true)) {
            return response()->json([
                'message' => 'Only the assigned rider can advance the delivery leg.',
            ], 422);
        }

        $order->update(['status' => $data['status']]);

        $order->statusHistory()->create([
            'status' => $data['status'],
            'changed_by' => $request->user()->id,
            'note' => $data['note'] ?? null,
        ]);

        if ($data['status'] === Order::STATUS_COMPLETED) {
            PointLedger::awardForOrder($order->fresh());
        }

        if ($data['status'] === Order::STATUS_CANCELLED) {
            $this->refundDemoGcashPayment($order);
            PointLedger::refundForOrder($order->fresh());
        }

        // A delivery order that just became ready is handed to the next queued
        // rider automatically; staff no longer pick one by hand.
        if ($order->order_type === 'delivery' && $data['status'] === Order::STATUS_READY) {
            $assignments->assignRiderToOrder($order->fresh());
        }

        return response()->json(['data' => $order->fresh()->load('rider:id,name,phone')]);
    }

    private function refundDemoGcashPayment(Order $order): void
    {
        if ($order->payment_method !== 'gcash' || $order->payment_status !== Order::PAYMENT_PAID) {
            return;
        }

        $order->payments()->where('status', 'succeeded')->update(['status' => 'refunded']);
        $order->update(['payment_status' => Order::PAYMENT_REFUNDED]);
    }

    /**
     * Collision-safe order number. Retrying inside a Postgres transaction
     * after a unique violation is impossible (the transaction is aborted),
     * so the candidate is checked before insert and the unique index on
     * orders.order_number stays as the backstop.
     */
    private function generateOrderNumber(): string
    {
        do {
            $number = 'ORD-'.now()->format('Ymd').'-'.strtoupper(substr(bin2hex(random_bytes(4)), 0, 8));
        } while (Order::where('order_number', $number)->exists());

        return $number;
    }
}
