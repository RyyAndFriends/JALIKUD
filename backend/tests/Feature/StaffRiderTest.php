<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\MenuItem;
use App\Models\Order;
use App\Models\OrderStatusHistory;
use App\Models\RiderProfile;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Staff and rider access to the order pipeline.
 *
 * Staff (and admins) operate the queue under /api/admin/* via EnsureStaff;
 * riders work their own queue under /api/rider/*. Customers stay confined to
 * their own orders on both surfaces.
 */
class StaffRiderTest extends TestCase
{
    use RefreshDatabase;

    private function user(string $role): User
    {
        return User::factory()->create(['role' => $role]);
    }

    private function order(array $overrides = []): Order
    {
        return Order::create(array_merge([
            'order_number' => 'ORD-'.strtoupper(Str::random(8)),
            'user_id' => $this->user(User::ROLE_CUSTOMER)->id,
            'order_type' => 'delivery',
            'status' => Order::STATUS_PENDING,
            'payment_method' => 'cod',
            'payment_status' => Order::PAYMENT_UNPAID,
            'subtotal' => 100,
            'total_amount' => 100,
        ], $overrides));
    }

    private function readyRider(): User
    {
        $rider = $this->user(User::ROLE_RIDER);
        RiderProfile::create([
            'user_id' => $rider->id,
            'vehicle_type' => 'motorcycle',
            'plate_number' => 'XYZ-9999',
            'is_active' => true,
            'delivery_ready_at' => now(),
        ]);

        return $rider;
    }

    private function menuItem(): MenuItem
    {
        $category = Category::create(['name' => 'Mains', 'slug' => 'mains-'.Str::random(6)]);

        return MenuItem::create([
            'category_id' => $category->id,
            'name' => 'Chicken Adobo',
            'slug' => 'adobo-'.Str::random(6),
            'base_price' => 100,
            'is_available' => true,
        ]);
    }

    public function test_staff_sees_all_orders_while_customers_see_only_their_own(): void
    {
        $mine = $this->order();
        $theirs = $this->order();

        Sanctum::actingAs($this->user(User::ROLE_STAFF));
        $this->getJson('/api/admin/orders?per_page=100')->assertOk()->assertJsonCount(2, 'data');

        Sanctum::actingAs(User::find($mine->user_id));
        $response = $this->getJson('/api/orders?per_page=100')->assertOk();
        $response->assertJsonCount(1, 'data');
        $response->assertJsonPath('data.0.id', $mine->id);
        $this->assertNotContains($theirs->id, collect($response->json('data'))->pluck('id')->all());
    }

    public function test_staff_can_update_status_but_customers_and_riders_cannot(): void
    {
        $order = $this->order();

        Sanctum::actingAs($this->user(User::ROLE_STAFF));
        $this->putJson("/api/admin/orders/{$order->id}/status", ['status' => Order::STATUS_CONFIRMED])
            ->assertOk();
        $this->assertSame(Order::STATUS_CONFIRMED, $order->fresh()->status);

        Sanctum::actingAs($this->user(User::ROLE_CUSTOMER));
        $this->putJson("/api/admin/orders/{$order->id}/status", ['status' => Order::STATUS_PREPARING])
            ->assertStatus(403);

        Sanctum::actingAs($this->user(User::ROLE_RIDER));
        $this->putJson("/api/admin/orders/{$order->id}/status", ['status' => Order::STATUS_PREPARING])
            ->assertStatus(403);
    }

