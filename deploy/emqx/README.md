# EMQX broker — per-device MQTT auth

EMQX replaces Mosquitto so every IR blaster authenticates with **its own**
credential and is locked to **its own** topics. Both checks are delegated to
serpis-iot-server over the internal Docker network.

## How it works

**Credential (derived, never stored in plaintext):**

- username = `public_device_id`
- password = lowercase hex of `HMAC_SHA256(claim_secret, "mqtt-auth:" + public_device_id)`

Both the firmware (`src/main.cpp` → `deriveMqttCreds`, mbedTLS) and the backend
(`lib/mqtt-auth.ts` → `deriveMqttPassword`, from the AES-decrypted `claim_secret`)
compute the same value, so nothing extra is provisioned — the existing claim
secret is the root.

**Connect (authn):** EMQX POSTs `{username, password}` to
`POST /api/mqtt/auth`. The backend recomputes the expected password and replies
`{result: allow|deny, is_superuser}`. The backend's own mqtt.js client logs in
with `MQTT_USERNAME`/`MQTT_PASSWORD` and gets `is_superuser: true`.

**Pub/Sub (authz):** for non-superusers EMQX POSTs `{username, topic, action}` to
`POST /api/mqtt/acl`. The backend allows only:

| action | topic |
|---|---|
| subscribe | `serpis/ir/<pubid>/cmd` |
| publish | `serpis/ir/<pubid>/evt`, `serpis/ir/<pubid>/status` |

Everything else is denied (`no_match = deny`, `deny_action = disconnect`). The
superuser backend bypasses ACL entirely, so it keeps its fleet-wide
`serpis/ir/+/evt` / `+/status` subscriptions.

Both hook endpoints require the shared `X-Auth-Hook-Secret` header, so only EMQX
can call them.

## Setup (on the VPS, in `deploy/`)

1. **Certs** — put the Let's Encrypt cert for `mqtt.serpis.id` here:
   ```
   emqx/certs/fullchain.pem
   emqx/certs/privkey.pem
   ```
   Create the runtime directories if they do not exist:
   ```sh
   mkdir -p emqx/certs emqx/data
   ```
   EMQX runs as the `emqx` user inside the container. If `emqx/data` was created
   by root, make it writable by the container before starting:
   ```sh
   sudo chown -R 1000:1000 emqx/data
   ```
2. **Secrets** — generate two random values:
   ```
   openssl rand -hex 32   # -> MQTT_AUTH_HOOK_SECRET
   openssl rand -hex 24   # -> MQTT_PASSWORD (backend superuser)
   ```
3. **Server `.env`** (see `.env.server.example`): set `MQTT_URL=mqtt://serpis-mqtt:1883`,
   `MQTT_USERNAME=serpis-backend`, `MQTT_PASSWORD=<the rand -hex 24>`,
   `MQTT_AUTH_HOOK_SECRET=<the rand -hex 32>`.
4. **`emqx/emqx.conf`** — replace the three placeholders:
   - `REPLACE_WITH_MQTT_AUTH_HOOK_SECRET` (×2) → the **same** `MQTT_AUTH_HOOK_SECRET`.
   - `REPLACE_WITH_RANDOM_COOKIE` → any random string (EMQX node cookie).
   Keep the node name as `emqx@127.0.0.1`; this is a single-node broker, so the
   CLI can talk to EMQX over loopback inside the same container.
5. **Bring it up:** `docker compose up -d`. The broker container is named
   `serpis-mqtt`, so `MQTT_URL` is unchanged.

## Verify

```sh
# Backend superuser can see the fleet:
docker exec -it serpis-mqtt emqx ctl listeners            # 8883 ssl + 1883 tcp up

# A device with a WRONG password is rejected (CONNACK not authorized).
# A device on someone else's topic is disconnected (no_match = deny).
```

If that `docker exec` command says the container is restarting, inspect startup
logs on the VPS first:

```sh
docker logs serpis-mqtt --tail 120
# or, from deploy/:
docker compose logs mosquitto --tail 120
```

Common startup failures are:

| Log symptom | Fix |
|---|---|
| `mkdir: cannot create directory '/opt/emqx/data/configs': Permission denied` | `sudo chown -R 1000:1000 emqx/data && docker restart serpis-mqtt` |
| missing `fullchain.pem` or `privkey.pem` | Put the Let's Encrypt files in `emqx/certs/` and restart |
| `cert_file_not_found ... cacert.pem` | Make sure `listeners.ssl.default.ssl_options.cacertfile` points at `fullchain.pem`; this deployment does not use client certificates |
| `wss:default(0.0.0.0:8084) : no_cert` | Recreate the broker with the compose file that disables unused WS/WSS listeners |
| HOCON/config parse error | Re-check the placeholder replacements in `emqx/emqx.conf`, then `docker compose up -d` |
| `Node 'emqx@...' not responding to pings` | Make sure `docker-compose.yml` sets `EMQX_NODE__NAME: emqx@127.0.0.1`, then recreate the container |

The firmware no longer uses the shared `MQTT_USER`/`MQTT_PASS` from
`config.local.h` — those are now ignored on the device side (the backend
superuser still uses env creds). EMQX 5 hook contract:
<https://docs.emqx.com/en/emqx/latest/access-control/authn/http.html>.

> Migrating from Mosquitto: the old `deploy/mosquitto/` files are superseded.
> Keep them only until EMQX is confirmed working, then remove.
