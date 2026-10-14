<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('rider_profiles', function (Blueprint $table) {
            $table->timestampTz('duty_requested_at')->nullable();
        });

        Schema::table('orders', function (Blueprint $table) {
            $table->string('delivery_proof_path')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('orders', fn (Blueprint $table) => $table->dropColumn('delivery_proof_path'));
        Schema::table('rider_profiles', fn (Blueprint $table) => $table->dropColumn('duty_requested_at'));
    }
};