    public function test_staff_activity_lists_only_their_status_changes_newest_first(): void
    {
        $staff = $this->user(User::ROLE_STAFF);
        $otherStaff = $this->user(User::ROLE_STAFF);
        $olderOrder = $this->order();
        $newerOrder = $this->order();
        $otherOrder = $this->order();

        OrderStatusHistory::create([
            'order_id' => $olderOrder->id,
            'status' => Order::STATUS_CONFIRMED,
            'changed_by' => $staff->id,
            'note' => 'Confirmed first.',
        ])->forceFill(['created_at' => now()->subMinute()])->save();
        OrderStatusHistory::create([
            'order_id' => $newerOrder->id,
            'status' => Order::STATUS_CANCELLED,
            'changed_by' => $staff->id,
            'note' => 'Cancelled second.',
        ])->forceFill(['created_at' => now()])->save();
        OrderStatusHistory::create([
            'order_id' => $otherOrder->id,
            'status' => Order::STATUS_CONFIRMED,
            'changed_by' => $otherStaff->id,
        ]);

        Sanctum::actingAs($staff);
        $response = $this->getJson('/api/admin/activity?per_page=10')->assertOk();

        $response->assertJsonCount(2, 'data');
        $response->assertJsonPath('data.0.order.order_number', $newerOrder->order_number);
        $response->assertJsonPath('data.0.actor.name', $staff->name);
        $response->assertJsonPath('data.1.order.order_number', $olderOrder->order_number);
        $response->assertJsonPath('meta.total', 2);
    }

    public function test_staff_activity_rejects_non_staff_roles(): void
    {
        Sanctum::actingAs($this->user(User::ROLE_CUSTOMER));
        $this->getJson('/api/admin/activity')->assertStatus(403);

        Sanctum::actingAs($this->user(User::ROLE_RIDER));
        $this->getJson('/api/admin/activity')->assertStatus(403);

        Sanctum::actingAs($this->user(User::ROLE_ADMIN));
        $this->getJson('/api/admin/activity')->assertOk();
    }

    public function test_staff_gate_keeps_user_admin_but_opens_menu_availability(): void
    {
        Sanctum::actingAs($this->user(User::ROLE_STAFF));
        $this->getJson('/api/admin/users')->assertStatus(403);

        $item = $this->menuItem();
        $this->putJson("/api/admin/menu-items/{$item->id}", ['is_available' => false])->assertOk();
        $this->assertFalse($item->fresh()->is_available);

        $this->deleteJson("/api/admin/menu-items/{$item->id}")->assertStatus(403);

        Sanctum::actingAs($this->user(User::ROLE_CUSTOMER));
        $this->putJson("/api/admin/menu-items/{$item->id}", ['is_available' => true])->assertStatus(403);
    }

    public function test_ready_delivery_order_auto_assigns_the_next_queued_rider(): void
    {
        $rider = $this->readyRider();
        $order = $this->order(['status' => Order::STATUS_PREPARING]);
        Sanctum::actingAs($this->user(User::ROLE_STAFF));

        $this->putJson("/api/admin/orders/{$order->id}/status", ['status' => Order::STATUS_READY])
            ->assertOk()
            ->assertJsonPath('data.rider_id', $rider->id);

        $this->assertSame($rider->id, $order->fresh()->rider_id);
        $this->assertNotNull($order->fresh()->assigned_at);
    }

    public function test_pickup_orders_are_never_auto_assigned(): void
    {
        $this->readyRider();
        $order = $this->order(['order_type' => 'pickup', 'status' => Order::STATUS_PREPARING]);
        Sanctum::actingAs($this->user(User::ROLE_STAFF));

        $this->putJson("/api/admin/orders/{$order->id}/status", ['status' => Order::STATUS_READY])
            ->assertOk();

        $this->assertNull($order->fresh()->rider_id);
    }

    public function test_rider_joining_the_queue_receives_a_waiting_ready_order(): void
    {
        $order = $this->order(['status' => Order::STATUS_READY]);
        $rider = $this->user(User::ROLE_RIDER);
        RiderProfile::create(['user_id' => $rider->id, 'is_active' => true]);
        Sanctum::actingAs($rider);

        $this->putJson('/api/rider/readiness', ['ready' => true])
            ->assertOk()
            ->assertJsonPath('data.availability_status', 'on_delivery');

        $this->assertSame($rider->id, $order->fresh()->rider_id);
    }

    public function test_rider_must_clock_in_before_joining_the_queue(): void
    {
        $rider = $this->user(User::ROLE_RIDER);
        Sanctum::actingAs($rider);

        $this->putJson('/api/rider/readiness', ['ready' => true])
            ->assertStatus(422);
    }

