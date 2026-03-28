# Docker — Full Topology, Per-Service Config, Deployment

## What

Six always-on containers plus one optional. Each service has its own `docker/{service}/` directory with `Dockerfile.dev` and `Dockerfile.prod`. `docker-compose.yml` at the project root reads `.env` — zero hardcoded values.

| Container | Dockerfile / Image | Always | Process |
|---|---|---|---|
| `app` | `docker/app/Dockerfile.{dev,prod}` | Yes | PHP-FPM |
| `nginx` | `docker/nginx/Dockerfile.{dev,prod}` | Yes | Reverse proxy → `app:9000` |
| `worker` | `docker/worker/Dockerfile.{dev,prod}` | Yes | `php artisan horizon` |
| `scheduler` | `docker/scheduler/Dockerfile.{dev,prod}` | Yes | Cron loop — `schedule:run` every 60s |
| `mysql` | Official `mysql:8.x` | Yes | MySQL database |
| `redis` | Official `redis:7-alpine` | Yes | Cache + queue driver |
| `reverb` | `docker/reverb/Dockerfile.{dev,prod}` | Optional | `php artisan reverb:start` |

Directory layout: `docker/{app,nginx,worker,scheduler,reverb}/` for Dockerfiles, `docker/data/{mysql,redis}/` for persistent volumes (gitignored).

Key rules: dev bind-mounts codebase (live reload), prod `COPY`s (immutable). Dev PHP = xdebug + no opcache. Prod PHP = opcache/JIT + no xdebug. Worker always runs Horizon. `.env` never baked into images.

## How

### docker-compose.yml — complete example

```yaml
services:
  app:
    build: { context: ., dockerfile: docker/app/Dockerfile.dev }
    volumes: [".:/var/www/html"]
    depends_on:
      mysql: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      - APP_ENV=${APP_ENV:-local}
      - APP_KEY=${APP_KEY}
      - APP_DEBUG=${APP_DEBUG:-true}
      - DB_HOST=mysql
      - DB_PORT=${DB_PORT:-3306}
      - DB_DATABASE=${DB_DATABASE}
      - DB_USERNAME=${DB_USERNAME}
      - DB_PASSWORD=${DB_PASSWORD}
      - REDIS_HOST=redis
      - REDIS_PORT=${REDIS_PORT:-6379}
      - CACHE_DRIVER=redis
      - QUEUE_CONNECTION=redis
      - LOG_CHANNEL=stderr
    healthcheck:
      test: ["CMD-SHELL", "php-fpm-healthcheck || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
    networks: [app-network]

  nginx:
    build: { context: ., dockerfile: docker/nginx/Dockerfile.dev }
    ports: ["${APP_PORT:-80}:80"]
    volumes: [".:/var/www/html"]
    depends_on:
      app: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/health"]
      interval: 30s
      timeout: 5s
      retries: 3
    networks: [app-network]

  worker:
    build: { context: ., dockerfile: docker/worker/Dockerfile.dev }
    volumes: [".:/var/www/html"]
    depends_on:
      app: { condition: service_healthy }
    environment: &app-env
      - APP_ENV=${APP_ENV:-local}
      - APP_KEY=${APP_KEY}
      - DB_HOST=mysql
      - DB_PORT=${DB_PORT:-3306}
      - DB_DATABASE=${DB_DATABASE}
      - DB_USERNAME=${DB_USERNAME}
      - DB_PASSWORD=${DB_PASSWORD}
      - REDIS_HOST=redis
      - REDIS_PORT=${REDIS_PORT:-6379}
      - CACHE_DRIVER=redis
      - QUEUE_CONNECTION=redis
    command: php artisan horizon
    networks: [app-network]

  scheduler:
    build: { context: ., dockerfile: docker/scheduler/Dockerfile.dev }
    volumes: [".:/var/www/html"]
    depends_on:
      app: { condition: service_healthy }
    environment: *app-env
    command: sh -c "while true; do php artisan schedule:run --verbose --no-interaction; sleep 60; done"
    networks: [app-network]

  mysql:
    image: mysql:${MYSQL_VERSION:-8.0}
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_PASSWORD}
      MYSQL_DATABASE: ${DB_DATABASE}
      MYSQL_USER: ${DB_USERNAME}
      MYSQL_PASSWORD: ${DB_PASSWORD}
    volumes: ["./docker/data/mysql:/var/lib/mysql"]
    ports: ["${DB_FORWARD_PORT:-3306}:3306"]
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-p${DB_PASSWORD}"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks: [app-network]

  redis:
    image: redis:${REDIS_VERSION:-7}-alpine
    volumes: ["./docker/data/redis:/data"]
    ports: ["${REDIS_FORWARD_PORT:-6379}:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3
    networks: [app-network]

  # Uncomment when WebSocket support is needed
  # reverb:
  #   build: { context: ., dockerfile: docker/reverb/Dockerfile.dev }
  #   volumes: [".:/var/www/html"]
  #   depends_on: { app: { condition: service_healthy } }
  #   environment: *app-env
  #   ports: ["${REVERB_PORT:-8080}:${REVERB_PORT:-8080}"]
  #   command: php artisan reverb:start --host=0.0.0.0 --port=${REVERB_PORT:-8080}
  #   networks: [app-network]

networks:
  app-network:
    driver: bridge
```

### App Dockerfile.prod — complete example

