<?php

use App\Http\Controllers\AddressController;
use App\Http\Controllers\AdminRewardController;
use App\Http\Controllers\AdminStatsController;
use App\Http\Controllers\AdminUserController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\CartController;
use App\Http\Controllers\CategoryController;
use App\Http\Controllers\ChatController;
use App\Http\Controllers\CouponController;
use App\Http\Controllers\MenuItemController;
use App\Http\Controllers\OrderController;
use App\Http\Controllers\PaymentController;
use App\Http\Controllers\ReviewController;
use App\Http\Controllers\RewardController;
use App\Http\Controllers\RiderController;
use App\Http\Controllers\RiderDeliveryController;
use App\Http\Controllers\StoreSettingController;
use App\Http\Controllers\UploadController;
use App\Http\Controllers\VariantGroupController;
use App\Http\Controllers\VariantOptionController;
use App\Http\Middleware\EnsureAdmin;
use App\Http\Middleware\EnsureRider;
use App\Http\Middleware\EnsureStaff;
use Illuminate\Support\Facades\Route;

// Public authentication endpoints (rate limited to slow down brute force)
Route::post('/register', [AuthController::class, 'register'])->middleware('throttle:5,1');
Route::post('/login', [AuthController::class, 'login'])->middleware('throttle:5,1');

