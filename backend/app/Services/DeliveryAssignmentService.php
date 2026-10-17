<?php

namespace App\Services;

use App\Models\Order;
use App\Models\RiderProfile;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * Automatic rider-to-delivery assignment.
 *
 * Riders join a queue (rider_profiles.delivery_ready_at) and the backend hands
 * out delivery orders FIFO, so staff no longer pick a rider by hand. Assignment
 * is triggered from both directions so no ready order can be stranded:
 *
 *   - an order reaching `ready` grabs the next free queued rider;
 *   - a rider joining the queue grabs the oldest waiting `ready` order.
 */
class DeliveryAssignmentService
{
    /**
     * Assign the next queued, free rider to a delivery order that just became
     * ready. Returns true if a rider was assigned.
     */
    public function assignRiderToOrder(Order $order): bool
    {
        if ($order->order_type !== 'delivery' || $order->status !== Order::STATUS_READY || $order->rider_id !== null) {
            return false;
        }

        return DB::transaction(function () use ($order): bool {
            $locked = Order::query()->whereKey($order->id)->lockForUpdate()->first();

            if ($locked === null || $locked->rider_id !== null || $locked->status !== Order::STATUS_READY) {
                return false;
            }

            $profile = $this->lockNextFreeQueuedProfile();

            if ($profile === null) {
                return false;
            }

            $locked->update(['rider_id' => $profile->user_id, 'assigned_at' => now()]);

            return true;
        });
    }

    /**
     * When a rider joins the queue, hand them the oldest unassigned ready
     * delivery order, if any. Returns the assigned order or null.
     */
    public function assignWaitingOrderToRider(User $rider): ?Order
    {
        return DB::transaction(function () use ($rider): ?Order {
            if ($this->hasActiveDelivery($rider->id)) {
                return null;
            }

            $order = Order::query()
                ->where('order_type', 'delivery')
                ->whereNull('rider_id')
                ->where('status', Order::STATUS_READY)
                ->orderBy('placed_at')
                ->orderBy('id')
                ->lockForUpdate()
                ->first();

            if ($order === null) {
                return null;
            }

            $order->update(['rider_id' => $rider->id, 'assigned_at' => now()]);

            return $order->fresh();
        });
    }

    /**
     * The next rider who is in the queue and not currently delivering, with
     * their profile row locked so concurrent assignments cannot double-book.
     */
    private function lockNextFreeQueuedProfile(): ?RiderProfile
    {
        $busyIds = $this->busyRiderIds();

        $query = RiderProfile::query()
            ->whereNotNull('delivery_ready_at')
            ->orderBy('delivery_ready_at')
            ->orderBy('user_id');

        if ($busyIds !== []) {
            $query->whereNotIn('user_id', $busyIds);
        }

        $candidate = $query->first();

        if ($candidate === null) {
            return null;
        }

        $locked = RiderProfile::query()->whereKey($candidate->id)->lockForUpdate()->first();

        if ($locked === null
            || $locked->delivery_ready_at === null
            || in_array((int) $locked->user_id, $busyIds, true)) {
            return null;
        }

        return $locked;
    }

    private function busyRiderIds(): array
    {
        return Order::query()
            ->whereNotNull('rider_id')
            ->whereNotIn('status', [Order::STATUS_COMPLETED, Order::STATUS_CANCELLED])
            ->pluck('rider_id')
            ->map(fn ($id) => (int) $id)
            ->all();
    }

    private function hasActiveDelivery(int $riderId): bool
    {
        return Order::query()
            ->where('rider_id', $riderId)
            ->whereNotIn('status', [Order::STATUS_COMPLETED, Order::STATUS_CANCELLED])
            ->exists();
    }
}
