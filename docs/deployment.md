# Deployment Guide

The server speaks plain HTTP. In production, always place it behind a reverse proxy that handles TLS termination and rate limiting. Never expose the plain-HTTP port directly to the internet.

- [Caddy](#caddy) — simplest; automatic HTTPS, minimal config
- [nginx](#nginx) — most common; full control over headers and limits
- [Traefik](#traefik) — best for Docker; auto-discovers containers

---

## Caddy

Caddy obtains and renews TLS certificates automatically via Let's Encrypt.

```
stack.example.com {
    reverse_proxy localhost:3000
}
```

**Rate limiting** is not built into the standard Caddy binary. Options:

- Build Caddy with the [`caddy-ratelimit`](https://github.com/mholt/caddy-ratelimit) community module via [caddyserver.com/download](https://caddyserver.com/download).
- Use a CDN or WAF (e.g. Cloudflare) in front of Caddy for IP-based limiting.

---

## nginx

Obtain a certificate first with [Certbot](https://certbot.eff.org/), then use this configuration. The `limit_req_zone` directives must live in the `http` block (typically `/etc/nginx/nginx.conf` or a file included from it); the `server` block below goes in `/etc/nginx/sites-available/haverstack`.

```nginx
# In the http block:
limit_req_zone $binary_remote_addr zone=hs_global:10m rate=60r/m;
limit_req_zone $binary_remote_addr zone=hs_tokens:10m rate=5r/m;
```

```nginx
# /etc/nginx/sites-available/haverstack
server {
    listen 80;
    server_name stack.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name stack.example.com;

    ssl_certificate     /etc/letsencrypt/live/stack.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/stack.example.com/privkey.pem;

    location / {
        limit_req zone=hs_global burst=20 nodelay;

        proxy_pass http://localhost:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Tighter limit on token issuance to slow brute-force attempts.
    location = /tokens {
        limit_req zone=hs_tokens burst=2 nodelay;

        proxy_pass http://localhost:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Traefik

Traefik is a good fit when you're already running Docker. It discovers the server container automatically via labels and handles Let's Encrypt itself.

Create a `docker-compose.yml`:

```yaml
services:
  traefik:
    image: traefik:v3
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.email=you@example.com
      - --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - letsencrypt:/letsencrypt

  server:
    image: ghcr.io/haverstack/server:latest
    environment:
      OWNER_TOKEN: ${OWNER_TOKEN}
      ENTITY_ID: ${ENTITY_ID}    # only needed on first run
    volumes:
      - data:/app/data
    labels:
      - traefik.enable=true
      - traefik.http.routers.haverstack.rule=Host(`stack.example.com`)
      - traefik.http.routers.haverstack.entrypoints=websecure
      - traefik.http.routers.haverstack.tls.certresolver=letsencrypt
      # Rate limit: 60 req/min per IP, burst of 20
      - traefik.http.middlewares.haverstack-rl.ratelimit.average=60
      - traefik.http.middlewares.haverstack-rl.ratelimit.period=1m
      - traefik.http.middlewares.haverstack-rl.ratelimit.burst=20
      - traefik.http.routers.haverstack.middlewares=haverstack-rl

volumes:
  data:
  letsencrypt:
```

Start with:

```sh
docker compose up -d
```

---

## CORS

Set `CORS_ORIGINS` to a comma-separated list of the origins that need cross-origin access to your stack:

```
CORS_ORIGINS=https://app.example.com,https://admin.example.com
```

The default is empty (no cross-origin access allowed). Set it to `*` only for fully-public, read-only stacks where unauthenticated access is intentional.

Because the stack is designed to be accessed by many different kinds of apps, you may legitimately need a broad allowlist. The key risk to avoid is combining a wildcard origin with endpoints that accept bearer tokens — browsers will not send `Authorization` headers with credentialed cross-origin requests unless the origin is explicitly listed, so a wildcard does not grant unintended authenticated access from arbitrary origins.

## Public endpoints

`GET /.well-known/stack` is intentionally public and unauthenticated. It exposes the owner entity ID, configured timezone, and capability list. This information is required by `@haverstack/adapter-api` to bootstrap a client connection. If your stack is private, ensure the endpoint is only reachable by intended clients (e.g. by network policy) rather than by auth-gating it.
