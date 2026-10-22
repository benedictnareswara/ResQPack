# Architecture

How the three tiers are put together, and the invariants that keep them working. For the wire
formats themselves see [PROTOCOL.md](PROTOCOL.md); for pins see [HARDWARE.md](HARDWARE.md).

```
MPU6050 + NEO-6M ──I²C / NMEA──▶ Mega 2560 ──UART CSV──▶ ESP32 ──MQTT/WiFi──▶ browser
   sensors                    firmware/mega/src      firmware/esp32/src   dashboard/src/app.jsx
```

## Mega firmware

`src/main.cpp` owns the 100 ms sample loop and the crash pattern detector. Everything else is a
single-responsibility module with a `.hpp`/`.cpp` pair and its state kept file-static in an
anonymous namespace.

| Module | Responsibility |
|---|---|
| `app_config.hpp` | Every pin, timing and threshold. Detection is tuned here, not at call sites. |
| `i2c_bitbang.cpp` | Open-drain I²C on pins 20/21 via direct AVR registers, including nine-pulse bus recovery. `Wire.h` was deliberately removed and should not come back. |
| `mpu6050.cpp` | Address probe (0x68/0x69), wake, 14-byte burst read, `\|g\|` magnitude. |
| `gps_parser.cpp` | Streams Serial1, parses `$GPRMC`/`$GNRMC` only, keeps the latest fix. `hasFreshFix()` gates on `GPS_FIX_STALE_MS`. |
| `button_input.cpp` | Debounced rising-edge detector: one press, one `true`. |
| `safety_fsm.cpp` | The alert state machine. Takes `setBuzzer` and `publishEvent` as function pointers, so it depends on neither the buzzer nor the bridge. |
| `bridge_protocol.cpp` | The only writer to Serial2. |

### The crash trigger

Two phases, not one threshold: acceleration must spike to at least `GFORCE_SPIKE_THRESHOLD_G`
(2.5 g) and then fall to `GFORCE_STOP_THRESHOLD_G` (1.2 g) or below within
`GFORCE_SPIKE_WINDOW_MS` (500 ms). A kerb or a pothole produces phase one alone; braking produces
phase two alone.

### The state machine

`STANDBY → CRASH_PENDING → CRASH_CONFIRMED`. Both a crash trigger and a button press enter
`CRASH_PENDING` — distinguished internally by `PendingSource` — turn the buzzer on and start the
`CRASH_CANCEL_WINDOW_MS` (5 s) countdown. A press inside the window cancels locally and publishes
nothing at all. Only when the window expires does the FSM publish, as `CRASH_CONFIRMED` or
`MANUAL`, and latch the buzzer until it is acknowledged.

The consequence worth knowing: the only event types that ever reach the network are
`CRASH_CONFIRMED` and `MANUAL`. `CANCELED` and `CLEAR` are serial-log events on the Mega. The
ESP32 enforces the same two-item allowlist in `isAcceptedEventType()`, so both boards agree without
consulting each other.

### Two calls per loop, one button edge

`updateSafetyStateMachine()` runs twice per iteration: once unconditionally, so the countdown and
the button keep working at full loop rate, and again after each MPU sample so a fresh crash trigger
is applied immediately. It is idempotent for `crashTrigger` but **not** for `buttonPressed` —
applying one press twice in a single iteration would start a countdown and instantly cancel it, or
re-arm one just as it was cleared. The first call owns the button edge; the second is always passed
`false`.

### Why the published g-force is latched

The FSM publishes five seconds after the impact, by which point the live accelerometer reading is
meaningless. `main.cpp` keeps `gReportAccelG`, which tracks the live magnitude but latches to the
spike peak when the pattern completes and holds it until the alert clears (`gCrashPeakLatched`).
That latched value is what goes on the wire.

### Bench console

`ENABLE_SERIAL_TEST_COMMANDS` in `app_config.hpp` (on by default) adds a console on Serial: `c`
injects a crash trigger, `b` a button press, `s` prints state and countdown. Injected events drive
the real FSM and publish to the live broker, so they are indistinguishable downstream — the point
being that the whole alert path can be exercised on a bare board with no MPU attached. The injected
crash is delivered through the *first* `updateSafetyStateMachine()` call for that reason. Set the
flag to `0` for anything that will actually be worn.

## ESP32 gateway

Parsed events go into a bounded ring buffer of 24 slots. `publishQueuedEvent()` peeks at the head,
publishes at QoS 1, and dequeues only on success, so a failed publish is retried rather than
dropped. When the buffer is full the oldest event is discarded and `gDroppedEventCount` increments,
which the status payload reports.

Timestamps come from NTP. Before the first sync the payload carries `ts_ms: 0`, which consumers
must read as "clock not trusted" and never as 1970.

**The gateway has no fallback position and must not grow one.** Coordinates are forwarded exactly
as the Mega sent them: the last known fix when one has gone stale, `0,0` when the device has never
had one. The dashboard is the sole owner of what an un-located alert displays, which is why that
behaviour can be changed at runtime instead of by reflashing. A substitution in firmware would give
one decision two owners, and they will drift.

