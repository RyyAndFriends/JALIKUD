<?php

namespace App\Http\Controllers;

use App\Http\Requests\General\PaginationRequest;
use App\Models\RiderProfile;
use App\Models\Order;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Staff-facing rider directory used by the order-assignment picker.
 */
class RiderController extends Controller
{
    public function index(PaginationRequest $request): JsonResponse
    {
        $riders = User::query()
            ->where('role', User::ROLE_RIDER)
            ->with('riderProfile')
            ->orderBy('name')
            ->paginate($request->perPage(15));

        $busyIds = Order::query()
            ->whereNotNull('rider_id')
            ->whereNotIn('status', [Order::STATUS_COMPLETED, Order::STATUS_CANCELLED])
            ->pluck('rider_id')
            ->all();

        $riders->getCollection()->transform(function (User $rider) use ($busyIds) {
            $rider->setAttribute('availability_status', in_array($rider->id, $busyIds, true)
                ? 'on_delivery'
                : ($rider->riderProfile?->is_active ? 'available' : 'not_available'));

            return $rider;
        });

        return $this->paginated($riders);
    }

    /**
     * PUT /api/admin/riders/{user}/profile - administer a rider's vehicle,
     * plate, photo and duty status.
     */
    public function updateProfile(Request $request, User $user): JsonResponse
    {
        if ($user->role !== User::ROLE_RIDER) {
            return response()->json(['message' => 'The selected user is not a rider.'], 422);
        }

        $data = $request->validate([
            'photo_url' => ['sometimes', 'nullable', 'string', 'max:255'],
            'vehicle_type' => ['sometimes', 'nullable', 'string', Rule::in(['motorcycle', 'bicycle', 'car'])],
            'plate_number' => ['sometimes', 'nullable', 'string', 'max:20'],
            'is_active' => ['sometimes', 'boolean'],
        ]);

        $profile = RiderProfile::updateOrCreate(['user_id' => $user->id], $data);

        return response()->json(['data' => $profile]);
    }

    public function approveDuty(User $user): JsonResponse
    {
        if ($user->role !== User::ROLE_RIDER) {
            return response()->json(['message' => 'The selected user is not a rider.'], 422);
        }

        $profile = $user->riderProfile;
        if ($profile === null || $profile->duty_requested_at === null) {
            return response()->json(['message' => 'This rider has no pending duty QR request.'], 422);
        }

        $busy = Order::query()
            ->where('rider_id', $user->id)
            ->whereNotIn('status', [Order::STATUS_COMPLETED, Order::STATUS_CANCELLED])
            ->exists();
        if ($busy) {
            return response()->json(['message' => 'This rider already has an active delivery.'], 422);
        }

        $profile->update(['is_active' => true, 'duty_requested_at' => null]);

        $fresh = $profile->fresh();
        $fresh->setAttribute('availability_status', 'available');

        return response()->json(['data' => $fresh]);
    }
}