// Protected endpoints (require Sanctum token)
Route::middleware('auth:sanctum')->group(function () {
    Route::get('/user', [AuthController::class, 'user']);
    Route::put('/profile', [AuthController::class, 'updateProfile']);
    Route::put('/password', [AuthController::class, 'updatePassword'])->middleware('throttle:password');
    Route::post('/logout', [AuthController::class, 'logout']);

    // Addresses (customer). Required for delivery checkout: POST /orders
    // demands an address_id owned by the caller when order_type=delivery, so
    // without these routes a customer who registered through the public API
    // could only ever check out for pickup.
    Route::get('/addresses', [AddressController::class, 'index']);
    Route::post('/addresses', [AddressController::class, 'store']);
    Route::match(['put', 'patch'], '/addresses/{address}', [AddressController::class, 'update']);
    Route::delete('/addresses/{address}', [AddressController::class, 'destroy']);

    // Cart (customer)
    Route::get('/cart', [CartController::class, 'index']);
    Route::match(['put', 'patch'], '/cart', [CartController::class, 'update']);
    Route::post('/cart/items', [CartController::class, 'addItem']);
    Route::put('/cart/items/{cart}/{cartItem}', [CartController::class, 'updateItem']);
    Route::delete('/cart/items/{cart}/{cartItem}', [CartController::class, 'removeItem']);
    Route::delete('/cart', [CartController::class, 'destroy']);
    Route::post('/cart/coupon', [CartController::class, 'applyCoupon'])->middleware('throttle:coupons');
    Route::delete('/cart/coupon', [CartController::class, 'removeCoupon']);
    Route::post('/cart/reward', [CartController::class, 'applyReward']);
    Route::delete('/cart/reward', [CartController::class, 'removeReward']);

    // Loyalty (customer)
    Route::get('/rewards', [RewardController::class, 'index']);
    Route::get('/points', [RewardController::class, 'points']);

    // Chat assistant (customer)
    Route::post('/chat', [ChatController::class, 'store'])->middleware('throttle:chat');
    Route::post('/chat/stream', [ChatController::class, 'stream'])->middleware('throttle:chat');

    // Orders (customer)
    Route::get('/orders', [OrderController::class, 'index']);
    Route::get('/orders/{order}', [OrderController::class, 'show']);
    Route::post('/orders', [OrderController::class, 'store'])->middleware('throttle:orders');
    Route::post('/orders/{order}/cancel', [OrderController::class, 'cancel']);
    Route::post('/orders/{order}/review', [ReviewController::class, 'store']);

    // Rider operations (rider role only): own delivery queue.
    Route::middleware(EnsureRider::class)
        ->prefix('rider')
        ->group(function () {
            Route::get('/deliveries', [RiderDeliveryController::class, 'index']);
            Route::get('/deliveries/{order}', [RiderDeliveryController::class, 'show']);
            Route::put('/deliveries/{order}/status', [RiderDeliveryController::class, 'updateStatus']);
            Route::put('/availability', [RiderDeliveryController::class, 'updateAvailability']);
            Route::post('/duty/check-in', [RiderDeliveryController::class, 'checkIn']);
            Route::post('/deliveries/{order}/proof', [RiderDeliveryController::class, 'storeProof']);
            Route::get('/profile', [RiderDeliveryController::class, 'showProfile']);
            Route::put('/profile', [RiderDeliveryController::class, 'updateProfile']);
        });

    // Staff order operations (staff + admin). User/catalog/coupon/store
    // administration stays admin-only below.
    Route::middleware(EnsureStaff::class)
        ->prefix('admin')
        ->group(function () {
            Route::get('/activity', [OrderController::class, 'activity']);
            Route::get('/orders', [OrderController::class, 'index']);
            Route::get('/orders/{order}', [OrderController::class, 'show']);
            Route::put('/orders/{order}/status', [OrderController::class, 'updateStatus']);
            Route::put('/orders/{order}/rider', [OrderController::class, 'assignRider']);
            Route::get('/riders', [RiderController::class, 'index']);
            Route::get('/duty-code', [RiderController::class, 'dutyCode']);
            Route::match(['put', 'patch'], '/menu-items/{menuItem}', [MenuItemController::class, 'update']);
            Route::get('/orders/{order}/payments', [PaymentController::class, 'index']);
        });

    // Admin-only: all routes under /admin/*
    Route::middleware(EnsureAdmin::class)
        ->prefix('admin')
        ->group(function () {
            Route::get('/users', [AdminUserController::class, 'index']);
            Route::post('/users', [AdminUserController::class, 'store']);
            Route::get('/users/{user}', [AdminUserController::class, 'show']);
            Route::match(['put', 'patch'], '/users/{user}', [AdminUserController::class, 'update']);
            Route::delete('/users/{user}', [AdminUserController::class, 'destroy']);

            // Catalog management
            Route::apiResource('categories', CategoryController::class)->only(['store', 'update', 'destroy']);
            Route::apiResource('menu-items', MenuItemController::class)->only(['store', 'destroy']);
            Route::apiResource('coupons', CouponController::class)->except(['create', 'edit']);
            Route::put('/store-setting', [StoreSettingController::class, 'update']);

            // Variant group / option management
            Route::get('/menu-items/{menuItem}/variant-groups', [VariantGroupController::class, 'index']);
            Route::post('/menu-items/{menuItem}/variant-groups', [VariantGroupController::class, 'store']);
            Route::match(['put', 'patch'], '/variant-groups/{variantGroup}', [VariantGroupController::class, 'update']);
            Route::delete('/variant-groups/{variantGroup}', [VariantGroupController::class, 'destroy']);
            Route::post('/variant-groups/{variantGroup}/options', [VariantOptionController::class, 'store']);
            Route::match(['put', 'patch'], '/variant-options/{variantOption}', [VariantOptionController::class, 'update']);
            Route::delete('/variant-options/{variantOption}', [VariantOptionController::class, 'destroy']);

            // Reviews moderation
            Route::get('/reviews', [ReviewController::class, 'adminIndex']);
            Route::delete('/reviews/{review}', [ReviewController::class, 'destroy']);

            // Rider profile administration
            Route::match(['put', 'patch'], '/riders/{user}/profile', [RiderController::class, 'updateProfile']);

            // Dashboard stats
            Route::get('/stats', [AdminStatsController::class, 'index']);
            Route::get('/overview', [AdminStatsController::class, 'overview']);
            Route::get('/overview/revenue', [AdminStatsController::class, 'revenueSeries']);

            // File uploads
            Route::post('/uploads/image', [UploadController::class, 'storeImage']);
            Route::post('/uploads/document', [UploadController::class, 'storeDocument']);

            // Coupon redemption history
            Route::get('/coupons/{coupon}/redemptions', [CouponController::class, 'redemptions']);

            // Loyalty rewards (catalogue CRUD + ledger)
            Route::get('/rewards', [AdminRewardController::class, 'index']);
            Route::post('/rewards', [AdminRewardController::class, 'store']);
            Route::get('/rewards/redemptions', [AdminRewardController::class, 'redemptions']);
            Route::match(['put', 'patch'], '/rewards/{reward}', [AdminRewardController::class, 'update']);
            Route::delete('/rewards/{reward}', [AdminRewardController::class, 'destroy']);
            Route::get('/points', [AdminRewardController::class, 'points']);
        });

});

// Public: catalog browsing (no auth required)
Route::get('/store-setting', [StoreSettingController::class, 'show']);
Route::get('/menu', [MenuItemController::class, 'index']);
Route::get('/menu/{menuItem}', [MenuItemController::class, 'show']);
Route::get('/menu/{menuItem}/reviews', [ReviewController::class, 'menuItemReviews']);
Route::get('/categories', [CategoryController::class, 'index']);
Route::get('/categories/{category}', [CategoryController::class, 'show']);
