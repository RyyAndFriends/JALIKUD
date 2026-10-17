<?php

use Illuminate\Auth\AuthenticationException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // Apply the named 'api' rate limiter (AppServiceProvider) to all api routes.
        $middleware->throttleApi();

        // This app is API-only and has no `login` route. Laravel's default
        // guest redirect target is route('login'), which throws a
        // RouteNotFoundException and turns every unauthenticated API call from
        // a caller that does not send `Accept: application/json` (curl, a
        // browser address bar, Postman with the header cleared) into a 500 that
        // hides the real 401. API routes must answer with 401 JSON, so send
        // guests to a path that does not exist instead — the JSON 401 below in
        // withExceptions() is what they actually receive.
        $middleware->redirectGuestsTo(fn () => '/');

        // Proxy trust is configured in AppServiceProvider::boot() instead of here.
        // This file is evaluated before Laravel boots dotenv, and php-fpm workers
        // do not inherit $_SERVER, so env()/$_SERVER/$_ENV/getenv() are all empty
        // here and TRUSTED_PROXIES would silently collapse to the 127.0.0.1
        // default — making every proxied request share one rate-limit bucket.
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );

        // An unauthenticated request to an API route must be answered with a
        // 401 JSON body, never a redirect. Laravel's default handler decides
        // with $request->expectsJson(), which ignores the shouldRenderJsonWhen()
        // rule above, so a caller that omits `Accept: application/json`
        // (curl, a browser address bar, Postman with the header cleared) falls
        // through to redirect()->guest(route('login')). This app is API-only and
        // defines no `login` route, so that throws and surfaces as a 500 that
        // masks the real "you are not authenticated" 401.
        $exceptions->render(function (AuthenticationException $e, Request $request) {
            if ($request->is('api/*')) {
                return response()->json(['message' => 'Unauthenticated.'], 401);
            }

            return null;
        });
    })
    ->withSchedule(function (Schedule $schedule): void {
        // End-of-day reset: clock out every rider still on duty (forgot to
        // clock out). 2 AM Manila time, after the store has closed.
        $schedule->command('riders:auto-clock-out')->dailyAt('02:00')->timezone('Asia/Manila');
    })
    ->create();