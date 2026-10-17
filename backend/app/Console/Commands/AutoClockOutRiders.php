<?php

namespace App\Console\Commands;

use App\Models\RiderProfile;
use Illuminate\Console\Command;

class AutoClockOutRiders extends Command
{
    protected $signature = 'riders:auto-clock-out';

    protected $description = 'End-of-day reset: clock out every rider still on duty and clear the delivery queue.';

    public function handle(): int
    {
        $count = RiderProfile::clockOutActiveRiders();

        $this->info("Auto-clocked out {$count} rider(s).");

        return self::SUCCESS;
    }
}
