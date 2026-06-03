# Testing EMQX per-device MQTT auth

A step-by-step way to prove the broker is doing what it should **before** you
trust the fleet to it. You verify five things:

1. The broker is up with both listeners (8883 TLS, 1883 internal).
2. The HTTP hooks (`/api/mqtt/auth`, `/api/mqtt/acl`) answer correctly.
3. A device can log in with **its own** derived credential — and is rejected with
   a wrong one.
4. A device is locked to **its own** `serpis/ir/<pubid>/*` topics.
5. The backend superuser sees the whole fleet, and a dropped device flips
   `link_online` → the app shows "offline".

> Run everything from the VPS in `deploy/` (where `docker-compose.yml` and the
> `.env` live), unless noted. Assumes the stack is up: `docker compose up -d`.

---

## 0. Tools

```sh
# On the VPS (Debian/Ubuntu):
sudo apt-get install -y mosquitto-clients jq
# 'curl' from inside the Docker network — we use a throwaway container so we hit
# serpis-iot-server by its container name exactly like EMQX does.
```

You'll also need a **provisioned device's** `public_device_id`. Any row in
`devices` with a `claim_secret_enc` works — a real flashed blaster, or one made
with `scripts/provision-device.mjs`.

---

## 1. Broker smoke test

```sh
docker compose ps                       # serpis-mqtt (emqx) = running/healthy
docker exec -it serpis-mqtt emqx ctl status
docker exec -it serpis-mqtt emqx ctl listeners | grep -E 'ssl:default|tcp:default'
# Expect both: ssl:default  ...:8883  running ; tcp:default ...:1883 running
```

If a listener is missing, the cert paths in `emqx/emqx.conf` are usually wrong —
check `docker compose logs serpis-mqtt`.

---

## 2. Test the HTTP hooks directly (no MQTT yet)

The hooks live on the internal network (not via Caddy). Hit them the way EMQX
does — from a container on the `web` network — using the **same**
`MQTT_AUTH_HOOK_SECRET` you put in `.env` / `emqx.conf`:

```sh
HOOK_SECRET='<paste MQTT_AUTH_HOOK_SECRET>'

# 2a. Backend superuser -> allow + is_superuser:true
docker run --rm --network web curlimages/curl -s \
  -H "content-type: application/json" -H "x-auth-hook-secret: $HOOK_SECRET" \
  -d '{"username":"serpis-backend","password":"<MQTT_PASSWORD>"}' \
  http://serpis-iot-server:3000/api/mqtt/auth | jq
# => {"result":"allow","is_superuser":true}

# 2b. Wrong hook secret -> 403 deny (anyone probing the endpoint)
docker run --rm --network web curlimages/curl -s -o /dev/null -w '%{http_code}\n' \
  -H "content-type: application/json" -H "x-auth-hook-secret: nope" \
  -d '{"username":"x","password":"y"}' \
  http://serpis-iot-server:3000/api/mqtt/auth
# => 403

# 2c. ACL: a device on its OWN cmd topic -> allow
docker run --rm --network web curlimages/curl -s \
  -H "content-type: application/json" -H "x-auth-hook-secret: $HOOK_SECRET" \
  -d '{"username":"<pubid>","topic":"serpis/ir/<pubid>/cmd","action":"subscribe"}' \
  http://serpis-iot-server:3000/api/mqtt/acl | jq
# => {"result":"allow"}

# 2d. ACL: a device on SOMEONE ELSE's topic -> deny
docker run --rm --network web curlimages/curl -s \
  -H "content-type: application/json" -H "x-auth-hook-secret: $HOOK_SECRET" \
  -d '{"username":"<pubid>","topic":"serpis/ir/OTHER/cmd","action":"subscribe"}' \
  http://serpis-iot-server:3000/api/mqtt/acl | jq
# => {"result":"deny"}
```

Watch the server side while you do this: `docker compose logs -f app | grep mqtt-auth`.

---

## 3. Get a device's MQTT credentials

