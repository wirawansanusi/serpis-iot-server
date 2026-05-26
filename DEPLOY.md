# Deploying humid-server

Production setup: **Bitbucket Pipelines → GHCR → Docker on the existing VPS,
reverse-proxied by the shared Caddy** (same box as serpis). Mirrors the
mbook/serpis pattern.

- `Dockerfile` / `.dockerignore` — slim Next.js standalone image.
- `bitbucket-pipelines.yml` — build, push to GHCR, SSH-deploy on push to `main`.
- `deploy/` — files that live **on the server** under `/opt/humid-server`.

## 1. One-time server setup (on the VPS)

```bash
sudo mkdir -p /opt/humid-server && cd /opt/humid-server
# copy deploy/docker-compose.yml here, then:
cp /path/to/deploy/.env.server.example .env   # fill in the real secrets
```

- **Set the Caddy network** in `docker-compose.yml` (`networks.web.name`) to the
  network serpis's Caddy is attached to:
  `docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' <caddy-container>`
- **GHCR auth**: the box already pulls `ghcr.io/wirawansanusi/*` for serpis, so
  it's authenticated. If not: `docker login ghcr.io -u wirawansanusi` (PAT).
- **Caddy site block**: append `deploy/Caddyfile.snippet` (set the real hostname)
  to the serpis Caddyfile and reload Caddy.
- **DNS**: point `humid.<domain>` (A/AAAA) at the VPS so Caddy can issue a cert.

## 2. Bitbucket setup

- Push this repo to Bitbucket; enable **Pipelines**.
- **Repository variables** (Settings → Repository variables; secure the secrets):
  `GHCR_USERNAME`, `GHCR_TOKEN` (GitHub PAT: `write:packages`,`read:packages`),
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `VPS_HOST`, `VPS_USER`.
- **SSH**: add a deploy key under Settings → SSH keys, put its public key in the
  VPS deploy user's `~/.ssh/authorized_keys`, and add the VPS to *Known hosts*.

## 3. Deploy

Push to `main` → the pipeline builds the image, pushes `:latest` + `:<commit>`
to GHCR, then SSHes in and runs `docker compose pull app && up -d app`.

First run order matters: complete step 1 (compose + `.env` + network + Caddy on
the server) **before** the first pipeline run, since the deploy step expects
`/opt/humid-server/docker-compose.yml` to exist.

## 4. Database

The app talks to **Supabase cloud** (pg_cron rollups run there too) — there's no
DB container. Make sure the schema is applied in Supabase:
`reset.sql → schema.sql → seed.sql → ingest_function.sql → grants.sql → cron.sql`,
plus `migrate_battery_status.sql` if migrating an existing project.

## 5. After it's live — point the devices at it

- Firmware `include/config.h`: set `POST_URL` to
  `https://humid.<domain>/api/ingest` (replaces the rotating Cloudflare tunnel).
- `humid-app/.env`: set `EXPO_PUBLIC_API_BASE=https://humid.<domain>` and rebuild.
- Hardening worth doing now that there's a stable cert: flip the firmware's
  `client.setInsecure()` to real TLS validation, and plan per-device ingest
  tokens (the shared `INGEST_TOKEN` is the prototype shortcut).