Presence works through a retained status topic. A Last Will registered *before* `connect()`
publishes `online: 0` if the board drops off uncleanly, and a 30-second heartbeat republishes
`online: 1`. `gEventTopic`, `gStatusTopic` and `gWillPayload` are file-scope buffers on purpose:
the MQTT client keeps pointers into the will buffers, so a stack buffer there would dangle.

## Dashboard

`src/app.jsx` is the whole live application — one large component wired directly to `mqtt.js` and a
Leaflet map. Leaflet comes from npm (`main.jsx` imports `leaflet/dist/leaflet.css`), icons are
inline SVG paths in `ICON_PATHS`, and styling is a hand-written token system in `src/index.css`
(`--bg-*`, `--text-*`, `--space-*`, `--radius-*`, `--shadow-*`). Extend those tokens rather than
introducing a utility CSS framework.

`normalizeCrashPacket()` is deliberately permissive: it accepts several aliases for device, lat,
lon and timestamp, and classifies events by word-matching against `INCIDENT_EVENTS` /
`CLEAR_EVENTS`, dropping anything that is neither. Extend those sets rather than adding special
cases further downstream. A missing device id falls back to the third topic segment.

Broker and topics come from `VITE_MQTT_BROKER`, `VITE_MQTT_TOPIC_PREFIX` and
`VITE_MQTT_TOPIC_FILTER`, each with a hardcoded fallback. The code keeps a list of brokers and
fails over between them, filtering out non-`wss://` URLs when the page itself is served over HTTPS.

### Invariants that will break quietly if moved

**Never interpolate payload data into HTML.** Device ids arrive from a public broker where anyone
can publish. Toast bodies render as JSX children and map popups are built by `buildPopupContent()`
using `textContent`. Reintroducing `dangerouslySetInnerHTML`, or a `bindPopup` taking an HTML
string, is an injection hole.

**The MQTT `useEffect` has `[]` deps** and therefore captures its first closure for the lifetime of
the page. It calls through `handlerRef`, and mute state is read from `mutedRef`. Reading a plain
state variable inside the message handler silently reads stale data.

**Deduplication keys on `seq`**, via `incidentKey()`, not on the timestamp. Before NTP sync every
event shares `ts_ms: 0`, which previously collapsed a burst of distinct events into one.

**Retained messages must not alarm.** `packet.retain` is threaded through `handleIncomingData`, so a
replayed event populates the lists but skips the toast, the sound, the notification and the camera
move. It may claim the selection, but only when nothing is selected — a functional updater
guarantees that, so a reconnect burst cannot steal the panel from an incident being worked on.

**Elapsed time reads `anchorMs`, never `timestamp`.** `normalizeTimestamp()` answers "now" for an
unsynced device and is recomputed on every delivery, so reading it would restart a running clock on
any retained redelivery or broker failover. `anchorFor()` pins the anchor once per event key, first
write wins, clamped to `Date.now()` so a skewed device clock cannot start it in the future. The
anchor rides along on the persisted history entry, so a reload resumes the clock rather than
resetting it.

**The camera always follows the newest alert.** There is no manual mode and no jump pill: an
incident takes the tab, the selection and the map the moment it lands, so Resolve is one click away.

**The alert sheet and bottom bar exist at every width**, hidden by `display: none` above 900 px, so
crossing the breakpoint mid-alert never remounts them. Below 900 px every panel floats *over* the
map rather than replacing it in the flow — never `display: none` the map or any ancestor, or
Leaflet caches a 0×0 size and the tiles stay grey. `--sheet-peek` must stay equal to
`MOBILE_SHEET_PEEK_PX`, which is what `focusMapOnAlert()` pads the camera by.

**Reduced motion parks animations on their final keyframe**, so `alert-breathe` is written with
both `0%` and `100%` at full strength. Simplifying it to `from`/`to` would make the alarm nearly
invisible for those users.

### Presentation overrides

`PRESENT_ALL_FIXES_AS_LOCKED` and `PRESENT_ALL_ALERTS_AS_CRASH` both ship `false`. Turned on, the
first renders a fallback position as though it were a real satellite fix, and the second describes a
manual button press as a confirmed crash. They exist so a demo can be filmed indoors with no GPS
and a uniform set of alerts, and they are presentation only: `gpsValid`, `incident.event` and
`incident.raw` keep the truth and are still persisted. Every UI read goes through `showsGpsLock()`,
`shownIncidentLabel()` and `shownIncidentBadge()`, so toggling a flag also corrects display for
records already in storage. Never read `incident.gpsValid` or `incident.event` directly in JSX, and
never call `incidentLabel()` there — that is what reintroduces the inconsistency.

`"MANUAL"` must stay in `INCIDENT_EVENTS`. Removing it makes real vest-button alerts vanish
silently instead of rendering.

### Persistence

History is written to `localStorage` under `resqpack:history:v1` (capped at
`HISTORY_LIMIT` entries) and preferences under `resqpack:prefs:v1`.
`processedCrashEventsRef` is seeded from the restored entries' keys, so a retained event is not
duplicated after a reload, and `alertAnchorsRef` is seeded the same way from each entry's
`anchorMs`.
