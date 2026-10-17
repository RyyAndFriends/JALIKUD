<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\Coupon;
use App\Models\MenuItem;
use App\Models\Order;
use App\Models\PointTransaction;
use App\Models\Reward;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Loyalty points: earn on completed+paid orders, spend via reserved cart
 * rewards, refund on cancellation.
 */
class RewardsTest extends TestCase
{
    use RefreshDatabase;

    private function customer(): User
    {
        $user = User::factory()->create(['role' => User::ROLE_CUSTOMER]);
        Sanctum::actingAs($user);

        return $user;
    }

    private function staff(): User
    {
        $user = User::factory()->create(['role' => User::ROLE_STAFF]);
        Sanctum::actingAs($user);

        return $user;
    }

    private function menuItem(string $slug = 'chickenjoy-1pc', float $price = 109.0): MenuItem
    {
        $category = Category::create(['name' => 'Mains', 'slug' => 'mains-'.Str::random(6)]);

        return MenuItem::create([
            'category_id' => $category->id,
            'name' => 'Item '.$slug,
            'slug' => $slug,
            'base_price' => $price,
            'is_available' => true,
        ]);
    }

    private function givePoints(User $user, int $points): void
    {
        PointTransaction::create([
            'user_id' => $user->id,
            'order_id' => null,
            'points_delta' => $points,
            'balance_after' => $points,
            'reason' => PointTransaction::REASON_EARNED,
            'description' => 'Test grant',
        ]);
    }

    private function placePickupOrder(): void
    {
        $this->postJson('/api/orders', ['order_type' => 'pickup', 'payment_method' => 'gcash'])->assertStatus(201);
    }

    /**
     * Seed the standard catalogue from config/rewards.php. Free-item rewards are
     * wired to whichever menu item with the matching slug exists at call time.
     */
    private function seedRewards(): void
    {
        foreach (config('rewards.definitions') as $key => $definition) {
            $type = $definition['type'] ?? 'voucher';

            Reward::create([
                'key' => $key,
                'label' => $definition['label'] ?? $key,
                'type' => $type,
                'points_cost' => (int) ($definition['points_cost'] ?? 0),
                'menu_item_id' => $type === 'free_item'
                    ? MenuItem::where('slug', $definition['menu_item_slug'] ?? '')->value('id')
                    : null,
                'discount_amount' => $type === 'voucher' ? ($definition['discount_amount'] ?? null) : null,
                'min_order_amount' => $type === 'voucher' ? ($definition['min_order_amount'] ?? null) : null,
                'is_active' => true,
            ]);
        }
    }

    public function test_rewards_catalog_lists_definitions_with_balance(): void
    {
        $this->getJson('/api/rewards')->assertStatus(401);

        $user = $this->customer();
        $this->menuItem();
        $this->seedRewards();

        $response = $this->getJson('/api/rewards')->assertOk();
        $payload = $response->json('data');

        $this->assertSame(0, $payload['balance']);
        $this->assertCount(3, $payload['rewards']);
        $this->assertSame(['chickenjoy-1pc', 'yumburger', 'voucher-100'], array_column($payload['rewards'], 'key'));
        $this->assertFalse($payload['rewards'][0]['can_afford']);
        $this->assertSame('Item chickenjoy-1pc', $payload['rewards'][0]['menu_item']['name']);

        $this->getJson('/api/points')->assertOk()->assertJsonPath('data.balance', 0);
    }

    public function test_rider_cod_completion_marks_paid_and_awards_points_once(): void
    {
        $customer = User::factory()->create(['role' => User::ROLE_CUSTOMER]);
        $rider = User::factory()->create(['role' => User::ROLE_RIDER]);
        $order = Order::create([
            'order_number' => 'ORD-RWD-1',
            'user_id' => $customer->id,
            'rider_id' => $rider->id,
            'order_type' => 'delivery',
            'status' => Order::STATUS_OUT_FOR_DELIVERY,
            'payment_method' => 'cod',
            'payment_status' => Order::PAYMENT_UNPAID,
            'subtotal' => 250,
            'total_amount' => 250,
        ]);

        Storage::fake('public');
        Sanctum::actingAs($rider);
        $this->post("/api/rider/deliveries/{$order->id}/complete", [
            'image' => UploadedFile::fake()->image('proof.jpg', 640, 480),
        ])->assertOk();
        $this->assertDatabaseHas('point_transactions', [
            'user_id' => $customer->id,
            'order_id' => $order->id,
            'points_delta' => 25,
            'reason' => 'earned',
        ]);

        $this->assertSame(1, PointTransaction::where('order_id', $order->id)->where('reason', 'earned')->count());
    }

