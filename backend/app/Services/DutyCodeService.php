<?php

namespace App\Services;

use Carbon\CarbonInterface;

/**
 * Generates and verifies the daily duty code that staff display as a QR and
 * riders scan to clock in. The code is an HMAC of the date, so it cannot be
 * forged by a rider, and it rotates automatically at midnight.
 */
class DutyCodeService
{
    public function today(): string
    {
        return $this->codeFor(now());
    }

    public function verify(string $code): bool
    {
        $today = now();

        // Accept today's code and yesterday's, so a rider scanning a few seconds
        // after midnight is not rejected before staff regenerate the QR.
        return hash_equals($this->codeFor($today), $code)
            || hash_equals($this->codeFor($today->copy()->subDay()), $code);
    }

    private function codeFor(CarbonInterface $date): string
    {
        return $date->format('Y-m-d').'.'.$this->signature($date);
    }

    private function signature(CarbonInterface $date): string
    {
        $digest = hash_hmac('sha256', 'jalikud-duty:'.$date->format('Y-m-d'), (string) config('app.key'));

        return substr($digest, 0, 16);
    }
}
