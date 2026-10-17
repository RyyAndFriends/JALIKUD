#!/bin/sh
set -e

cd /var/www/html

# Ensure .env exists
if [ ! -f .env ]; then
    cp .env.example .env
fi

# Persist runtime settings into .env because php-fpm workers
# do not reliably inherit container environment variables.
# This must run BEFORE the key check below so an injected APP_KEY is
# written into .env and key:generate is skipped.
for var in APP_KEY APP_ENV APP_DEBUG APP_URL LOG_LEVEL TRUSTED_PROXIES DB_CONNECTION DB_HOST DB_PORT DB_DATABASE DB_USERNAME DB_PASSWORD AI_API_KEY AI_BASE_URL AI_MODEL AI_TIMEOUT; do
    # `|| true` matters: printenv exits non-zero for unset vars and `set -e`
    # would abort the container before it ever reaches migrate/serve.
    value=$(printenv "$var" 2>/dev/null || true)
    if [ -n "$value" ]; then
        sed -i "s#^$var=.*#$var=$value#" .env
    fi
done

# Generate APP_KEY only when it is genuinely missing (not injected, not in .env).
# Laravel 13 builds key:generate's replacement pattern from the already-loaded
# config('app.key'), so running it while APP_KEY exists in the environment
# aborts with "Unable to set application key. APP_KEY is already present".
if [ -z "$APP_KEY" ] && ! grep -q "^APP_KEY=base64" .env; then
    php artisan key:generate --force
fi

# Never let debug mode leak into production, even if .env was built wrong
if grep -q "^APP_ENV=production" .env; then
    sed -i "s#^APP_DEBUG=.*#APP_DEBUG=false#" .env
fi

# Ensure SQLite database file exists when running on SQLite, then migrate
if grep -q "^DB_CONNECTION=sqlite" .env || [ "${DB_CONNECTION:-}" = "sqlite" ]; then
    touch database/database.sqlite
    chown www-data:www-data database/database.sqlite
fi

# Serve uploaded files: public/storage -> storage/app/public
php artisan storage:link || true

php artisan migrate --force

# In production, cache config/routes for performance. Cache files are written
# into bootstrap/cache; the app is rebuilt per image so stale caches are not
# a concern across deployments.
if grep -q "^APP_ENV=production" .env; then
    php artisan config:cache
    php artisan route:cache
    php artisan view:cache || true
else
    php artisan config:clear >/dev/null 2>&1 || true
    php artisan route:clear >/dev/null 2>&1 || true
fi

# Hand off to supervisord, which runs nginx (web), php-fpm (PHP workers) and
# the scheduler (riders:auto-clock-out), restarting any that crash.
exec /usr/bin/supervisord -c /etc/supervisord.conf
