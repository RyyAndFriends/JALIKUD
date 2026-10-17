<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('rider_profiles', function (Blueprint $table) {
            $table->timestampTz('duty_checked_in_at')->nullable();
            $table->dropColumn('duty_requested_at');
        });
    }

    public function down(): void
    {
        Schema::table('rider_profiles', function (Blueprint $table) {
            $table->timestampTz('duty_requested_at')->nullable();
            $table->dropColumn('duty_checked_in_at');
        });
    }
};
