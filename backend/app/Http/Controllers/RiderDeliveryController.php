<?php

namespace App\Http\Controllers;

use App\Http\Requests\General\PaginationRequest;
use App\Models\Order;
use App\Models\RiderProfile;
use App\Services\DeliveryAssignmentService;
use App\Services\DutyCodeService;
use App\Services\PointLedger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

/**
 * The authenticated rider's own delivery queue. Riders see only orders
 * assigned to them and advance just the delivery leg:
 * ready -> out_for_delivery (pick up) -> completed (delivered with a camera
 * proof via completeDelivery). Kitchen states stay staff-only.
 */
class RiderDeliveryController extends Controller
{
    private const RIDER_TRANSITIONS = [
        Order::STATUS_READY => [Order::STATUS_OUT_FOR_DELIVERY],
    ];

    public function __construct(private readonly DutyCodeService $dutyCodes) {}

    public function index(Request $request, PaginationRequest $pagination): JsonResponse
    {
        $orders = Order::query()
            ->where('rider_id', $request->user()->id)
            ->with([
                'user:id,name,phone',
                'address:id,label,line1,line2,city,state,postal_code,country,latitude,longitude,is_default',
                'orderItems:id,order_id,item_name,quantity,subtotal',
            ])
            ->orderByDesc('placed_at')
            ->paginate($pagination->perPage(15));

        return $this->paginated($orders);
    }

    public function show(Request $request, int $order): JsonResponse
    {
        $record = Order::query()
            ->where('id', $order)
            ->where('rider_id', $request->user()->id)
            ->with(['user:id,name,phone', 'address', 'orderItems.options', 'statusHistory', 'coupon'])
            ->firstOrFail();

        return response()->json(['data' => $record]);
    }

    /**
     * PUT /api/rider/availability - clock out (end of shift). Readiness is
     * cleared too, so the rider leaves the delivery queue as well.
     */
    public function updateAvailability(Request $request): JsonResponse
    {
        $data = $request->validate([
            'is_available' => ['required', 'boolean'],
        ]);

        if ($data['is_available']) {
            return response()->json(['message' => 'Scan the daily duty QR to clock in.'], 422);
        }

        if ($this->hasActiveDelivery($request->user()->id)) {
            return response()->json(['message' => 'Finish the assigned delivery before going off duty.'], 422);
        }

        $profile = RiderProfile::updateOrCreate(
            ['user_id' => $request->user()->id],
            ['is_active' => false, 'duty_checked_in_at' => null, 'delivery_ready_at' => null],
        );

        return response()->json(['data' => $profile]);
    }

    public function checkIn(Request $request): JsonResponse
    {
        $data = $request->validate([
            'code' => ['required', 'string'],
        ]);

        if (! $this->dutyCodes->verify($data['code'])) {
            return response()->json(['message' => 'Invalid or expired duty code.'], 422);
        }

        $profile = RiderProfile::updateOrCreate(
            ['user_id' => $request->user()->id],
            ['is_active' => true, 'duty_checked_in_at' => now(), 'delivery_ready_at' => null],
        );

        return response()->json(['data' => $this->withAvailabilityStatus($profile)]);
    }

    /**
     * PUT /api/rider/readiness - join (or leave) the delivery queue. A rider
     * must be clocked in first. Joining hands them the oldest waiting ready
     * order immediately, and the backend auto-assigns subsequent orders.
     */
    public function updateReadiness(Request $request, DeliveryAssignmentService $assignments): JsonResponse
    {
        $data = $request->validate([
            'ready' => ['required', 'boolean'],
        ]);

        $userId = $request->user()->id;

        if ($data['ready']) {
            $profile = RiderProfile::query()->where('user_id', $userId)->first();

            if ($profile === null || ! $profile->is_active) {
                return response()->json(['message' => 'Clock in with the daily duty QR first.'], 422);
            }

            // Idempotent: joining again just refreshes the FIFO position.
            RiderProfile::query()->where('user_id', $userId)->update(['delivery_ready_at' => now()]);

            $assignments->assignWaitingOrderToRider($request->user());

            return response()->json(['data' => $this->withAvailabilityStatus($profile->fresh())]);
        }

        if ($this->hasActiveDelivery($userId)) {
            return response()->json(['message' => 'Finish the assigned delivery before pausing.'], 422);
        }

        $profile = RiderProfile::updateOrCreate(['user_id' => $userId], ['delivery_ready_at' => null]);

        return response()->json(['data' => $this->withAvailabilityStatus($profile)]);
    }

