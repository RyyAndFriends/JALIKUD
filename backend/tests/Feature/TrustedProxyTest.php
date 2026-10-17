<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Middleware\TrustProxies;
use Tests\TestCase;

/**
 * Regression coverage for trusted-proxy configuration.
 *
 * Rate-limit buckets are keyed on $request->ip(). When the trust list does
 * not include the reverse proxy, every proxied request resolves to the proxy's
 * IP and therefore shares ONE bucket — a single client could then lock every
 * other user out with a 429.
 *
 * The trust list is configured in AppServiceProvider::boot() rather than
 * bootstrap/app.php because that file is evaluated before dotenv loads, which
 * would silently collapse TRUSTED_PROXIES back to the 127.0.0.1 default.
 */
class TrustedProxyTest extends TestCase
{
    use RefreshDatabase;

    private function trustedProxies(): array
    {
        $property = new \ReflectionProperty(TrustProxies::class, 'alwaysTrustProxies');
        $property->setAccessible(true);

        return $property->getValue() ?? [];
    }

    public function test_trust_list_is_populated_from_the_environment(): void
    {
        $this->assertContains('172.30.0.20', $this->trustedProxies(),
            'TRUSTED_PROXIES must reach the TrustProxies trust list.');
    }

    public function test_forwarded_client_ip_is_used_when_the_proxy_is_trusted(): void
    {
        $this->withServerVariables([
            'REMOTE_ADDR' => '172.30.0.20',
            'HTTP_X_FORWARDED_FOR' => '203.0.113.77',
        ])->getJson('/api/menu')->assertOk();

        $this->assertSame('203.0.113.77', request()->ip(),
            'With the proxy trusted, ip() must report the real client so each client gets its own bucket.');
    }

    public function test_different_clients_resolve_to_different_ips(): void
    {
        $this->withServerVariables([
            'REMOTE_ADDR' => '172.30.0.20',
            'HTTP_X_FORWARDED_FOR' => '203.0.113.10',
        ])->getJson('/api/menu')->assertOk();
        $first = request()->ip();

        $this->withServerVariables([
            'REMOTE_ADDR' => '172.30.0.20',
            'HTTP_X_FORWARDED_FOR' => '203.0.113.11',
        ])->getJson('/api/menu')->assertOk();
        $second = request()->ip();

        $this->assertNotSame($first, $second);
    }

    public function test_untrusted_remote_address_falls_back_to_the_socket_ip(): void
    {
        // A request that does NOT come from the trusted proxy must not be able
        // to dictate its own client IP via a spoofed header.
        $this->withServerVariables([
            'REMOTE_ADDR' => '198.51.100.9',
            'HTTP_X_FORWARDED_FOR' => '203.0.113.99',
        ])->getJson('/api/menu')->assertOk();

        $this->assertSame('198.51.100.9', request()->ip(),
            'A spoofed X-Forwarded-For from an untrusted peer must be ignored.');
    }

    public function test_trust_list_covers_every_proxy_hop_in_front_of_the_api(): void
    {
        // Each entry below is a hop that can terminate in front of Laravel once
        // the stack is published through tunnels. Omitting one collapses the
        // rate-limit buckets of everyone arriving through that hop into a
        // single bucket keyed on the proxy address.
        $trusted = $this->trustedProxies();

        $this->assertContains('172.30.0.1', $trusted,
            'The docker bridge gateway must be trusted: an agent running OUTSIDE docker (ngrok) '
            .'reaches the frontend through a published port, and nginx appends the gateway to '
            .'X-Forwarded-For.');

        $this->assertContains('172.30.0.20', $trusted,
            'The nginx container proxies /api and must stay trusted.');

        $cloudflared = env('CLOUDFLARE_IP', '172.30.0.30');
        $this->assertContains($cloudflared, $trusted,
            'The cloudflared container dials the backend directly, bypassing nginx, '
            .'so its own address must be trusted.');
    }

    public function test_unauthenticated_api_request_without_json_accept_header_returns_401(): void
    {
        // Regression: this app has no `login` route, and Laravel's default
        // unauthenticated handler redirects to route('login') whenever the
        // request does not expect JSON. curl, a browser address bar, and Postman
        // with the Accept header cleared all hit that path, which surfaced as a
        // 500 instead of the correct 401.
        $response = $this->withHeaders(['Accept' => 'text/html'])
            ->get('/api/admin/users');

        $response->assertStatus(401);
        $this->assertSame('Unauthenticated.', $response->json('message'));
    }
}
