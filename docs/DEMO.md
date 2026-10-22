# Remote Demo Runbook (Phone Hotspot)

How to run the vest on a phone hotspot in one place and watch the dashboard from another.

## Why this works without any networking setup

The ESP32 and the dashboard never talk to each other directly. Both connect *outbound* to a
public MQTT broker (`broker.hivemq.com`), which relays between them:

```
ESP32 ──(hotspot → cellular)──▶ broker.hivemq.com ◀──(any internet)── dashboard in a browser
```

So there is no port forwarding, no static IP, no VPN, and the two ends do not need to be on the
same network or even the same continent.

## One-time setup per location

WiFi credentials are compiled in, so a new hotspot means editing one file and reflashing.

1. If you have not built this checkout before, create your credentials file:

   ```bash
   cp firmware/esp32/secrets.ini.example firmware/esp32/secrets.ini
   ```

   `secrets.ini` is gitignored. **This repo is public — never put a real password in
   `platformio.ini`, which is committed.**

2. Edit `firmware/esp32/secrets.ini`:

   ```ini
   [secrets]
   wifi_ssid = your-hotspot-name
   wifi_password = your-hotspot-password
   device_id = resqpack-esp32-01
   ```

   `DEVICE_ID` must be unique per board — two boards sharing an ID will collide on the same MQTT
   topic and overwrite each other on the dashboard.

3. Flash the ESP32, from `firmware/esp32/`:

   ```bash
   pio run -t upload
   ```

4. Flash the Mega, from `firmware/mega/`:

   ```bash
   pio run -t upload
   ```

### iPhone hotspot

The ESP32 has no 5 GHz radio. On recent iPhones you must enable **Settings → Personal Hotspot →
Maximize Compatibility**, which forces the hotspot to 2.4 GHz. Without it the ESP32 will never
see the network. Android hotspots are usually 2.4 GHz by default, but check the band setting if
it fails to connect.

## Bring-up checklist

1. Turn the hotspot on **before** powering the boards, so the ESP32 finds it on its first attempt
   (it retries every 5 s regardless).
2. Open the ESP32 serial monitor at 115200 (`pio device monitor -b 115200` from
   `firmware/esp32/`). Expect, in order:

   ```
   ESP32 bridge MQTT gateway ready
   Event topic:  resqpack/v1/devices/resqpack-esp32-01/events
   Status topic: resqpack/v1/devices/resqpack-esp32-01/status
   WiFi: attempting connect...
   NTP: synced epoch=...
   MQTT: connected
   ```

3. Open the dashboard. Within 30 seconds the **Devices** tab should list the board as **Online**
   — that is the heartbeat arriving, and it confirms the whole chain works before any crash.

## Triggering a test without crashing anything

Use the button rather than a real impact. It travels the identical path a crash does:

1. Press the button once → buzzer on, 5-second cancel window starts (the Mega's serial monitor
   prints a `COUNTDOWN` line each second).
2. **Do not press again.** Let the window expire.
3. The Mega emits a `MANUAL` event; the ESP32 publishes it; the dashboard raises an incident.
4. Press the button again to clear the buzzer.

Pressing a second time *during* the window cancels locally and publishes nothing — that is
intended behaviour, not a fault.

If the button is not wired yet, the same flows can be driven from the Mega's serial monitor:
`b` injects a press, `c` injects a crash trigger, `s` prints the current state and countdown.
See "Serial test console" in `PROTOCOL.md`.

To rehearse the dashboard alone with no hardware at all, use **Settings → Demo → Send simulated
alert**. It publishes a real (non-retained) event to the broker, so it renders exactly as a live
incident does.

To test offline detection, pull the ESP32's power. The dashboard flips the device to **Offline**
via the MQTT Last Will, or after 90 seconds without a heartbeat, whichever comes first.

## Expected dashboard behaviour

- **No GPS lock indoors** is normal. The event still publishes with `valid=0`, and the dashboard
  places it at the default location configured under Settings → Default location. That pin is not
  a measurement — the device did not know where it was.
- **Timing** shows "since impact" once NTP has synced, and "since received" if it has not.
- **A crash that happened while the dashboard was closed** still appears when you open it: the
  latest event is published retained. It is labelled `restored` and deliberately does not sound
  the alarm.
- **Click "Enable alerts" once** per browser session. Browsers block audio and notifications
  until a user gesture, so without it the dashboard is silent.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Serial stuck at `WiFi: attempting connect...` | Wrong SSID/password, or a 5 GHz-only hotspot (see iPhone note) |
| WiFi connects, `MQTT: connect failed` repeatedly | Carrier or network blocking outbound port 1883 — try a different hotspot or tether over a different carrier |
| `NTP: waiting for valid time...` forever | Outbound UDP 123 blocked. Harmless: events still publish with `ts_ms=0` and the dashboard falls back to arrival time |
| Dashboard shows nothing at all | Confirm the topic in the ESP32 banner matches the dashboard's `VITE_MQTT_TOPIC_PREFIX` |
| Device never appears in Devices tab | The board is not reaching the broker; check the serial monitor rather than the dashboard |

## A note on privacy

This uses a public test broker. Anyone who knows or guesses the topic can read your GPS
coordinates, and anyone can publish a fake crash to your dashboard. That is an acceptable
trade-off for a prototype, but do not treat this deployment as private or trustworthy data.