    public function test_auto_assignment_respects_queue_order(): void
    {
        $first = $this->user(User::ROLE_RIDER);
        RiderProfile::create(['user_id' => $first->id, 'is_active' => true, 'delivery_ready_at' => now()->subMinutes(5)]);

        $second = $this->user(User::ROLE_RIDER);
        RiderProfile::create(['user_id' => $second->id, 'is_active' => true, 'delivery_ready_at' => now()->subMinute()]);

        $order = $this->order(['status' => Order::STATUS_PREPARING]);
        Sanctum::actingAs($this->user(User::ROLE_STAFF));

        $this->putJson("/api/admin/orders/{$order->id}/status", ['status' => Order::STATUS_READY])->assertOk();
        $this->assertSame($first->id, $order->fresh()->rider_id);

        // The next ready order goes to the second rider (the first is now busy).
        $next = $this->order(['status' => Order::STATUS_PREPARING]);
        $this->putJson("/api/admin/orders/{$next->id}/status", ['status' => Order::STATUS_READY])->assertOk();
        $this->assertSame($second->id, $next->fresh()->rider_id);
    }

    public function test_auto_assignment_skips_a_rider_already_on_delivery(): void
    {
        $busy = $this->readyRider();
        $this->order(['rider_id' => $busy->id, 'status' => Order::STATUS_OUT_FOR_DELIVERY]);

        $free = $this->readyRider();

        $order = $this->order(['status' => Order::STATUS_PREPARING]);
        Sanctum::actingAs($this->user(User::ROLE_STAFF));

        $this->putJson("/api/admin/orders/{$order->id}/status", ['status' => Order::STATUS_READY])->assertOk();

        $this->assertSame($free->id, $order->fresh()->rider_id);
    }

    public function test_rider_cannot_pause_with_an_active_delivery(): void
    {
        $rider = $this->readyRider();
        $this->order(['rider_id' => $rider->id, 'status' => Order::STATUS_READY]);
        Sanctum::actingAs($rider);

        $this->putJson('/api/rider/readiness', ['ready' => false])->assertStatus(422);
    }

    public function test_rider_checks_in_with_the_daily_duty_code(): void
    {
        $rider = $this->user(User::ROLE_RIDER);
        Sanctum::actingAs($rider);

        $this->putJson('/api/rider/availability', ['is_available' => false])->assertOk();
        $this->assertFalse($rider->fresh()->riderProfile->is_active);

        $this->putJson('/api/rider/availability', ['is_available' => true])->assertStatus(422);

        // Staff generate the day's duty code, then a rider scans it to clock in.
        Sanctum::actingAs($this->user(User::ROLE_STAFF));
        $code = $this->getJson('/api/admin/duty-code')->assertOk()->json('data.code');
        $this->assertIsString($code);

        Sanctum::actingAs($rider);
        $this->postJson('/api/rider/duty/check-in', ['code' => $code])
            ->assertOk()
            ->assertJsonPath('data.is_active', true)
            ->assertJsonPath('data.availability_status', 'not_available');
        $this->assertTrue($rider->fresh()->riderProfile->is_active);
        $this->assertNotNull($rider->fresh()->riderProfile->duty_checked_in_at);

        // Clocked in but not yet in the queue: the rider must declare ready.
        $this->putJson('/api/rider/readiness', ['ready' => true])
            ->assertOk()
            ->assertJsonPath('data.availability_status', 'available');
        $this->assertNotNull($rider->fresh()->riderProfile->delivery_ready_at);

        // A forged code is rejected and leaves the rider off duty.
        $other = $this->user(User::ROLE_RIDER);
        RiderProfile::create(['user_id' => $other->id, 'is_active' => false]);
        Sanctum::actingAs($other);
        $this->postJson('/api/rider/duty/check-in', ['code' => 'forged-code'])->assertStatus(422);
        $this->assertFalse($other->fresh()->riderProfile->is_active);

        // Customers cannot clock riders in.
        Sanctum::actingAs($this->user(User::ROLE_CUSTOMER));
        $this->postJson('/api/rider/duty/check-in', ['code' => $code])->assertStatus(403);
    }

