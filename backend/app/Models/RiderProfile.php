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
        'duty_requested_at',
    ];

    protected function casts(): array
    {
        return [
            'is_active' => 'boolean',
            'duty_requested_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