Run it on a machine with the repo + node + the `.env` (your dev box or the VPS
checkout — **not** the slim production container, which doesn't ship `scripts/`):

```sh
# from the serpis-iot-server repo root, with .env holding SUPABASE_URL,
# SUPABASE_SERVICE_ROLE_KEY, CLAIM_SECRET_ENC_KEY:
node --env-file=.env scripts/print-mqtt-creds.mjs <pubid>
# username : <pubid>
# password : <64 hex chars>
```

This derives the exact password the firmware computes, so you can impersonate the
device. `CLAIM_SECRET_ENC_KEY` must be the same one used to provision it.

---

## 4. Connect AS a device (the important test)

Export the creds from step 3:

```sh
PUBID='<pubid>'; DPASS='<password from step 3>'
HOST=mqtt.serpis.id          # must match the cert CN; resolve it to the VPS
```

**4a. Correct creds + own topic → connects and subscribes:**

```sh
mosquitto_sub -h "$HOST" -p 8883 --capath /etc/ssl/certs \
  -u "$PUBID" -P "$DPASS" -t "serpis/ir/$PUBID/cmd" -v -d
# Connection holds open. Leave it running for step 5/6.
```

**4b. Wrong password → rejected (CONNACK "not authorized"):**

```sh
mosquitto_sub -h "$HOST" -p 8883 --capath /etc/ssl/certs \
  -u "$PUBID" -P "deadbeef" -t "serpis/ir/$PUBID/cmd" -d
# => Connection Refused: not authorised.  (MQTT5 reason 135 / MQTT3 rc 5)
```

**4c. Right creds but someone else's topic → publish/subscribe denied + dropped:**

```sh
mosquitto_pub -h "$HOST" -p 8883 --capath /etc/ssl/certs \
  -u "$PUBID" -P "$DPASS" -t "serpis/ir/SOMEONE_ELSE/cmd" -m hi -d
# => disconnected (no_match = deny, deny_action = disconnect)
```

If 4a fails with a TLS error, the broker isn't presenting a cert valid for
`$HOST` — fix `emqx/certs/*`. If 4a is refused but the password is right, the
hook secret or `CLAIM_SECRET_ENC_KEY` differs between this script and the server.

---

## 5. Backend superuser sees the fleet

In a second terminal, subscribe to every device's events as the superuser:

```sh
mosquitto_sub -h "$HOST" -p 8883 --capath /etc/ssl/certs \
  -u serpis-backend -P '<MQTT_PASSWORD>' -t 'serpis/ir/+/evt' -t 'serpis/ir/+/status' -v
```

Now, from the device session (step 4a is its own terminal), publish an event and
confirm the superuser receives it:

```sh
mosquitto_pub -h "$HOST" -p 8883 --capath /etc/ssl/certs \
  -u "$PUBID" -P "$DPASS" -t "serpis/ir/$PUBID/evt" -m '{"kind":"ack","ok":true}'
# The superuser terminal prints: serpis/ir/<pubid>/evt {"kind":"ack","ok":true}
```

This proves the wildcard subscription (superuser-only) works and that a device
can publish its own `evt`.

---

## 6. Online/offline via the Last-Will

The device's connection sets a retained Last-Will of `offline` on
`serpis/ir/<pubid>/status`; the backend records it as `link_online`.

```sh
# Connect a device session that declares the will, then watch the column:
mosquitto_sub -h "$HOST" -p 8883 --capath /etc/ssl/certs \
  -u "$PUBID" -P "$DPASS" -t "serpis/ir/$PUBID/cmd" \
  --will-topic "serpis/ir/$PUBID/status" --will-payload offline --will-retain \
  -i "ir-$PUBID" &
SUBPID=$!

# Publish "online" like the firmware does on connect:
mosquitto_pub -h "$HOST" -p 8883 --capath /etc/ssl/certs \
  -u "$PUBID" -P "$DPASS" -t "serpis/ir/$PUBID/status" -m online -r
```

Check the column (Supabase SQL editor or psql):

```sql
select public_device_id, link_online from devices where public_device_id = '<pubid>';
-- link_online = true ; the app dashboard shows the blaster "online"
```

Now simulate an **ungraceful** drop so the will fires (a clean Ctrl-C sends a
DISCONNECT and the will is NOT published):

```sh
kill -9 $SUBPID          # hard kill — broker detects the dead socket, fires LWT
```

Within a few seconds the broker publishes the retained `offline`, the backend's
`/evt`+`/status` subscriber sets `link_online = false`, and the app flips the
device to "offline" without waiting out the freshness window. Re-check the SQL —
`link_online` should now be `false`.

---

## 7. Real device end-to-end

1. Flash a blaster (`config.local.h` filled in, `MQTT_HOST=mqtt.serpis.id`).
2. Serial monitor: look for `[mqtt] connected; subscribed serpis/ir/<pubid>/cmd`.
   A `rc=5`/`not authorized` here means the device's derived password doesn't
   match the backend — confirm the same `CLAIM_SECRET_ENC_KEY` was used to
   provision it.
3. App dashboard → the blaster shows **online**; open its remote and send a
   command → status goes **Sent → Confirmed** (the device's MQTT ack).
4. Power the device off → app shows **offline** within seconds (LWT).

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every device refused (`not authorized`) | `MQTT_AUTH_HOOK_SECRET` differs between `.env` and `emqx.conf`, or `app` can't be reached — check `docker compose logs app \| grep mqtt-auth`. |
| One device refused, others fine | Its `claim_secret` was set with a different `CLAIM_SECRET_ENC_KEY` than the server now runs; re-provision, or check `print-mqtt-creds.mjs` against the firmware serial log. |
| Hooks return 403 to EMQX | The `x-auth-hook-secret` header in `emqx.conf` doesn't match `MQTT_AUTH_HOOK_SECRET`. |
| EMQX log: connection refused to `serpis-iot-server:3000` | EMQX and `app` aren't on the same `web` network, or the app container isn't named `serpis-iot-server`. |
| TLS handshake fails from clients | `emqx/certs/fullchain.pem`+`privkey.pem` missing/expired or not for `mqtt.serpis.id`. |
| Superuser can't use `+` wildcards | `MQTT_USERNAME`/`MQTT_PASSWORD` in `.env` don't match what the app sends; authn must return `is_superuser:true` (see `docker compose logs app`). |
| `link_online` never flips to false | You disconnected cleanly (Ctrl-C). A clean DISCONNECT suppresses the will — use `kill -9` or pull power, as a real outage would. |

When in doubt, tail both sides at once:

```sh
docker compose logs -f app serpis-mqtt | grep -Ei 'mqtt|auth|acl'
```