    public function test_riders_directory_lists_only_riders(): void
    {
        $rider = $this->user(User::ROLE_RIDER);
        $this->user(User::ROLE_CUSTOMER);

        Sanctum::actingAs($this->user(User::ROLE_STAFF));
        $response = $this->getJson('/api/admin/riders?per_page=100')->assertOk();
        $ids = collect($response->json('data'))->pluck('id')->all();
        $this->assertContains($rider->id, $ids);
        $this->assertCount(1, $ids);

        Sanctum::actingAs($this->user(User::ROLE_CUSTOMER));
        $this->getJson('/api/admin/riders')->assertStatus(403);
    }

    public function test_rider_sees_only_their_assigned_deliveries(): void
    {
        $rider = $this->user(User::ROLE_RIDER);
        $other = $this->user(User::ROLE_RIDER);
        $mine = $this->order(['rider_id' => $rider->id, 'status' => Order::STATUS_READY]);
        $this->order(['rider_id' => $other->id, 'status' => Order::STATUS_READY]);
        $this->order(['status' => Order::STATUS_READY]);

        Sanctum::actingAs($rider);
        $response = $this->getJson('/api/rider/deliveries?per_page=100')->assertOk();
        $response->assertJsonCount(1, 'data');
        $response->assertJsonPath('data.0.id', $mine->id);

        $this->getJson("/api/rider/deliveries/{$mine->id}")->assertOk();

        Sanctum::actingAs($other);
        $this->getJson("/api/rider/deliveries/{$mine->id}")->assertStatus(404);

        Sanctum::actingAs($this->user(User::ROLE_CUSTOMER));
        $this->getJson('/api/rider/deliveries')->assertStatus(403);
    }

    public function test_rider_advances_only_the_delivery_leg(): void
    {
        $rider = $this->user(User::ROLE_RIDER);
        $order = $this->order(['rider_id' => $rider->id, 'status' => Order::STATUS_READY]);
        Sanctum::actingAs($rider);

        $this->putJson("/api/rider/deliveries/{$order->id}/status", ['status' => Order::STATUS_OUT_FOR_DELIVERY])
            ->assertOk();
        $this->putJson('/api/rider/availability', ['is_available' => false])->assertStatus(422);

        Storage::fake('public');
        $this->post("/api/rider/deliveries/{$order->id}/complete", [
            'image' => UploadedFile::fake()->image('proof.jpg', 640, 480),
        ])->assertOk()
            ->assertJsonPath('data.status', Order::STATUS_COMPLETED)
            ->assertJsonPath('data.payment_status', Order::PAYMENT_PAID);

        $this->assertSame(Order::STATUS_COMPLETED, $order->fresh()->status);
        $this->assertSame(Order::PAYMENT_PAID, $order->fresh()->payment_status);
        $this->assertSame(2, $order->statusHistory()->count());
        $this->assertDatabaseHas('payments', [
            'order_id' => $order->id,
            'provider' => 'cod',
            'status' => 'succeeded',
        ]);
    }

    public function test_complete_delivery_requires_a_camera_image(): void
    {
        Storage::fake('public');
        $rider = $this->user(User::ROLE_RIDER);
        $order = $this->order(['rider_id' => $rider->id, 'status' => Order::STATUS_OUT_FOR_DELIVERY]);
        Sanctum::actingAs($rider);

        // No image: completion is refused and nothing is stored.
        $this->post("/api/rider/deliveries/{$order->id}/complete")->assertStatus(422);
        $this->assertNull($order->fresh()->delivery_proof_path);
        $this->assertSame(Order::STATUS_OUT_FOR_DELIVERY, $order->fresh()->status);

        // A foreign rider cannot complete someone else's order.
        Sanctum::actingAs($this->user(User::ROLE_RIDER));
        $this->post("/api/rider/deliveries/{$order->id}/complete", [
            'image' => UploadedFile::fake()->image('foreign-proof.jpg', 640, 480),
        ])->assertNotFound();

        // The assigned rider completes with the camera shot, atomically.
        Sanctum::actingAs($rider);
        $this->post("/api/rider/deliveries/{$order->id}/complete", [
            'image' => UploadedFile::fake()->image('proof.jpg', 640, 480),
        ])->assertOk();

        $fresh = $order->fresh();
        $this->assertNotNull($fresh->delivery_proof_path);
        Storage::disk('public')->assertExists($fresh->delivery_proof_path);
        $this->assertSame(Order::STATUS_COMPLETED, $fresh->status);
    }