    public function test_paid_first_then_completed_awards_once(): void
    {
        $customer = User::factory()->create(['role' => User::ROLE_CUSTOMER]);
        $order = Order::create([
            'order_number' => 'ORD-RWD-2',
            'user_id' => $customer->id,
            'order_type' => 'pickup',
            'status' => Order::STATUS_READY,
            'payment_method' => 'gcash',
            'payment_status' => Order::PAYMENT_PAID,
            'subtotal' => 199,
            'total_amount' => 199,
        ]);

        Sanctum::actingAs($this->user(User::ROLE_STAFF));
        $this->assertSame(0, PointTransaction::count());

        $this->putJson("/api/admin/orders/{$order->id}/status", ['status' => Order::STATUS_COMPLETED])->assertOk();

        $this->assertDatabaseHas('point_transactions', [
            'order_id' => $order->id,
            'points_delta' => 19,
            'reason' => 'earned',
        ]);
    }

    public function test_direct_payment_confirmation_endpoint_is_removed(): void
    {
        $customer = $this->user(User::ROLE_CUSTOMER);
        $order = Order::create([
            'order_number' => 'ORD-RWD-3',
            'user_id' => $customer->id,
            'order_type' => 'pickup',
            'status' => Order::STATUS_READY,
            'subtotal' => 100,
            'total_amount' => 100,
        ]);

        Sanctum::actingAs($customer);
        $this->putJson("/api/admin/orders/{$order->id}/payment", ['payment_status' => 'paid'])->assertNotFound();

        Sanctum::actingAs($this->user(User::ROLE_STAFF));
        $this->putJson("/api/admin/orders/{$order->id}/payment", ['payment_status' => 'paid'])->assertNotFound();
    }

    public function test_free_food_reward_discounts_one_live_unit_at_checkout(): void
    {
        $user = $this->customer();
        $this->givePoints($user, 500);
        $item = $this->menuItem('chickenjoy-1pc', 109.0);
        $this->seedRewards();

        $this->postJson('/api/cart/items', ['menu_item_id' => $item->id, 'quantity' => 2])->assertStatus(201);

        $this->postJson('/api/cart/reward', ['reward_key' => 'chickenjoy-1pc'])
            ->assertOk()
            ->assertJsonPath('data.reward.key', 'chickenjoy-1pc')
            ->assertJsonPath('data.reward_discount_amount', '109.00');

        $this->placePickupOrder();

        $order = Order::firstOrFail();
        $this->assertSame('chickenjoy-1pc', $order->reward_key);
        $this->assertSame(109.0, (float) $order->reward_discount_amount);
        // 2 × 109 − 109 reward, no fees configured.
        $this->assertSame(109.0, (float) $order->total_amount);

        $this->assertDatabaseHas('point_transactions', [
            'user_id' => $user->id,
            'order_id' => $order->id,
            'points_delta' => -500,
            'reason' => 'spent',
        ]);
        $this->assertSame(0, PointTransaction::where('user_id', $user->id)->sum('points_delta'));

        // Reservation cleared with the cart.
        $this->getJson('/api/cart')->assertOk()->assertJsonPath('data.reward_key', null);
    }

    public function test_reward_without_its_item_fails_closed_and_spends_nothing(): void
    {
        $user = $this->customer();
        $this->givePoints($user, 500);
        $other = $this->menuItem('yumburger', 89.0);
        $this->seedRewards();

        $this->postJson('/api/cart/items', ['menu_item_id' => $other->id, 'quantity' => 1])->assertStatus(201);
        $this->postJson('/api/cart/reward', ['reward_key' => 'chickenjoy-1pc'])->assertOk();

        $this->getJson('/api/cart')->assertOk()->assertJsonPath('data.pricing_errors.0', 'Add Free Chickenjoy 1pc to your cart to use this reward.');

        $this->postJson('/api/orders', ['order_type' => 'pickup'])->assertStatus(422);
        $this->assertSame(0, Order::count());
        $this->assertSame(500, PointTransaction::where('user_id', $user->id)->sum('points_delta'));
    }

