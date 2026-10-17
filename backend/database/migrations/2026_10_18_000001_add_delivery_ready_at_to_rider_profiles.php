<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('rider_profiles', function (Blueprint $table) {
            // Null = not in the delivery queue. When set, the rider is "ready
            // to deliver" and the timestamp doubles as their FIFO position.
            $table->timestampTz('delivery_ready_at')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('rider_profiles', function (Blueprint $table) {
            $table->dropColumn('delivery_ready_at');
        });
    }
};
