# Mega to ESP32 Bridge Protocol

## Transport
- UART: Mega Serial2 <-> ESP32 Serial2
- Baud: 115200
- Framing: one CSV packet per line (`\n` terminated)

## Event Packet (current)
`EVT,<seq>,<event>,<valid>,<lat>,<lon>,<age_ms>,<tilt_deg>,<accel_g>`

Fields:
- `seq`: monotonically increasing unsigned integer from Mega
- `event`: `MANUAL` or `CRASH_CONFIRMED` (see "What actually reaches the network" below)
- `valid`: `1` if GPS fix fresh, otherwise `0`
- `lat`, `lon`: decimal degrees. When `valid=0` these are the **last known fix**, or `0,0` if the
  device has never had one. Neither board substitutes anything for them — see "Who owns the
  fallback position" below.
- `age_ms`: age of GPS fix in milliseconds; `0` when invalid
- `tilt_deg`: **always `0.00`.** Retained only so the field count stays at 9; the ESP32 parser
  requires exactly 9 fields and dropping it would break the parse.
- `accel_g`: acceleration magnitude in g. For a crash this is the *spike peak* captured when the
  pattern completed, not the reading at publish time.

## Changing this contract

Three files implement it, and all three must move in the same commit:

| File | Role |
|---|---|
| `firmware/mega/src/bridge_protocol.cpp` | writes the CSV line |
| `firmware/esp32/src/main.cpp` (`parseEventLine()`) | parses the CSV, builds the JSON |
| `dashboard/src/app.jsx` (`normalizeCrashPacket()`) | consumes the JSON |

The ESP32 parser requires exactly nine fields, so adding or removing one breaks the parse rather
than degrading it. Bump the topic version (`resqpack/v1/...`) for any change that is not
backwards-compatible, and update this document in the same commit.

## Legacy Packet (migration support)
`GPS,<seq>,<valid>,<lat>,<lon>,<age_ms>`

ESP32 parser currently accepts both formats.

## MQTT Gateway Contract (ESP32)
- Event topic: `resqpack/v1/devices/<device_id>/events`
- Status topic: `resqpack/v1/devices/<device_id>/status`

### Event payload (JSON)
Published **retained** at QoS 1, so a dashboard connecting later immediately receives the most
recent incident.

```json
{
  "device": "resqpack-esp32-01",
  "seq": 12,
  "event": "CRASH_CONFIRMED",
  "valid": 0,
  "lat": 0.000000,
  "lon": 0.000000,
  "ts_ms": 1754236800000,
  "received_ms": 84213,
  "age_ms": 0,
  "accel_g": 3.214
}
```

- `ts_ms` is wall-clock epoch milliseconds, or **`0` until NTP syncs**. Consumers must treat 0
  (and any value below the epoch floor) as "clock not trusted" rather than as 1970.
- `received_ms` is the ESP32's monotonic `millis()` at the moment the packet arrived from the
  Mega. It is the only usable ordering signal before NTP sync.
- `seq` is the firmware sequence number and is the correct deduplication key.

### Status payload (JSON)
One shape for all three status writes — connect, heartbeat, and Last Will — always published
**retained** at QoS 1.

```json
{ "device": "resqpack-esp32-01", "online": 1, "wifi": 1, "queue": 0, "dropped": 0, "uptime_ms": 84213 }
```

The Last Will is registered before connecting and carries `{"device":"<id>","online":0}`. The
broker publishes it automatically if the ESP32 disconnects uncleanly, which is how a dashboard
distinguishes a dead device from a quiet one. Because the will only fires after the broker's
keepalive expires, consumers should additionally treat a device with no heartbeat for ~90 s as
offline.

## What actually reaches the network
Only `CRASH_CONFIRMED` and `MANUAL` are ever published. `CANCELED` and `CLEAR` are serial-log
events on the Mega only — a cancelled alert transmits nothing at all. The ESP32 enforces the same
allowlist in `isAcceptedEventType()`, so both boards agree independently.

## ESP32 Reliability Rules
- Queue incoming events while MQTT is disconnected (24 slots).
- Replay queued events in FIFO order when MQTT reconnects.
- Publish peeks at the head and only dequeues on success, so a failed publish is retried.
- Queue is bounded; when full, drop oldest event and increment `dropped` counter.
- Status heartbeat is published every 30 seconds while connected.
- Coordinates are forwarded exactly as received. The gateway has no fallback position.

## Who owns the fallback position
The **dashboard** does, and nothing else. When `valid=0` it substitutes an operator-configured
default (Settings → Default location) for display, which is why changing where un-located alerts
appear needs no reflash.

The override is unconditional on `valid`, so a packet carrying a stale-but-real last known
position is still displayed at the configured default. The reported position is never destroyed —
it stays in the payload and in the dashboard's `incident.raw`.

Neither firmware may reintroduce a substitution. Two owners of this decision will drift apart, and
the wire should keep saying what the GPS actually last saw.

## Trigger Model on Mega
Crash detection is a two-phase **pattern**, not a single threshold:

- Phase 1: acceleration spikes to >= `GFORCE_SPIKE_THRESHOLD_G` (2.5 g)
- Phase 2: within `GFORCE_SPIKE_WINDOW_MS` (500 ms), it drops to <= `GFORCE_STOP_THRESHOLD_G`
  (1.2 g)
- Both phases completing = crash trigger. The spike peak is latched for reporting.

State machine (`STANDBY → CRASH_PENDING → CRASH_CONFIRMED`):

- A crash trigger *or* a button press from standby enters `CRASH_PENDING`, buzzer on, and starts
  the `CRASH_CANCEL_WINDOW_MS` (5 s) countdown.
- Button press inside the window: cancel, buzzer off, return to standby, **publish nothing**.
- Window expires: publish (`CRASH_CONFIRMED` or `MANUAL`), buzzer latches on until acknowledged.
- Button press in `CRASH_CONFIRMED`: buzzer off, return to standby, publish nothing.
- Cooldown after crash exit: `EVENT_COOLDOWN_MS` (3 s) before another crash can trigger.

All thresholds and timings live in `firmware/mega/src/app_config.hpp`.

`updateSafetyStateMachine()` is called twice per loop — once every iteration, and again after each
MPU sample. It is idempotent for `crashTrigger`, but **not for `buttonPressed`**: applying one
press twice would start a countdown and instantly cancel it, or re-arm one just as it was cleared.
The first call therefore owns the button edge and the second always receives `false`.

## Serial test console (Mega)
Enabled by `ENABLE_SERIAL_TEST_COMMANDS` in `firmware/mega/src/app_config.hpp` (default on). Type into the
serial monitor at 115200:

| Key | Effect |
|---|---|
| `c` | Inject a crash trigger with a `TEST_INJECTED_CRASH_G` peak |
| `b` | Inject a button press edge |
| `s` | Print state, pending source, remaining countdown, MPU and GPS status |

Injected events are indistinguishable from real ones downstream: they drive the same state machine
and publish to the live broker. Works with no MPU attached, so the FSM can be exercised on a bare
board. Set the flag to `0` for a build that will be worn rather than benched.