```dockerfile
FROM php:8.4-fpm-alpine AS base

RUN apk add --no-cache \
    libpng-dev libjpeg-turbo-dev freetype-dev libzip-dev icu-dev \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install pdo_mysql gd zip intl opcache bcmath pcntl

# Prod PHP: opcache + JIT, no xdebug, errors off, tuned memory
RUN echo "opcache.enable=1\nopcache.jit=1255\nopcache.jit_buffer_size=100M\n\
opcache.memory_consumption=256\nopcache.interned_strings_buffer=16\n\
opcache.max_accelerated_files=20000\nopcache.validate_timestamps=0" \
    > /usr/local/etc/php/conf.d/opcache.ini \
    && echo "display_errors=Off\nmemory_limit=128M\n\
upload_max_filesize=64M\npost_max_size=64M" \
    > /usr/local/etc/php/conf.d/app.ini

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /var/www/html

COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-interaction --prefer-dist --optimize-autoloader

COPY . .
RUN composer dump-autoload --optimize

# Artisan optimize pipeline — cache everything for production
RUN php artisan config:cache \
    && php artisan route:cache \
    && php artisan event:cache \
    && php artisan view:cache

RUN chown -R www-data:www-data storage bootstrap/cache
USER www-data
EXPOSE 9000
CMD ["php-fpm"]
```

**Dev Dockerfile differs:** xdebug instead of opcache, `display_errors=On`, `memory_limit=512M`, no `COPY .` (bind-mounted), no optimize pipeline:

```dockerfile
FROM php:8.4-fpm-alpine
RUN apk add --no-cache \
    libpng-dev libjpeg-turbo-dev freetype-dev libzip-dev icu-dev linux-headers \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install pdo_mysql gd zip intl bcmath pcntl \
    && pecl install xdebug && docker-php-ext-enable xdebug
RUN echo "xdebug.mode=debug,coverage\nxdebug.client_host=host.docker.internal\n\
xdebug.start_with_request=trigger" > /usr/local/etc/php/conf.d/xdebug.ini \
    && echo "display_errors=On\nmemory_limit=512M\n\
upload_max_filesize=64M\npost_max_size=64M" > /usr/local/etc/php/conf.d/app.ini
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /var/www/html
EXPOSE 9000
CMD ["php-fpm"]
```

### nginx.conf — complete example

`docker/nginx/nginx.conf`:

```nginx
server {
    listen 80;
    server_name _;
    root /var/www/html/public;
    index index.php;
    charset utf-8;
    client_max_body_size 64m;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Gzip
    gzip on;
    gzip_comp_level 5;
    gzip_min_length 256;
    gzip_proxied any;
    gzip_vary on;
    gzip_types text/plain text/css text/xml application/json
               application/javascript application/xml text/javascript;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \.php$ {
        fastcgi_pass app:9000;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
        fastcgi_buffer_size 16k;
        fastcgi_buffers 16 16k;
        fastcgi_read_timeout 300;
    }

    location ~ /\.(?!well-known) { deny all; }
    location = /favicon.ico { access_log off; log_not_found off; }
    location = /robots.txt  { access_log off; log_not_found off; }
    error_page 404 /index.php;
}
```

### Supporting services

**Health checks:** nginx checks `/health` (liveness) and `/ready` (readiness) — endpoints defined in `observability.md`. Docker `HEALTHCHECK` gates startup order via `depends_on: condition: service_healthy`.

**Data persistence:** `docker/data/mysql/` and `docker/data/redis/` survive rebuilds. Add `docker/data/` to `.gitignore`.

**Worker:** same base as `app`, entrypoint `php artisan horizon` — auto-scaling, priorities, graceful SIGTERM. **Scheduler:** same base, entrypoint `while true; do php artisan schedule:run --verbose --no-interaction; sleep 60; done` (see `scheduling.md`). **Reverb (optional):** uncomment when WebSockets needed, entrypoint `php artisan reverb:start`, set `BROADCAST_CONNECTION=reverb` (see `queues-jobs.md`).

### CI and deployment

**CI:** `Pint → PHPStan/Larastan → Pest → Build prod image → Push`. Run `composer ci` (see `stack.md`). **Zero-downtime deploy:** build image with commit SHA tag, run `php artisan migrate --force`, swap containers, Horizon drains jobs on SIGTERM, health check passes before traffic routes. **Env vars:** local dev uses `.env` read by docker-compose. Production injects from secrets manager. CI uses pipeline secrets. Never `.env` in images.

## When

| Situation | Action |
|---|---|
| New project | Copy full `docker/` structure and `docker-compose.yml` |
| Adding WebSockets | Uncomment `reverb` service, set `BROADCAST_CONNECTION=reverb` |
| Debugging PHP | Connect IDE to xdebug in dev container (port 9003) |
| Running tests | `docker compose exec app php artisan test --parallel` |
| Running migrations | `docker compose exec app php artisan migrate` |
| Dockerfile changed | `docker compose build --no-cache <service>` |

## Never

- **Never hardcode values in `docker-compose.yml`.** Every port, password, version from `.env` via `${VAR:-default}`.
- **Never bake `.env` into Docker images.** Production injects real env vars from secrets manager.
- **Never run app + worker + scheduler in one container.** Separate containers = independent scaling.
- **Never use bare `queue:work`.** Worker runs `php artisan horizon` always.
- **Never skip data persistence volumes.** Without `docker/data/` mounts, data is lost on rebuild.
- **Never run the optimize pipeline in dev.** Cache commands are prod-only — they prevent live config changes.
- **Never install xdebug in production images.** Significant overhead. Prod uses opcache with JIT.
- **Never expose MySQL/Redis ports publicly.** Forward ports for local dev only. Prod uses internal network.
- **Never skip health checks.** Every service needs `healthcheck` so `depends_on` gates startup correctly.
