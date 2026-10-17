<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class RiderProfile extends Model
{
    protected $fillable = [
        'user_id',
        'photo_url',
        'vehicle_type',
        'plate_number',
        'is_active',
        'duty_checked_in_at',
        'delivery_ready_at',
    ];

    protected function casts(): array
    {
        return [
            'is_active' => 'boolean',
            'duty_checked_in_at' => 'datetime',
            'delivery_ready_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /**
     * Clock out every rider still on duty. Called by the end-of-day scheduled
     * job so riders who forgot to clock out are reset automatically. Readiness
     * is cleared too, so nobody stays queued into the next day.
     */
    public static function clockOutActiveRiders(): int
    {
        return static::query()
            ->where('is_active', true)
            ->update([
                'is_active' => false,
                'duty_checked_in_at' => null,
                'delivery_ready_at' => null,
            ]);
    }
}
