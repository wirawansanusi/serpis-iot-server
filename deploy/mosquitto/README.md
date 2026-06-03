# MQTT broker (Mosquitto) for the IR fleet

The IR blaster firmware holds a persistent TLS MQTT connection and subscribes to
`serpis/ir/<public_device_id>/cmd`. `humid-server` publishes commands there (and
listens on `.../evt` + `.../status`).

## Topics

| Topic | Dir | QoS | Notes |
|---|---|---|---|
| `serpis/ir/<pubid>/cmd` | server → device | 1 | command JSON |
| `serpis/ir/<pubid>/evt` | device → server | 1 | ack / learned-code events |
| `serpis/ir/<pubid>/status` | device → server | 1 | retained + LWT: `online`/`offline` |

## One-time setup on the VPS

1. **TLS cert** — the device validates the broker against Let's Encrypt roots, so
   the broker must present an LE cert for `mqtt.serpis.id`. Point DNS
   `mqtt.serpis.id` at the VPS and issue a cert (certbot, or copy from Caddy's
   data dir). Place `fullchain.pem` + `privkey.pem` into `deploy/mosquitto/certs/`
   (mounted read-only at `/mosquitto/certs`). A renewal hook should refresh those
   two files and `docker restart serpis-mqtt`.

2. **Passwords** — create the password file (one shared device account + one
   backend account for now):

   ```sh
   docker run --rm -it -v "$PWD/mosquitto:/mosquitto/config" eclipse-mosquitto:2 \
     mosquitto_passwd -c /mosquitto/config/passwd ir-device
   docker run --rm -it -v "$PWD/mosquitto:/mosquitto/config" eclipse-mosquitto:2 \
     mosquitto_passwd      /mosquitto/config/passwd humid-server
   ```

   Put the `ir-device` password in the firmware's `include/config.local.h`
   (`MQTT_PASS`) and the `humid-server` password in the server `.env`
   (`MQTT_PASSWORD`).

3. **Open the firewall** for `8883/tcp` (devices connect from the internet).

## Smoke test

```sh
# subscribe to a device's command topic (TLS, from anywhere):
mosquitto_sub -h mqtt.serpis.id -p 8883 -u ir-device -P '<pw>' \
  -t 'serpis/ir/+/cmd' -v

# publish a test NEC code to a device (replace <pubid>):
mosquitto_pub -h mqtt.serpis.id -p 8883 -u ir-device -P '<pw>' \
  -t 'serpis/ir/<pubid>/cmd' \
  -m '{"id":"test1","kind":"protocol","protocol":"NEC","code":"0x20DF10EF","bits":32}'
```
