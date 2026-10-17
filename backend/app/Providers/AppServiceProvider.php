<?php

namespace App\Providers;

use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Middleware\TrustProxies;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // Trust X-Forwarded-* headers only from the explicitly listed proxies so
        // a client cannot spoof X-Forwarded-For to mint a fresh rate-limit
        // bucket, while still letting $request->ip() report the real client.
        //
        // This must run here rather than in bootstrap/app.php: that file is
        // evaluated before dotenv loads, and php-fpm workers do not inherit
        // $_SERVER/$_ENV, so TRUSTED_PROXIES read there is empty and silently
        // falls back to 127.0.0.1 — which makes every proxied request share a
        // single bucket. boot() runs after dotenv, so env() is reliable. Values
        // are comma separated IPs/CIDRs; set this to the proxy only (e.g. the
        // nginx container), never the client range.
        $trustedProxies = array_values(array_filter(array_map(
            'trim',
            explode(',', (string) env('TRUSTED_PROXIES', '127.0.0.1'))
        )));

        if ($trustedProxies !== []) {
            TrustProxies::at($trustedProxies);
        }

        // Applied to every api/* route via throttleApi() in bootstrap/app.php.
        RateLimiter::for('api', function (Request $request) {
            return $request->user()
                ? Limit::perMinute(120)->by('api-user:'.$request->user()->id)
                : Limit::perMinute(60)->by('api-ip:'.$request->ip());
        });

        // Stricter named limiters for abuse-prone endpoints.
        RateLimiter::for('orders', fn (Request $request) => Limit::perMinute(10)->by('orders:'.($request->user()?->id ?? $request->ip())));
        RateLimiter::for('coupons', fn (Request $request) => Limit::perMinute(6)->by('coupons:'.($request->user()?->id ?? $request->ip())));
        RateLimiter::for('password', fn (Request $request) => Limit::perMinute(5)->by('password:'.$request->user()->id));
        RateLimiter::for('chat', fn (Request $request) => Limit::perMinute(20)->by('chat:'.($request->user()?->id ?? $request->ip())));
    }
}