    /**
     * POST /api/rider/deliveries/{order}/complete - mark delivered. Requires a
     * camera shot of the item; the photo and completion are atomic so an order
     * can never be completed without proof.
     */
    public function completeDelivery(Request $request, int $order): JsonResponse
    {
        $data = $request->validate([
            'image' => ['required', 'file', 'image', 'mimes:jpg,jpeg,png,webp', 'max:5120', 'dimensions:min_width=128,min_height=128,max_width=6000,max_height=6000'],
            'note' => ['nullable', 'string', 'max:500'],
        ]);

        return DB::transaction(function () use ($data, $order, $request) {
            $record = Order::query()
                ->where('id', $order)
                ->where('rider_id', $request->user()->id)
                ->where('status', Order::STATUS_OUT_FOR_DELIVERY)
                ->lockForUpdate()
                ->firstOrFail();

            if ($record->payment_method === 'gcash' && $record->payment_status !== Order::PAYMENT_PAID) {
                return response()->json(['message' => 'GCash payment has not been confirmed.'], 422);
            }

            $updates = [
                'status' => Order::STATUS_COMPLETED,
                'delivery_proof_path' => $data['image']->store('uploads/images/delivery-proofs', 'public'),
            ];

            if ($record->payment_method === 'cod' && $record->payment_status !== Order::PAYMENT_PAID) {
                $updates['payment_status'] = Order::PAYMENT_PAID;
                $record->payments()->create([
                    'provider' => 'cod',
                    'provider_transaction_id' => 'rider-collection-'.$record->id,
                    'amount' => $record->total_amount,
                    'currency' => 'PHP',
                    'status' => 'succeeded',
                    'paid_at' => now(),
                    'raw_response' => [
                        'source' => 'rider_delivery_completion',
                        'collected_by' => $request->user()->id,
                    ],
                ]);
            }

            $record->update($updates);

            $record->statusHistory()->create([
                'status' => Order::STATUS_COMPLETED,
                'changed_by' => $request->user()->id,
                'note' => $data['note'] ?? null,
            ]);

            PointLedger::awardForOrder($record->fresh());

            return response()->json(['data' => $record->fresh()]);
        });
    }

    /**
     * PUT /api/rider/deliveries/{order}/status - pick up an order
     * (ready -> out_for_delivery). Completion goes through completeDelivery.
     */
    public function updateStatus(Request $request, int $order): JsonResponse
    {
        $data = $request->validate([
            'status' => ['required', 'in:out_for_delivery'],
            'note' => ['nullable', 'string', 'max:500'],
        ]);

        return DB::transaction(function () use ($data, $order, $request) {
            $record = Order::query()
                ->where('id', $order)
                ->where('rider_id', $request->user()->id)
                ->lockForUpdate()
                ->firstOrFail();

            $allowed = self::RIDER_TRANSITIONS[$record->status] ?? [];

            if ($data['status'] === $record->status || ! in_array($data['status'], $allowed, true)) {
                return response()->json([
                    'message' => "Cannot move an order from {$record->status} to {$data['status']}.",
                ], 422);
            }

            $record->update(['status' => $data['status']]);

            $record->statusHistory()->create([
                'status' => $data['status'],
                'changed_by' => $request->user()->id,
                'note' => $data['note'] ?? null,
            ]);

            return response()->json(['data' => $record->fresh()]);
        });
    }

    /**
     * GET /api/rider/profile - the authenticated rider's own profile.
     */
    public function showProfile(Request $request): JsonResponse
    {
        $profile = RiderProfile::query()
            ->where('user_id', $request->user()->id)
            ->first();

        if ($profile === null) {
            $profile = RiderProfile::create([
                'user_id' => $request->user()->id,
                'is_active' => false,
            ]);
        }

        return response()->json(['data' => $this->withAvailabilityStatus($profile)]);
    }

    /**
     * PUT /api/rider/profile - rider edits their own vehicle / plate / photo.
     */
    public function updateProfile(Request $request): JsonResponse
    {
        $data = $request->validate([
            'photo_url' => ['sometimes', 'nullable', 'string', 'max:255'],
            'vehicle_type' => ['sometimes', 'nullable', 'string', Rule::in(['motorcycle', 'bicycle', 'car'])],
            'plate_number' => ['sometimes', 'nullable', 'string', 'max:20'],
        ]);

        $profile = RiderProfile::updateOrCreate(
            ['user_id' => $request->user()->id],
            $data
        );

        return response()->json(['data' => $profile]);
    }

    private function hasActiveDelivery(int $riderId): bool
    {
        return Order::query()
            ->where('rider_id', $riderId)
            ->whereNotIn('status', [Order::STATUS_COMPLETED, Order::STATUS_CANCELLED])
            ->exists();
    }

    private function withAvailabilityStatus(RiderProfile $profile): RiderProfile
    {
        $profile->setAttribute('availability_status', $this->hasActiveDelivery($profile->user_id)
            ? 'on_delivery'
            : ($profile->is_active && $profile->delivery_ready_at ? 'available' : 'not_available'));

        return $profile;
    }
}