    public function test_insufficient_balance_at_checkout_aborts_without_an_order(): void
    {
        $user = $this->customer();
        $item = $this->menuItem('chickenjoy-1pc', 109.0);
        $this->seedRewards();
        $this->postJson('/api/cart/items', ['menu_item_id' => $item->id, 'quantity' => 1])->assertStatus(201);

        // Reserved earlier, balance since drained elsewhere.
        $this->givePoints($user, 500);
        $this->postJson('/api/cart/reward', ['reward_key' => 'chickenjoy-1pc'])->assertOk();
        PointTransaction::create([
            'user_id' => $user->id,
            'order_id' => null,
            'points_delta' => -500,
            'balance_after' => 0,
            'reason' => 'spent',
            'description' => 'Drained elsewhere',
        ]);

        $this->postJson('/api/orders', ['order_type' => 'pickup'])->assertStatus(422);
        $this->assertSame(0, Order::count());
    }

    public function test_voucher_enforces_minimum_and_rejects_coupon_stacking(): void
    {
        $user = $this->customer();
        $this->givePoints($user, 1000);
        $item = $this->menuItem('yumburger', 89.0);
        $this->seedRewards();
        $this->postJson('/api/cart/items', ['menu_item_id' => $item->id, 'quantity' => 2])->assertStatus(201);

        // Subtotal 178 < 300 minimum: selectable, but checkout refuses.
        $this->postJson('/api/cart/reward', ['reward_key' => 'voucher-100'])->assertOk();
        $this->postJson('/api/orders', ['order_type' => 'pickup'])->assertStatus(422);

        $this->postJson('/api/cart/items', ['menu_item_id' => $item->id, 'quantity' => 2])->assertOk();
        $this->placePickupOrder();

        $order = Order::firstOrFail();
        $this->assertSame('voucher-100', $order->reward_key);
        $this->assertSame(100.0, (float) $order->reward_discount_amount);
        $this->assertSame(256.0, (float) $order->total_amount);
    }

    public function test_coupons_and_rewards_never_combine(): void
    {
        $user = $this->customer();
        $this->givePoints($user, 1000);
        $item = $this->menuItem('yumburger', 89.0);
        $this->seedRewards();
        $this->postJson('/api/cart/items', ['menu_item_id' => $item->id, 'quantity' => 4])->assertStatus(201);

        Coupon::create([
            'code' => 'STACK10',
            'type' => 'fixed',
            'value' => 10,
            'is_active' => true,
        ]);

        $this->postJson('/api/cart/coupon', ['code' => 'STACK10'])->assertOk();
        $this->postJson('/api/cart/reward', ['reward_key' => 'voucher-100'])
            ->assertStatus(422)
            ->assertJsonPath('message', 'Remove the applied coupon before selecting a reward.');

        $this->deleteJson('/api/cart')->assertOk();
        $this->postJson('/api/cart/items', ['menu_item_id' => $item->id, 'quantity' => 4])->assertSuccessful();
        $this->postJson('/api/cart/reward', ['reward_key' => 'voucher-100'])->assertOk();
        $this->postJson('/api/cart/coupon', ['code' => 'STACK10'])
            ->assertStatus(422)
            ->assertJsonPath('message', 'Remove the selected reward before applying a coupon.');
    }

    public function test_cancelling_a_reward_order_refunds_points_once(): void
    {
        $user = $this->customer();
        $this->givePoints($user, 500);
        $item = $this->menuItem('chickenjoy-1pc', 109.0);
        $this->seedRewards();
        $this->postJson('/api/cart/items', ['menu_item_id' => $item->id, 'quantity' => 1])->assertStatus(201);
        $this->postJson('/api/cart/reward', ['reward_key' => 'chickenjoy-1pc'])->assertOk();
        $this->placePickupOrder();

        $order = Order::firstOrFail();
        $this->assertSame(0, PointTransaction::where('user_id', $user->id)->sum('points_delta'));

        Sanctum::actingAs($this->staff());
        $this->putJson("/api/admin/orders/{$order->id}/status", ['status' => Order::STATUS_CONFIRMED])->assertOk();
        $this->putJson("/api/admin/orders/{$order->id}/status", ['status' => Order::STATUS_CANCELLED])->assertOk();

        $this->assertDatabaseHas('point_transactions', [
            'order_id' => $order->id,
            'points_delta' => 500,
            'reason' => 'refunded',
        ]);
        $this->assertSame(500, PointTransaction::where('user_id', $user->id)->sum('points_delta'));
    }

    public function test_unknown_reward_keys_are_rejected(): void
    {
        $this->customer();
        $this->postJson('/api/cart/reward', ['reward_key' => 'free-jet'])->assertStatus(422);
    }

    private function user(string $role): User
    {
        return User::factory()->create(['role' => $role]);
    }
}
