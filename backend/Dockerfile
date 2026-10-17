# ---------- Backend: Laravel API (nginx + php-fpm under supervisord) ----------
FROM php:8.4-fpm-alpine

# nginx serves the app; supervisord keeps nginx + php-fpm + the scheduler alive.
RUN apk add --no-cache bash nginx supervisor sqlite sqlite-dev pkgconfig libpq-dev \
    && docker-php-ext-install pdo_sqlite pdo_pgsql

# OPcache + upload limits (image uploads allow up to 5 MB; nginx caps bodies at 10m).
RUN docker-php-ext-install opcache \
    && { \
        echo "opcache.enable=1"; \
        echo "opcache.enable_cli=1"; \
        echo "opcache.memory_consumption=128"; \
        echo "opcache.max_accelerated_files=20000"; \
        echo "opcache.validate_timestamps=0"; \
        echo "expose_php=Off"; \
        echo "session.cookie_httponly=1"; \
        echo "upload_max_filesize=10M"; \
        echo "post_max_size=10M"; \
    } > /usr/local/etc/php/conf.d/app.ini

# Install Composer
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html

# Install PHP dependencies first (better layer caching)
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --prefer-dist --no-interaction

# Copy application code
COPY . .

# Web server + process manager configs
COPY nginx.conf /etc/nginx/http.d/default.conf
COPY supervisord.conf /etc/supervisord.conf
COPY php-fpm-www.conf /usr/local/etc/php-fpm.d/www.conf

# Finish autoloader, ensure storage permissions
RUN composer dump-autoload --optimize \
    && chown -R www-data:www-data storage bootstrap/cache database \
    && chmod -R 775 storage bootstrap/cache database

# Startup script: prepare env/db, migrate, then hand off to supervisord
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["docker-entrypoint.sh"]
