# Deployment Guide

## TLS / HTTPS

The server speaks plain HTTP. In production, always place it behind a reverse proxy that terminates TLS — for example nginx, Caddy, or a cloud load balancer. Never expose the plain-HTTP port directly to the internet.

Caddy example (automatic HTTPS):

```
stack.example.com {
  reverse_proxy localhost:3000
}
```

## CORS

Set `CORS_ORIGINS` to a comma-separated list of the origins that need cross-origin access to your stack:

```
CORS_ORIGINS=https://app.example.com,https://admin.example.com
```

The default is empty (no cross-origin access allowed). Set it to `*` only for fully-public, read-only stacks where unauthenticated access is intentional.

Because the stack is designed to be accessed by many different kinds of apps, you may legitimately need a broad allowlist. The key risk to avoid is combining a wildcard origin with endpoints that accept bearer tokens — browsers will not send `Authorization` headers with credentialed cross-origin requests unless the origin is explicitly listed, so a wildcard does not grant unintended authenticated access from arbitrary origins.

## Rate limiting

The server does not implement per-IP rate limiting internally. Add it at the reverse-proxy layer. At minimum:

- A global per-IP request rate to prevent abuse of public endpoints.
- A stricter rate on `POST /tokens` and authentication-adjacent paths to prevent token brute-forcing.

nginx example:

```nginx
limit_req_zone $binary_remote_addr zone=global:10m rate=60r/m;
limit_req_zone $binary_remote_addr zone=tokens:10m rate=5r/m;

server {
  location / {
    limit_req zone=global burst=20 nodelay;
    proxy_pass http://localhost:3000;
  }
  location /tokens {
    limit_req zone=tokens burst=2 nodelay;
    proxy_pass http://localhost:3000;
  }
}
```

## Public endpoints

`GET /.well-known/stack` is intentionally public and unauthenticated. It exposes the owner entity ID, configured timezone, and capability list. This information is required by `@haverstack/adapter-api` to bootstrap a client connection. If your stack is private, ensure the endpoint is only reachable by intended clients (e.g. by network policy) rather than by auth-gating it.