    public function test_staff_cannot_complete_the_delivery_leg(): void
    {
        $order = $this->order(['status' => Order::STATUS_READY]);
        Sanctum::actingAs($this->user(User::ROLE_STAFF));

        $this->putJson("/api/admin/orders/{$order->id}/status", ['status' => Order::STATUS_OUT_FOR_DELIVERY])
            ->assertStatus(422);
        $this->assertSame(Order::STATUS_READY, $order->fresh()->status);
    }

    public function test_rider_completion_requires_confirmed_gcash_payment(): void
    {
        $rider = $this->user(User::ROLE_RIDER);
        $order = $this->order([
            'rider_id' => $rider->id,
            'status' => Order::STATUS_OUT_FOR_DELIVERY,
            'payment_method' => 'gcash',
            'payment_status' => Order::PAYMENT_UNPAID,
        ]);
        Sanctum::actingAs($rider);

        Storage::fake('public');
        $this->post("/api/rider/deliveries/{$order->id}/complete", [
            'image' => UploadedFile::fake()->image('proof.jpg', 640, 480),
        ])->assertStatus(422);
        $this->assertSame(Order::STATUS_OUT_FOR_DELIVERY, $order->fresh()->status);

        $order->update(['payment_status' => Order::PAYMENT_PAID]);
        $this->post("/api/rider/deliveries/{$order->id}/complete", [
            'image' => UploadedFile::fake()->image('proof.jpg', 640, 480),
        ])->assertOk();
        $this->assertDatabaseMissing('payments', ['order_id' => $order->id, 'provider' => 'cod']);
    }

    public function test_rider_cannot_touch_kitchen_states_or_foreign_orders(): void
    {
        $rider = $this->user(User::ROLE_RIDER);
        $kitchen = $this->order(['rider_id' => $rider->id, 'status' => Order::STATUS_PENDING]);
        $foreign = $this->order(['status' => Order::STATUS_READY]);
        Sanctum::actingAs($rider);

        $this->putJson("/api/rider/deliveries/{$kitchen->id}/status", ['status' => Order::STATUS_OUT_FOR_DELIVERY])
            ->assertStatus(422);

        $this->putJson("/api/rider/deliveries/{$foreign->id}/status", ['status' => Order::STATUS_OUT_FOR_DELIVERY])
            ->assertStatus(404);
    }

    public function test_auto_clock_out_resets_every_rider_still_on_duty(): void
    {
        $active = $this->user(User::ROLE_RIDER);
        $activeProfile = RiderProfile::create([
            'user_id' => $active->id,
            'is_active' => true,
            'duty_checked_in_at' => now(),
        ]);

        $off = $this->user(User::ROLE_RIDER);
        RiderProfile::create(['user_id' => $off->id, 'is_active' => false]);

        $this->artisan('riders:auto-clock-out')->assertSuccessful();

        $this->assertFalse($activeProfile->fresh()->is_active);
        $this->assertNull($activeProfile->fresh()->duty_checked_in_at);
        $this->assertFalse($off->fresh()->riderProfile->is_active);
    }

    public function test_admin_keeps_full_access(): void
    {
        $admin = $this->user(User::ROLE_ADMIN);
        $order = $this->order();
        Sanctum::actingAs($admin);

        $this->getJson('/api/admin/orders?per_page=100')->assertOk();
        $this->putJson("/api/admin/orders/{$order->id}/status", ['status' => Order::STATUS_CONFIRMED])->assertOk();
        $this->getJson('/api/admin/riders')->assertOk();
    }
}
