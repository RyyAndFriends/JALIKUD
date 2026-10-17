<?php

namespace App\Console\Commands;

use App\Models\RiderProfile;
use Illuminate\Console\Command;

class AutoClockOutRiders extends Command
{
    protected $signature = 'riders:auto-clock-out';

    protected $description = 'Clock out riders still on duty long past a normal shift.';

    public function handle(): int
    {
        $count = RiderProfile::clockOutActiveRiders();

        $this->info("Auto-clocked out {$count} rider(s).");

        return self::SUCCESS;
    }
}
