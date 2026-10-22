// src/App.jsx
import { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } from "react";
import L from "leaflet";
import mqtt from "mqtt";

// ============================================================
// CONSTANTS
// ============================================================
// Where the map sits before any incident arrives — central Jakarta.
const DEFAULT_MAP_CENTER = { lat: -6.2088, lng: 106.8456 };

// Seed value for the fallback position, used until the operator sets their own in
// Settings. The live value lives in component state and is persisted per browser —
// this is only where a fresh install starts. The firmware deliberately no longer
// substitutes anything, so this dashboard is the sole owner of the decision.
// Kantor Lurah Pancoran, Jakarta Selatan.
const DEFAULT_FALLBACK_LOCATION = { lat: -6.2487176, lng: 106.8409574 };

const LAT_RANGE = [-90, 90];
const LNG_RANGE = [-180, 180];

const isValidLat = (value) =>
  Number.isFinite(value) && value >= LAT_RANGE[0] && value <= LAT_RANGE[1];
const isValidLng = (value) =>
  Number.isFinite(value) && value >= LNG_RANGE[0] && value <= LNG_RANGE[1];

// Device IDs are used to build an MQTT topic. A '#', '+' or '/' would produce a
// wildcard or malformed topic on a public broker, so the demo publisher restricts the
// field to what a firmware DEVICE_ID can legally contain.
const sanitizeDeviceId = (value) =>
  String(value || "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 48);

// Presentation override, off by default. When true, an incident placed at the configured
// fallback is rendered exactly like a real satellite fix: solid marker, "GPS lock" in the
// detail panel, no warning chip, no legend entry, no popup note. It exists so a demo can
// be filmed indoors, where the GPS module never gets a fix.
//
// It hides a real distinction, which is why it ships off. The coordinates shown for an
// unlocked fix are a hardcoded address, not where the device is, so anyone acting on them
// is being sent to the wrong place. The truth is never destroyed either way: `gpsValid` is
// still parsed from the payload and still written to localStorage, so toggling this only
// changes presentation, for stored records as well as new ones.
const PRESENT_ALL_FIXES_AS_LOCKED = false;

// Single read point for "should this incident look like it has a lock?".
const showsGpsLock = (incident) => PRESENT_ALL_FIXES_AS_LOCKED || incident?.gpsValid !== false;

// Presentation override, off by default, and the sibling of the switch above. When true,
// an alert a person raised by hand — event MANUAL from the vest button, or the Settings
// demo publisher — is described everywhere as a confirmed crash: same label, same badge,
// same notification title, same map popup, same screen-reader announcement.
//
// It hides a real distinction, which is why it ships off. MANUAL means someone pressed the
// button; CRASH_CONFIRMED means the two-phase impact pattern in the Mega's FSM fired, and
// anyone triaging a queue of alerts needs to tell a drill from a collision. As above,
// `incident.event` and `incident.raw.event` still carry MANUAL into localStorage, so this
// is presentation only.
const PRESENT_ALL_ALERTS_AS_CRASH = false;

// Single read point for "what event type is the UI allowed to see?". RESOLVED is a
// dashboard-local status rather than a wire event and must survive the mask, or resolved
// history entries would render as fresh crashes.
const shownEventType = (eventText) =>
  PRESENT_ALL_ALERTS_AS_CRASH && eventText && eventText !== "RESOLVED"
    ? "CRASH_CONFIRMED"
    : eventText;

const HISTORY_STORAGE_KEY = "resqpack:history:v1";
const PREFS_STORAGE_KEY = "resqpack:prefs:v1";
const HISTORY_LIMIT = 100;

// A device is considered stale if no heartbeat arrives within this window. The MQTT
// Last Will only fires once the broker's keepalive expires, so the client needs its
// own timeout to catch a device that vanished quietly.
const DEVICE_STALE_MS = 90000;
const DEVICE_SWEEP_MS = 15000;

// Mirrors MIN_VALID_EPOCH on the ESP32. Below this the device clock has not synced
// with NTP and its ts_ms must not be trusted (the firmware publishes 0 until sync).
const MIN_VALID_EPOCH_MS = 1700000000000;

const ELAPSED_WARN_MS = 5 * 60 * 1000;
const ELAPSED_CRITICAL_MS = 15 * 60 * 1000;

const MQTT_TOPIC_PREFIX = import.meta.env.VITE_MQTT_TOPIC_PREFIX || "resqpack/v1/devices";
const DEFAULT_MQTT_TOPIC_FILTER = `${MQTT_TOPIC_PREFIX}/#`;
const normalizeTopicFilter = (topic) => (topic.endsWith("/") ? `${topic}#` : topic);
const MQTT_TOPIC_FILTERS = [
  ...new Set(
    (import.meta.env.VITE_MQTT_TOPIC_FILTER || DEFAULT_MQTT_TOPIC_FILTER)
      .split(",")
      .map((topic) => topic.trim())
      .map(normalizeTopicFilter)
      .filter(Boolean),
  ),
];
const DEFAULT_MQTT_BROKERS = ["wss://broker.hivemq.com:8884/mqtt"];
const MQTT_BROKER_URLS = [
  ...new Set([
    ...(import.meta.env.VITE_MQTT_BROKER || "")
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean),
    ...DEFAULT_MQTT_BROKERS,
  ]),
].filter((url) => window.location.protocol !== "https:" || url.startsWith("wss://"));

const INCIDENT_EVENTS = new Set([
  "ACCIDENT",
  "ACCIDENT_DETECTED",
  "ALERT",
  "COLLISION",
  "CRASH",
  "CRASH_CONFIRMED",
  "CRASH_DETECTED",
  "CRASHED",
  "EMERGENCY",
  "IMPACT",
  "IMPACT_DETECTED",
  "MANUAL",
  "SOS",
]);
const CLEAR_EVENTS = new Set(["CLEAR", "NO_CRASH", "NORMAL", "OK", "ONLINE", "RESOLVED", "SAFE"]);

// Demo defaults. The device ID is distinct from the real vest so a simulated alert
// occupies its own incident slot rather than overwriting a live one — change it to a
// real device ID if you want the demo to appear as that vest.
const DEFAULT_DEMO_DEVICE_ID = "resqpack-demo-01";
const DEFAULT_DEMO_ACCEL_G = 3.2;

// The demo publishes the same event type the firmware publishes for a real detection.
// There is no manual option any more: a demo alert that announced itself as manual would
// defeat PRESENT_ALL_ALERTS_AS_CRASH by handing the operator a second channel to read.
const DEMO_EVENT_TYPE = "CRASH_CONFIRMED";

// Zoom the map lands on when it jumps to a live alert. Tight enough to read the street,
// wide enough that a fallback position is not presented as metre accuracy.
const ALERT_FOCUS_ZOOM = 16;

// The phone layout's breakpoint, shared with the @media rule in index.css, and the resting
// height of the alert sheet, shared with --sheet-peek. If either pair drifts, the sheet and
// the map disagree about who owns the bottom of the screen.
const MOBILE_BREAKPOINT_QUERY = "(max-width: 900px)";
const MOBILE_SHEET_PEEK_PX = 252;

const matchesMobile = () => window.matchMedia?.(MOBILE_BREAKPOINT_QUERY).matches === true;

// useSyncExternalStore rather than a resize effect: the first paint reads the real width
// instead of rendering the desktop layout and correcting it a frame later.
const subscribeToMobile = (onChange) => {
  const query = window.matchMedia?.(MOBILE_BREAKPOINT_QUERY);
  if (!query) return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

// Destinations for the phone bottom bar. "map" is the bare map with no list over it and
// exists only below the breakpoint; the desktop sidebar has no such tab.
const MOBILE_VIEWS = [
  { id: "active", label: "Alerts" },
  { id: "map", label: "Map" },
  { id: "devices", label: "Devices" },
  { id: "history", label: "History" },
];

// The alert title flash alternates this prefix with the page's real title, and restores the
// real one on cleanup.
const ALERT_TITLE_PREFIX = "ALERT — ";

// Captured before anything can touch it, so the flash restores the real title rather than a
// guess. Guarded because a hot reload re-evaluates this module in place, and doing that
// while an alert is mid-flash would capture the alarm as the base — leaving the tab
// shouting forever after the alert cleared.
const BASE_DOCUMENT_TITLE = (() => {
  const current = document.title || "";
  return !current || current.startsWith(ALERT_TITLE_PREFIX) ? "ResQPack" : current;
})();

// ============================================================
// HELPERS
// ============================================================
let _toastId = 0;
const nextToastId = () => ++_toastId;

let _historyId = 0;
const nextHistoryId = () => ++_historyId;

const formatTime = (date) =>
  new Date(date).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const formatDateTime = (date) =>
  new Date(date).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const pad2 = (n) => String(n).padStart(2, "0");

// Compact clock for the elapsed-time readouts: "0:04", "4:12", "1:02:33".
const formatElapsed = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`;
};

const formatLastSeen = (ms) => {
  if (!Number.isFinite(ms)) return "never";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
};

const elapsedSeverity = (ms) => {
  if (ms >= ELAPSED_CRITICAL_MS) return "critical";
  if (ms >= ELAPSED_WARN_MS) return "warn";
  return "normal";
};

const getFirstDefined = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== "");

const parseFiniteNumber = (...values) => {
  const value = getFirstDefined(...values);
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// Returns both the timestamp and whether the device clock could be trusted. The ESP32
// publishes ts_ms=0 until NTP syncs; rendering that as 1970 — and keying dedup on it —
// silently swallowed every event after the first.
const normalizeTimestamp = (value) => {
  let raw = NaN;
  if (typeof value === "number") {
    raw = value < 1e12 ? value * 1000 : value;
  } else if (value) {
    raw = Date.parse(value);
  }

  if (!Number.isFinite(raw) || raw < MIN_VALID_EPOCH_MS) {
    return { timestamp: new Date().toISOString(), clockSynced: false };
  }
  return { timestamp: new Date(raw).toISOString(), clockSynced: true };
};

const normalizeEventText = (...values) => {
  const value = getFirstDefined(...values);
  if (value === undefined) return "";
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
};

const isTruthyFlag = (value) => {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    return ["1", "TRUE", "YES", "Y", "CRASH", "CRASHED", "DETECTED"].includes(
      value.trim().toUpperCase(),
    );
  }
  return false;
};

const hasExplicitCrashFlag = (data) =>
  isTruthyFlag(data.crash) ||
  isTruthyFlag(data.isCrash) ||
  isTruthyFlag(data.crashDetected) ||
  isTruthyFlag(data.crash_detected) ||
  isTruthyFlag(data.accident) ||
  isTruthyFlag(data.impactDetected) ||
  isTruthyFlag(data.impact_detected);

const isIncidentEvent = (data, eventText, explicitCrashFlag = hasExplicitCrashFlag(data)) => {
  if (
    CLEAR_EVENTS.has(eventText) ||
    eventText.startsWith("NO_CRASH") ||
    eventText.startsWith("NOT_CRASH")
  )
    return false;

  const eventWords = new Set(eventText.split("_").filter(Boolean));
  const eventLooksLikeIncident =
    eventWords.has("CRASH") ||
    eventWords.has("CRASHED") ||
    eventWords.has("ACCIDENT") ||
    eventWords.has("COLLISION") ||
    eventWords.has("IMPACT") ||
    eventWords.has("EMERGENCY") ||
    eventWords.has("SOS");

  return explicitCrashFlag || INCIDENT_EVENTS.has(eventText) || eventLooksLikeIncident;
};

const incidentLabel = (eventText) => {
  if (eventText === "MANUAL") return "Manual Alert";
  if (eventText === "EMERGENCY" || eventText === "SOS" || eventText === "ALERT")
    return "Emergency Alert";
  if (eventText === "ACCIDENT" || eventText === "ACCIDENT_DETECTED" || eventText === "COLLISION")
    return "Accident Detected";
  if (eventText === "IMPACT" || eventText === "IMPACT_DETECTED") return "Impact Detected";
  if (eventText === "CRASH_CONFIRMED") return "Crash Confirmed";
  if (eventText === "CRASH_DETECTED" || eventText === "CRASH" || eventText === "CRASHED")
    return "Crash Detected";
  return "Incident";
};

// Every human-facing name for an alert goes through these two. Never call incidentLabel()
// directly from JSX or from the message path — that is exactly how the tell comes back.
// The mask is written broadly rather than as MANUAL -> CRASH_CONFIRMED because MANUAL is
// only one of the human-triggered aliases the parser accepts; SOS, EMERGENCY and ALERT all
// land on "Emergency Alert" above and would leak the same fact.
const shownIncidentLabel = (eventText) => incidentLabel(shownEventType(eventText));

// Short form for the list badges, which have room for one word.
const shownIncidentBadge = (eventText) =>
  shownEventType(eventText) === "MANUAL" ? "Manual" : "Crash";

const deviceIdFromTopic = (topic) => {
  const parts = topic.split("/");
  return parts.length >= 4 ? parts[3] : null;
};

const safeParse = (raw) => {
  if (typeof raw !== "string") return { data: raw, parsed: true };
  try {
    return { data: JSON.parse(raw), parsed: true };
  } catch {
    return { data: { message: raw }, parsed: false };
  }
};

const normalizeCrashPacket = (raw, topic = "", fallback = DEFAULT_FALLBACK_LOCATION) => {
  let { data, parsed } = safeParse(raw);

  if (!data || typeof data !== "object") {
    data = {};
    parsed = false;
  }

  const deviceId = String(
    getFirstDefined(
      data.deviceId,
      data.device_id,
      data.device,
      data.id,
      data.clientId,
      deviceIdFromTopic(topic),
      "ESP32-UNKNOWN",
    ),
  );
  // GPS lock as reported by the firmware.
  const gpsValid = isTruthyFlag(data.valid) || data.valid === true;

  const reportedLat = parseFiniteNumber(data.lat, data.latitude, data.gps?.lat, data.location?.lat);
  const reportedLng = parseFiniteNumber(
    data.lng,
    data.lon,
    data.longitude,
    data.gps?.lng,
    data.gps?.lon,
    data.location?.lng,
    data.location?.lon,
  );

  // The routing rule: a fix means the sensor's coordinates, no fix means the
  // configured default. The override is unconditional on `valid`, so a packet
  // carrying a real but stale last-known position is still replaced — the raw payload
  // keeps that position for anyone who wants it. The firmware substitutes nothing, so
  // this is the only place the choice is made.
  const useFallback = !gpsValid || reportedLat === null || reportedLng === null;
  const lat = useFallback ? fallback.lat : reportedLat;
  const lng = useFallback ? fallback.lng : reportedLng;

  const { timestamp, clockSynced } = normalizeTimestamp(
    getFirstDefined(data.ts_ms, data.timestamp, data.time, data.ts),
  );
  const explicitCrashFlag = hasExplicitCrashFlag(data);
  const eventText = normalizeEventText(data.event, data.status, data.type, data.code);
  const isIncident = parsed && isIncidentEvent(data, eventText, explicitCrashFlag);
  const normalizedEvent = eventText || (isIncident ? "CRASH_CONFIRMED" : "UNKNOWN");

  return {
    deviceId,
    seq: parseFiniteNumber(data.seq),
    lat,
    lng,
    timestamp,
    clockSynced,
    // When false, lat/lng above are the configured fallback rather than a measurement.
    gpsValid,
    accelG: parseFiniteNumber(data.accel_g, data.accelG),
    ageMs: parseFiniteNumber(data.age_ms, data.ageMs),
    event: normalizedEvent,
    isIncident,
    status: isIncident ? normalizedEvent : normalizedEvent || "ONLINE",
    raw: data,
    topic,
  };
};

const normalizeStatusPacket = (raw, topic = "") => {
  const { data, parsed } = safeParse(raw);
  if (!parsed || !data || typeof data !== "object") return null;

  const deviceId = getFirstDefined(
    data.device,
    data.deviceId,
    data.device_id,
    deviceIdFromTopic(topic),
  );
  if (!deviceId) return null;

  return {
    deviceId: String(deviceId),
    online: isTruthyFlag(data.online) || data.online === true,
    queue: parseFiniteNumber(data.queue),
    dropped: parseFiniteNumber(data.dropped),
    uptimeMs: parseFiniteNumber(data.uptime_ms, data.uptimeMs),
  };
};

// Dedup on the firmware sequence number when available. Falling back to the timestamp
// is only safe once the device clock has synced.
const incidentKey = (incident) =>
  Number.isFinite(incident.seq)
    ? `${incident.deviceId}:${incident.seq}`
    : `${incident.deviceId}:${incident.timestamp}:${incident.event}`;

// The instant an alert's elapsed clock starts, decided exactly once per event key. Three
// separate things force this to be pinned rather than recomputed on each delivery:
//  - an unsynced device publishes ts_ms:0 and normalizeTimestamp() answers "now", so a
//    broker failover or a retained redelivery would silently restart a running timer;
//  - a skewed device clock can put ts_ms in the future, which formatElapsed()'s
//    Math.max(0, ...) renders as a 0:00 frozen until real time catches up;
//  - a reload must not reset it, which is why the value rides along in persisted history.
const computeAlertAnchor = (incident, arrivalMs = Date.now()) => {
  const reported = new Date(incident.timestamp).getTime();
  if (!incident.clockSynced || !Number.isFinite(reported)) return arrivalMs;
  // Clamp forward skew: the clock never starts in the future.
  return Math.min(reported, arrivalMs);
};

// Reading an anchor off a stored record. Entries written before anchors existed fall back
// to the timestamp, which is what the old elapsedFor() used anyway — so restored history
// degrades to the previous behaviour rather than to NaN.
const anchorMsOf = (record) =>
  Number.isFinite(record?.anchorMs) ? record.anchorMs : new Date(record?.timestamp).getTime();

const loadHistory = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    const entries = parsed.slice(0, HISTORY_LIMIT);
    // Restored ids must not collide with ids minted later this session.
    _historyId = entries.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), 0);
    return entries;
  } catch {
    return [];
  }
};

const loadPrefs = () => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
};

const initialTheme = () => {
  const stored = localStorage.getItem("theme");
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
};

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

// Builds popup content as DOM rather than an HTML string. Device IDs arrive from a
// public broker and must never be interpolated into markup.
const buildPopupContent = (title, deviceId, lat, lng, note) => {
  const root = document.createElement("div");
  root.className = "map-popup";

  const heading = document.createElement("strong");
  heading.textContent = title;
  root.appendChild(heading);

  const device = document.createElement("div");
  device.textContent = `Device: ${deviceId}`;
  root.appendChild(device);

  const coords = document.createElement("div");
  coords.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  root.appendChild(coords);

  if (note) {
    const noteEl = document.createElement("div");
    noteEl.className = "map-popup-note";
    noteEl.textContent = note;
    root.appendChild(noteEl);
  }

  return root;
};

// ============================================================
// COMPONENT: Icon
// ============================================================
// Only icons that carry meaning a word cannot are kept. Everything decorative was
// removed along with the Font Awesome dependency, so these are inline and the app
// makes no third-party requests.
const ICON_PATHS = {
  close: "M18 6 6 18M6 6l12 12",
  external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4",
  moon: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z",
  volumeOn: "M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14",
  volumeOff: "M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6",
  fit: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  settings: "M4 7h16M4 17h16M9 4v6M15 14v6",
};

function Icon({ name, size = 16 }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

// ============================================================
// COMPONENT: Toast Notification
// ============================================================
function Toast({ toast, onDismiss }) {
  const [visible, setVisible] = useState(false);
  const [hiding, setHiding] = useState(false);
  const dismissRef = useRef(null);

  const handleDismiss = useCallback(() => {
    setHiding(true);
    setTimeout(() => onDismiss(toast.id), 400);
  }, [onDismiss, toast.id]);

  dismissRef.current = handleDismiss;

  useEffect(() => {
    const showTimer = setTimeout(() => setVisible(true), 30);
    const autoDismiss = setTimeout(() => dismissRef.current?.(), toast.duration || 8000);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(autoDismiss);
    };
  }, [toast.duration]);

  // `critical` is the alarm variant. The default toast is a status message; across a room
  // the two must not look alike.
  const cls = `toast ${toast.type === "success" ? "success" : ""} ${
    toast.severity === "critical" ? "critical" : ""
  } ${visible && !hiding ? "show" : ""} ${hiding ? "hiding" : ""}`;

  return (
    <div className={cls} role="status">
      <span className={`toast-dot ${toast.type === "success" ? "success" : "crash"}`}></span>
      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        {/* Rendered as JSX children, never as HTML: the device ID is attacker-controlled. */}
        <div className="toast-message">
          {toast.deviceId ? (
            <>
              Device <span>{toast.deviceId}</span>
              {toast.detail ? ` — ${toast.detail}` : null}
            </>
          ) : (
            toast.detail
          )}
        </div>
      </div>
      <button className="toast-close" onClick={handleDismiss} aria-label="Dismiss notification">
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

function ToastContainer({ toasts, onDismiss }) {
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

// ============================================================
// MAIN APP COMPONENT
// ============================================================
export default function App() {
  // --- Theme ---
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme((prev) => (prev === "dark" ? "light" : "dark"));

  // --- Connection ---
  const [connectionState, setConnectionState] = useState("connecting");
  const [brokerUrl, setBrokerUrl] = useState(MQTT_BROKER_URLS[0] || "");
  const mqttClientRef = useRef(null);

  // --- Data ---
  const [incidents, setIncidents] = useState({});
  const [devices, setDevices] = useState({});
  const [crashHistory, setCrashHistory] = useState(loadHistory);

  // --- Selection / navigation ---
  const [activeTab, setActiveTab] = useState("active");
  const [selectedIncidentId, setSelectedIncidentId] = useState(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

  // --- Phone layout ---
  // Render-time only. The MQTT message path must call matchesMobile() directly instead:
  // that path captures its first closure, so a state value read there would go stale.
  const isMobile = useSyncExternalStore(subscribeToMobile, matchesMobile, () => false);

  // Two snap positions, never a continuous height — a sheet that resizes every frame would
  // move the map's visible centre with it, and focusMapOnAlert's padding needs exactly one
  // value to be right about.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetDragPx, setSheetDragPx] = useState(null); // null except during a drag
  const sheetDragRef = useRef(null);
  const sheetRef = useRef(null);

  // --- Alerts ---
  const initialPrefs = useMemo(loadPrefs, []);
  const [muted, setMuted] = useState(() => initialPrefs.muted === true);
  // Inverted from the old `audioUnlocked`: this is only set once an alarm has actually
  // failed to make a sound, which is the only moment worth telling the operator about.
  const [audioBlocked, setAudioBlocked] = useState(false);
  const mutedRef = useRef(muted);
  const audioContextRef = useRef(null);

  // The newest live alert nobody has looked at yet. Every prominence cue — vignette,
  // banner, marker halo, flashing title — reads this one value, so "is something screaming
  // right now?" has a single answer instead of four components each deciding for itself.
  const [activeAlert, setActiveAlert] = useState(null); // { key, deviceId, event, at }

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  // --- Settings ---
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Where an alert without a GPS fix is placed. Sole owner of that decision — the
  // firmware forwards coordinates untouched.
  const [fallbackLocation, setFallbackLocation] = useState(() => {
    const { fallbackLat, fallbackLng } = initialPrefs;
    return isValidLat(fallbackLat) && isValidLng(fallbackLng)
      ? { lat: fallbackLat, lng: fallbackLng }
      : DEFAULT_FALLBACK_LOCATION;
  });

  const [demoDeviceId, setDemoDeviceId] = useState(
    () => sanitizeDeviceId(initialPrefs.demoDeviceId) || DEFAULT_DEMO_DEVICE_ID,
  );
  const [demoAccelG, setDemoAccelG] = useState(() =>
    Number.isFinite(initialPrefs.demoAccelG) ? initialPrefs.demoAccelG : DEFAULT_DEMO_ACCEL_G,
  );

  // One writer for the whole preferences object. Several effects each doing a
  // read-modify-write on the same key would race and silently drop a field.
  useEffect(() => {
    try {
      localStorage.setItem(
        PREFS_STORAGE_KEY,
        JSON.stringify({
          muted,
          fallbackLat: fallbackLocation.lat,
          fallbackLng: fallbackLocation.lng,
          demoDeviceId,
          demoAccelG,
        }),
      );
    } catch {
      /* storage unavailable — preferences stay for this session only */
    }
    // A stale demoEvent left in an existing prefs blob needs no migration: it is simply
    // never read again, and this write drops it.
  }, [muted, fallbackLocation, demoDeviceId, demoAccelG]);

  // --- Toasts ---
  const [toasts, setToasts] = useState([]);

  // --- Live clock driving every elapsed readout (one interval, not one per card) ---
  const [now, setNow] = useState(() => Date.now());
  const incidentCount = Object.keys(incidents).length;

  useEffect(() => {
    if (incidentCount === 0) return undefined;
    // The interval's first tick is a whole second away, and while there were no incidents
    // nothing was refreshing `now` at all. Without this the first painted frame after an
    // alert lands measures against a clock that can be minutes stale.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [incidentCount]);

  // --- Map ---
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersRef = useRef({});
  const historyMarkersRef = useRef({});

  // Seeded from restored history so a retained event is not re-announced on reload.
  const processedCrashEventsRef = useRef(null);
  if (processedCrashEventsRef.current === null) {
    processedCrashEventsRef.current = new Set(
      crashHistory.map((entry) => entry.key).filter(Boolean),
    );
  }

  // key -> anchor ms, seeded from restored history for the same reason the set above is:
  // a running timer must survive a reload, and a retained redelivery must read back the
  // anchor already decided rather than mint a new one.
  const alertAnchorsRef = useRef(null);
  if (alertAnchorsRef.current === null) {
    alertAnchorsRef.current = new Map(
      crashHistory
        .filter((entry) => entry.key && Number.isFinite(entry.anchorMs))
        .map((entry) => [entry.key, entry.anchorMs]),
    );
  }

  // Keys this dashboard has already sounded locally, waiting for their own echo to come
  // back off the broker. Drained by the message path, which uses Set.delete() as a
  // test-and-consume.
  const locallySoundedKeysRef = useRef(new Set());

  // --- Misc UI ---
  const [copied, setCopied] = useState(false);
  const [displayCoords, setDisplayCoords] = useState({ lat: null, lng: null });
  const [announcement, setAnnouncement] = useState("");

  // =======================
  // PERSISTENCE
  // =======================
  useEffect(() => {
    try {
      localStorage.setItem(
        HISTORY_STORAGE_KEY,
        JSON.stringify(crashHistory.slice(0, HISTORY_LIMIT)),
      );
    } catch {
      /* storage full or unavailable — history stays in memory only */
    }
  }, [crashHistory]);

  // =======================
  // TOAST HELPERS
  // =======================
  const addToast = useCallback((toast) => {
    setToasts((prev) => [...prev, { ...toast, id: nextToastId() }]);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // =======================
  // ELAPSED ANCHORS
  // =======================
  // First delivery of a key wins. Every later delivery of the same event — retained
  // replay, broker failover, reconnect burst — reads back the value already stored, which
  // is the entire point: the anchor must not move.
  const anchorFor = useCallback((key, incident) => {
    const anchors = alertAnchorsRef.current;
    const existing = anchors.get(key);
    if (Number.isFinite(existing)) return existing;

    const anchorMs = computeAlertAnchor(incident);
    anchors.set(key, anchorMs);
    // FIFO prune rather than the wholesale reset processedCrashEventsRef does: a Map keeps
    // insertion order, and the anchors that fall off the front already live on their
    // persisted history entries.
    while (anchors.size > 500) anchors.delete(anchors.keys().next().value);
    return anchorMs;
  }, []);

  // =======================
  // ALERTS
  // =======================
  const playCrashAlertSound = useCallback(() => {
    if (mutedRef.current) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      const context = audioContextRef.current || new AudioCtx();
      audioContextRef.current = context;

      const startTone = (startAt, frequency) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();

        oscillator.type = "sawtooth";
        oscillator.frequency.setValueAtTime(frequency, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(0.18, startAt + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.24);

        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + 0.26);
      };

      const schedule = () => {
        const at = context.currentTime;
        startTone(at, 880);
        startTone(at + 0.32, 660);
        startTone(at + 0.64, 880);
      };

      if (context.state === "suspended") {
        context
          .resume()
          .then(() => {
            schedule();
            setAudioBlocked(false);
          })
          // The alarm just failed to make a sound. Nothing here can fix that without a
          // user gesture, so record it and let the nav surface a one-tap recovery.
          .catch(() => setAudioBlocked(true));
      } else {
        schedule();
      }
    } catch (err) {
      console.warn("[ResQPack] Unable to play alert sound:", err);
    }
  }, []);

  // Ensures the AudioContext exists and is running. Guarded on the ref so StrictMode's
  // double mount cannot leave a second context orphaned in the suspended state.
  const ensureAudioContext = useCallback(() => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      const context = audioContextRef.current || new AudioCtx();
      audioContextRef.current = context;
      if (context.state === "suspended") {
        context
          .resume()
          .then(() => setAudioBlocked(false))
          .catch(() => {});
      }
      return context;
    } catch (err) {
      console.warn("[ResQPack] Could not start audio:", err);
      return null;
    }
  }, []);

  // Only asked while still "default" — re-asking a denied permission does nothing but burn
  // a gesture. Firefox and Safari reject the call outright outside one, which is why this
  // has to tolerate a rejected promise rather than assume it resolves.
  const requestNotifyPermission = useCallback(async () => {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    try {
      await Notification.requestPermission();
    } catch {
      /* gesture required — the unlock listeners below will try again on the first one */
    }
  }, []);

  // Alerts arm themselves. The old "Enable alerts" button left an unattended dashboard
  // silent until somebody noticed a button, which is precisely backwards for an alarm.
  // Two attempts: on mount, which succeeds when the browser already considers this page
  // engaged (a reload of a tab the operator has been using); and on the first interaction
  // of any kind, whatever it happens to be.
  useEffect(() => {
    ensureAudioContext();
    requestNotifyPermission();

    // One shared object: removeEventListener must be passed the identical `capture` value
    // it was added with, or the listener leaks.
    const options = { once: true, passive: true, capture: true };
    const unlock = () => {
      // Any one of the three firing disarms the other two. The handler is idempotent, but
      // leaving them armed means a later keystroke redoes work that is already done.
      window.removeEventListener("pointerdown", unlock, options);
      window.removeEventListener("keydown", unlock, options);
      window.removeEventListener("touchstart", unlock, options);
      ensureAudioContext();
      requestNotifyPermission();
    };

    window.addEventListener("pointerdown", unlock, options);
    window.addEventListener("keydown", unlock, options);
    window.addEventListener("touchstart", unlock, options);
    return unlock;
  }, [ensureAudioContext, requestNotifyPermission]);

  const notifyIncident = useCallback((incident) => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (!document.hidden) return;
    try {
      // Tagged by device so a repeat alert replaces the previous one rather than stacking.
      const notification = new Notification(shownIncidentLabel(incident.event), {
        body: `${incident.deviceId} — ${incident.lat.toFixed(5)}, ${incident.lng.toFixed(5)}`,
        tag: incident.deviceId,
        // The operator is by definition elsewhere when this fires. A crash notification
        // that auto-dismisses after five seconds is one they will never see. (Ignored by
        // Safari; harmless there.)
        requireInteraction: true,
      });
      notification.onclick = () => {
        window.focus();
        setActiveTab("active");
        setSelectedIncidentId(incident.deviceId);
        notification.close();
      };
    } catch (err) {
      console.warn("[ResQPack] Could not raise notification:", err);
    }
  }, []);

  // =======================
  // MAP
  // =======================
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return undefined;

    const map = L.map(mapRef.current, {
      center: [DEFAULT_MAP_CENTER.lat, DEFAULT_MAP_CENTER.lng],
      zoom: 13,
      zoomControl: false,
    });

    L.control.zoom({ position: "topright" }).addTo(map);

    // No dragstart handler. Panning used to switch the camera to manual, because a new
    // incident could steal it at any moment. The camera now only ever moves for a new
    // alert, an explicit selection, or a history pin — the first is the reason the
    // operator is looking at this screen at all, and the other two they asked for.
    mapInstanceRef.current = map;

    // Leaflet caches the container size, so the tiles go blank when the layout
    // reflows (breakpoint change, phone rotation) until it is told to re-measure.
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(mapRef.current);

    return () => {
      observer.disconnect();
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // Standard OSM tiles, which need no API key and no account. CARTO's basemaps were
  // nicer under a near-monochrome UI, but they now return a watermarked placeholder to
  // unauthenticated callers, so every tile read "API KEY REQUIRED". Dark mode inverts
  // these in CSS instead (see .leaflet-tile-pane in index.css), which keeps the map
  // quiet underneath the interface without taking on a keyed dependency.
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return undefined;

    const layer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    });
    layer.addTo(map);

    return () => map.removeLayer(layer);
  }, []);

  const flyTo = useCallback((lat, lng, zoom = 16) => {
    const map = mapInstanceRef.current;
    if (!map) return;
    if (prefersReducedMotion()) {
      map.setView([lat, lng], zoom);
    } else {
      map.flyTo([lat, lng], zoom, { duration: 1.2 });
    }
  }, []);

  // Camera move for a new alert. On the phone the sheet covers the bottom of the map, so a
  // centred flyTo would drop the marker underneath it. flyToBounds is the only Leaflet
  // entry point that takes padding, and a degenerate one-point bounds plus maxZoom gives
  // the same framing as flyTo with the sheet accounted for.
  const focusMapOnAlert = useCallback(
    (lat, lng) => {
      const map = mapInstanceRef.current;
      if (!map) return;

      if (!matchesMobile()) {
        flyTo(lat, lng, ALERT_FOCUS_ZOOM);
        return;
      }

      const bounds = L.latLngBounds([lat, lng], [lat, lng]);
      const options = {
        maxZoom: ALERT_FOCUS_ZOOM,
        paddingBottomRight: [0, MOBILE_SHEET_PEEK_PX],
      };
      if (prefersReducedMotion()) map.fitBounds(bounds, options);
      else map.flyToBounds(bounds, { ...options, duration: 1.2 });
    },
    [flyTo],
  );

  const createIcon = (type, unlocked = false) => {
    const classMap = {
      live: "marker-live",
      history: "marker-history",
      resolved: "marker-resolved",
    };
    return L.divIcon({
      className: "custom-marker",
      // Static template — classMap keys are internal literals and nothing from the payload
      // is interpolated, so this does not reopen the XSS hole popups are careful about.
      // The halo rides on every marker; only .map-container.alerting animates it, so the
      // alarm needs no Leaflet lifecycle plumbing.
      html: `<div class="${classMap[type]}${unlocked ? " unlocked" : ""}"><span class="marker-ring"></span></div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
  };

  const updateLiveMarker = useCallback((incident) => {
    const map = mapInstanceRef.current;
    if (!map) return;

    const { deviceId, lat, lng } = incident;
    const locked = showsGpsLock(incident);
    const note = locked ? null : "No GPS lock — approximate position";
    const content = buildPopupContent(shownIncidentLabel(incident.event), deviceId, lat, lng, note);

    const existing = markersRef.current[deviceId];
    if (existing) {
      existing.setLatLng([lat, lng]);
      existing.setIcon(createIcon("live", !locked));
      existing.setPopupContent(content);
      return;
    }

    markersRef.current[deviceId] = L.marker([lat, lng], { icon: createIcon("live", !locked) })
      .addTo(map)
      .bindPopup(content);
  }, []);

  const removeLiveMarker = (deviceId) => {
    const map = mapInstanceRef.current;
    if (!map || !markersRef.current[deviceId]) return;
    map.removeLayer(markersRef.current[deviceId]);
    delete markersRef.current[deviceId];
  };

  const showHistoryMarker = (entry) => {
    const map = mapInstanceRef.current;
    if (!map) return;

    Object.values(historyMarkersRef.current).forEach((marker) => map.removeLayer(marker));
    historyMarkersRef.current = {};

    const type = entry.status === "RESOLVED" ? "resolved" : "history";
    const title = entry.status === "RESOLVED" ? "Resolved" : shownIncidentLabel(entry.status);
    const locked = showsGpsLock(entry);
    const note = locked ? null : "No GPS lock — approximate position";

    historyMarkersRef.current[entry.id] = L.marker([entry.lat, entry.lng], {
      icon: createIcon(type, !locked),
    })
      .addTo(map)
      .bindPopup(buildPopupContent(title, entry.deviceId, entry.lat, entry.lng, note))
      .openPopup();

    flyTo(entry.lat, entry.lng, 17);
  };

  const fitAllIncidents = () => {
    const map = mapInstanceRef.current;
    const points = Object.values(incidents).map((inc) => [inc.lat, inc.lng]);
    if (!map || points.length === 0) return;
    map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 16 });
  };

  // =======================
  // INCOMING MQTT DATA
  // =======================
  const handleStatusMessage = useCallback((raw, topic) => {
    const status = normalizeStatusPacket(raw, topic);
    if (!status) return;

    setDevices((prev) => ({
      ...prev,
      [status.deviceId]: {
        online: status.online,
        lastSeen: Date.now(),
        queue: status.queue,
        dropped: status.dropped,
        uptimeMs: status.uptimeMs,
      },
    }));
  }, []);

  const handleIncidentMessage = useCallback(
    (raw, topic, isRetained) => {
      const incident = normalizeCrashPacket(raw, topic, fallbackLocation);
      const { deviceId, lat, lng } = incident;

      if (!incident.isIncident) return;

      const key = incidentKey(incident);
      const alreadyProcessed = processedCrashEventsRef.current.has(key);
      const anchorMs = anchorFor(key, incident);

      setIncidents((prev) => ({
        ...prev,
        [deviceId]: { ...incident, key, anchorMs, restored: isRetained },
      }));
      setDevices((prev) => ({
        ...prev,
        [deviceId]: { ...(prev[deviceId] || { online: true }), lastSeen: Date.now() },
      }));
      setDisplayCoords({ lat, lng });

      if (!alreadyProcessed) {
        processedCrashEventsRef.current.add(key);
        if (processedCrashEventsRef.current.size > 500) {
          processedCrashEventsRef.current = new Set([key]);
        }

        setCrashHistory((prev) =>
          [
            {
              id: nextHistoryId(),
              key,
              deviceId,
              lat,
              lng,
              timestamp: incident.timestamp,
              anchorMs,
              clockSynced: incident.clockSynced,
              gpsValid: incident.gpsValid,
              accelG: incident.accelG,
              status: incident.event,
              restored: isRetained,
            },
            ...prev,
          ].slice(0, HISTORY_LIMIT),
        );

        // A retained message is the broker replaying an old event to a newly connected
        // dashboard. It belongs in the lists, but must not raise an alarm.
        if (!isRetained) {
          // Second and subsequent alerts do not change incidentCount, so the tick effect
          // does not re-run and `now` would be up to a second behind on this first paint.
          setNow(Date.now());
          addToast({
            type: "crash",
            severity: "critical",
            title: shownIncidentLabel(incident.event),
            deviceId,
            detail: formatTime(incident.timestamp),
            duration: 12000,
          });
          setAnnouncement(`${shownIncidentLabel(incident.event)} from device ${deviceId}`);
          // delete() is the test: true means this dashboard published the event and has
          // already sounded it locally, so the echo must stay silent.
          if (!locallySoundedKeysRef.current.delete(key)) playCrashAlertSound();
          notifyIncident(incident);
        }
      }

      updateLiveMarker(incident);

      if (isRetained) {
        // A replay is the broker catching a newly connected dashboard up. It populates the
        // lists silently and never touches the camera. It does claim the selection, but
        // only when nothing is selected — showing "No incident selected" beside a real
        // unresolved alert is worse. The functional updater means a reconnect burst cannot
        // yank the panel away from an incident the operator is already working.
        setSelectedIncidentId((prev) => (prev === null ? deviceId : prev));
        return;
      }

      // Unconditional from here down. There is no manual camera mode any more: the newest
      // live alert takes the tab, the selection and the map, so "Resolve incident" is one
      // click away the instant it lands.
      setActiveAlert({ key, deviceId, event: incident.event, at: Date.now() });
      // On the phone the alert belongs on the map with the sheet up, not on a list that
      // hides the map. matchesMobile() rather than component state: this runs inside the
      // MQTT message path, where a captured value is the exact stale-read hazard the
      // handlerRef/mutedRef pattern exists to prevent.
      setActiveTab(matchesMobile() ? "map" : "active");
      // Deliberately not opened to full height. The peek state already carries the elapsed
      // timer and the Resolve button, and leaving the sheet down keeps the map — which
      // this alert just zoomed to the incident — visible behind it.
      setSelectedIncidentId(deviceId);
      focusMapOnAlert(lat, lng);
    },
    [
      addToast,
      anchorFor,
      fallbackLocation,
      focusMapOnAlert,
      notifyIncident,
      playCrashAlertSound,
      updateLiveMarker,
    ],
  );

  const handleIncomingData = useCallback(
    (raw, topic = "", isRetained = false) => {
      if (topic.endsWith("/status")) {
        handleStatusMessage(raw, topic);
        return;
      }
      handleIncidentMessage(raw, topic, isRetained);
    },
    [handleIncidentMessage, handleStatusMessage],
  );

  // The MQTT effect below runs once and would otherwise capture the first render's
  // handler forever. Routing through a ref keeps it current.
  const handlerRef = useRef(handleIncomingData);
  useEffect(() => {
    handlerRef.current = handleIncomingData;
  }, [handleIncomingData]);

  // =======================
  // MQTT CONNECTION
  // =======================
  useEffect(() => {
    let stopped = false;
    let reconnectTimer = null;

    const connectToBroker = (brokerIndex = 0) => {
      if (stopped || MQTT_BROKER_URLS.length === 0) return;

      const normalizedIndex = brokerIndex % MQTT_BROKER_URLS.length;
      const nextBrokerUrl = MQTT_BROKER_URLS[normalizedIndex];
      let opened = false;
      let reconnectScheduled = false;

      setBrokerUrl(nextBrokerUrl);
      setConnectionState("connecting");

      const client = mqtt.connect(nextBrokerUrl, {
        clientId: `web_client_${Math.random().toString(16).slice(2, 10)}`,
        clean: true,
        connectTimeout: 4000,
        reconnectPeriod: 0,
        keepalive: 30,
        protocolVersion: 4,
      });

      mqttClientRef.current = client;

      const scheduleReconnect = (nextIndex) => {
        if (stopped || reconnectScheduled) return;
        reconnectScheduled = true;
        setConnectionState("connecting");
        client.end(true);
        reconnectTimer = window.setTimeout(() => connectToBroker(nextIndex), 1000);
      };

      client.on("connect", () => {
        opened = true;
        console.log(`[ResQPack] MQTT connected: ${nextBrokerUrl}`);
        setConnectionState("connected");

        client.subscribe(MQTT_TOPIC_FILTERS, { qos: 0 }, (err) => {
          if (err) {
            console.warn("[ResQPack] MQTT subscribe failed:", err);
            scheduleReconnect(normalizedIndex + 1);
            return;
          }
          console.log(`[ResQPack] MQTT subscribed: ${MQTT_TOPIC_FILTERS.join(", ")}`);
        });
      });

      client.on("message", (topic, payload, packet) => {
        handlerRef.current(payload.toString(), topic, packet?.retain === true);
      });

      client.on("close", () => {
        if (!stopped) scheduleReconnect(opened ? normalizedIndex : normalizedIndex + 1);
      });

      client.on("offline", () => setConnectionState("disconnected"));
      client.on("error", (err) => {
        console.warn(`[ResQPack] MQTT error on ${nextBrokerUrl}:`, err);
        if (!opened) scheduleReconnect(normalizedIndex + 1);
      });
    };

    connectToBroker(0);

    return () => {
      stopped = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      mqttClientRef.current?.end(true);
      mqttClientRef.current = null;
    };
  }, []);

  // =======================
  // DEVICE STALENESS SWEEP
  // =======================
  useEffect(() => {
    const id = setInterval(() => {
      setDevices((prev) => {
        let changed = false;
        const next = {};
        Object.entries(prev).forEach(([deviceId, device]) => {
          if (device.online && Date.now() - device.lastSeen > DEVICE_STALE_MS) {
            changed = true;
            next[deviceId] = { ...device, online: false, stale: true };
          } else {
            next[deviceId] = device;
          }
        });
        return changed ? next : prev;
      });
      setNow(Date.now());
    }, DEVICE_SWEEP_MS);
    return () => clearInterval(id);
  }, []);

  // =======================
  // ACTIONS
  // =======================
  // Acknowledging silences the visual alarm; it does not resolve anything. Looking at the
  // incident counts — opening its card, or pressing the banner's own button — is the
  // operator telling the dashboard they have seen it.
  const acknowledgeAlert = useCallback(() => setActiveAlert(null), []);

  // If the incident disappears (resolved, or replaced by a newer event under a different
  // key) there is nothing left to acknowledge.
  useEffect(() => {
    if (activeAlert && !incidents[activeAlert.deviceId]) setActiveAlert(null);
  }, [incidents, activeAlert]);

  const selectIncident = (deviceId) => {
    const incident = incidents[deviceId];
    setSelectedIncidentId(deviceId);
    setSheetOpen(true);
    acknowledgeAlert();
    if (incident) {
      setDisplayCoords({ lat: incident.lat, lng: incident.lng });
      flyTo(incident.lat, incident.lng);
    }
  };

  const resolveIncident = (deviceId) => {
    const incident = incidents[deviceId];
    if (!incident) return;

    setIncidents((prev) => {
      const next = { ...prev };
      delete next[deviceId];
      return next;
    });

    setCrashHistory((prev) =>
      [
        {
          id: nextHistoryId(),
          key: `${deviceId}:resolved:${Date.now()}`,
          deviceId,
          lat: incident.lat,
          lng: incident.lng,
          timestamp: new Date().toISOString(),
          clockSynced: true,
          gpsValid: incident.gpsValid,
          status: "RESOLVED",
        },
        ...prev,
      ].slice(0, HISTORY_LIMIT),
    );

    if (selectedIncidentId === deviceId) setSelectedIncidentId(null);
    if (activeAlert?.deviceId === deviceId) acknowledgeAlert();
    setSheetOpen(false);
    removeLiveMarker(deviceId);

    addToast({
      type: "success",
      title: "Incident resolved",
      deviceId,
      detail: "marked as resolved",
      duration: 4000,
    });
  };

  // =======================
  // SETTINGS
  // =======================
  const [latInput, setLatInput] = useState(() => String(fallbackLocation.lat));
  const [lngInput, setLngInput] = useState(() => String(fallbackLocation.lng));
  const [locationError, setLocationError] = useState("");

  // Re-seed the draft from committed state each time the dialog opens, so abandoning
  // a half-typed edit does not leave it waiting in the fields next time.
  useEffect(() => {
    if (!settingsOpen) return;
    setLatInput(String(fallbackLocation.lat));
    setLngInput(String(fallbackLocation.lng));
    setLocationError("");
  }, [settingsOpen, fallbackLocation]);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen]);

  const commitFallbackLocation = (lat, lng) => {
    setLocationError("");
    setFallbackLocation({ lat, lng });
    setLatInput(String(lat));
    setLngInput(String(lng));
    addToast({
      type: "success",
      title: "Default location saved",
      detail: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      duration: 4000,
    });
  };

  const saveFallbackLocation = () => {
    const lat = Number(latInput.trim());
    const lng = Number(lngInput.trim());
    // Number("") is 0, so an empty field would otherwise save silently as the equator.
    if (latInput.trim() === "" || lngInput.trim() === "" || !isValidLat(lat) || !isValidLng(lng)) {
      setLocationError("Latitude must be between −90 and 90, longitude between −180 and 180.");
      return;
    }
    commitFallbackLocation(lat, lng);
  };

  const showFallbackOnMap = () => {
    setDisplayCoords({ lat: fallbackLocation.lat, lng: fallbackLocation.lng });
    flyTo(fallbackLocation.lat, fallbackLocation.lng, 16);
    setSettingsOpen(false);
  };

  // =======================
  // DEMO MODE
  // =======================
  // Seeded from the clock so simulated events cannot collide with a real device's low
  // sequence numbers, and so each press is a distinct incident under incidentKey().
  const demoSeqRef = useRef(Date.now() % 1000000);

  const sendDemoAlert = () => {
    const client = mqttClientRef.current;
    const deviceId = sanitizeDeviceId(demoDeviceId);

    if (!client || connectionState !== "connected") {
      addToast({
        type: "success",
        title: "Not connected",
        detail: "Connect to the broker before sending a simulated alert.",
        duration: 5000,
      });
      return;
    }

    if (!deviceId) {
      setSettingsOpen(true);
      addToast({
        type: "success",
        title: "Demo device ID required",
        detail: "Use letters, numbers, hyphens or underscores.",
        duration: 5000,
      });
      return;
    }

    const seq = ++demoSeqRef.current;
    // Built through incidentKey() rather than by string concatenation, so it can never
    // drift from the key handleIncidentMessage will compute for the echo.
    const localKey = incidentKey({ deviceId, seq });

    // Deliberately identical in shape to buildEventJson() on the ESP32, published with
    // valid=0 and no coordinates. The fallback routing above then supplies the position,
    // so this exercises that path rather than bypassing it.
    const payload = {
      device: deviceId,
      seq,
      event: DEMO_EVENT_TYPE,
      valid: 0,
      lat: 0,
      lon: 0,
      ts_ms: Date.now(),
      received_ms: Math.round(performance.now()),
      age_ms: 0,
      accel_g: Number.isFinite(demoAccelG) ? demoAccelG : DEFAULT_DEMO_ACCEL_G,
    };

    // Sounded here, not when the event comes back. The round trip is ~200 ms on a good
    // hotspot and unbounded on a bad one, and a siren that lags the press reads as a broken
    // dashboard. Everything else — toast, banner, camera, history — still waits for the
    // echo, because the echo is the normalized incident and this is not.
    locallySoundedKeysRef.current.add(localKey);
    playCrashAlertSound();
    // If the publish never lands nothing will ever consume the key. Drop it after a
    // generous round trip so a later replay of the same seq is not silenced.
    window.setTimeout(() => locallySoundedKeysRef.current.delete(localKey), 15000);

    // Not retained: this is a public broker, and a retained fake would stick on the
    // topic and re-alarm every dashboard that connects afterwards.
    client.publish(`${MQTT_TOPIC_PREFIX}/${deviceId}/events`, JSON.stringify(payload), {
      qos: 1,
      retain: false,
    });

    setSettingsOpen(false);
  };

  const copyCoordinates = () => {
    if (displayCoords.lat === null) return;
    navigator.clipboard
      .writeText(`${displayCoords.lat.toFixed(6)}, ${displayCoords.lng.toFixed(6)}`)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  // =======================
  // DERIVED
  // =======================
  const query = searchQuery.trim().toLowerCase();
  const matches = (value) => !query || String(value).toLowerCase().includes(query);

  const filteredIncidents = Object.values(incidents).filter((inc) => matches(inc.deviceId));
  const deviceEntries = Object.entries(devices)
    .filter(([deviceId]) => matches(deviceId))
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen);
  const filteredHistory = crashHistory.filter((entry) => matches(entry.deviceId));

  const selectedIncident = selectedIncidentId ? incidents[selectedIncidentId] : null;
  const hasActiveIncidents = incidentCount > 0;
  const onlineDeviceCount = Object.values(devices).filter((device) => device.online).length;

  // The bottom bar and the desktop sidebar tabs are the same selection with one extra
  // destination. One state means an alert that forces the alert list also brings the phone
  // to the right place, with no second code path to forget to update. Desktop has no map
  // tab, so it falls back to the alert list.
  const sidebarTab = activeTab === "map" ? "active" : activeTab;

  const connectionLabel =
    connectionState === "connected"
      ? "Connected"
      : connectionState === "connecting"
        ? "Connecting…"
        : "Disconnected";

  // Reads the pinned anchor, never the timestamp: the timestamp is recomputed on every
  // delivery for an unsynced device and would restart the clock.
  const elapsedFor = (incident) => now - anchorMsOf(incident);

  const tabs = [
    {
      id: "active",
      label: "Active",
      count: filteredIncidents.length,
      critical: hasActiveIncidents,
    },
    { id: "devices", label: "Devices", count: deviceEntries.length, critical: false },
    { id: "history", label: "History", count: filteredHistory.length, critical: false },
  ];

  // =======================
  // ALERT SHEET (phone only)
  // =======================
  // The gesture surface is the grabber alone, not the whole panel: the panel body is its
  // own scroll container, and dragging both is the nested-scroll bug that makes sheets
  // feel broken on iOS. setPointerCapture keeps tracking a drag that leaves the element.
  const sheetTravelPx = () => {
    const panel = sheetRef.current;
    return panel ? Math.max(0, panel.offsetHeight - MOBILE_SHEET_PEEK_PX) : 0;
  };

  const onSheetPointerDown = (event) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    sheetDragRef.current = { startY: event.clientY, startOpen: sheetOpen };
    setSheetDragPx(sheetOpen ? 0 : sheetTravelPx());
  };

  const onSheetPointerMove = (event) => {
    const drag = sheetDragRef.current;
    if (!drag) return;
    const travel = sheetTravelPx();
    // 0 is fully open, `travel` is the resting peek. Clamped so the sheet can be dragged
    // to neither side of those two.
    const offset = (drag.startOpen ? 0 : travel) + (event.clientY - drag.startY);
    setSheetDragPx(Math.min(travel, Math.max(0, offset)));
  };

  const onSheetPointerUp = (event) => {
    const drag = sheetDragRef.current;
    if (!drag) return;
    const moved = event.clientY - drag.startY;
    // Under 48px is a tap that wandered, not a drag — treat it as a toggle.
    setSheetOpen(Math.abs(moved) < 48 ? !drag.startOpen : moved < 0);
    sheetDragRef.current = null;
    setSheetDragPx(null);
  };

  // A backgrounded tab is the case this dashboard is actually used in, and an alternating
  // title is the one attention signal that survives it with audio still blocked.
  useEffect(() => {
    if (!activeAlert) return undefined;

    // Sliced so a hostile 48-character device ID cannot fill the whole tab strip. This is
    // a string assignment, not markup, so it cannot execute — but it can still shout.
    const label = `${ALERT_TITLE_PREFIX}${String(activeAlert.deviceId).slice(0, 32)}`;

    // Reduced motion asks for no flicker, so the title states the alarm and holds still.
    if (prefersReducedMotion()) {
      document.title = label;
      return () => {
        document.title = BASE_DOCUMENT_TITLE;
      };
    }

    let on = false;
    const paint = () => {
      on = !on;
      document.title = on ? label : BASE_DOCUMENT_TITLE;
    };
    paint();
    const id = setInterval(paint, 1000);
    return () => {
      clearInterval(id);
      document.title = BASE_DOCUMENT_TITLE;
    };
  }, [activeAlert]);

  // =======================
  // RENDER
  // =======================
  return (
    <div className="dashboard-root">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {/* Page-level alarm. pointer-events:none is load-bearing — this covers the Resolve
          button. aria-hidden because the live region below already says it out loud. */}
      {activeAlert && <div className="alert-vignette" aria-hidden="true" />}

      <div className="sr-only" role="status" aria-live="assertive">
        {announcement}
      </div>

      {/* ===== SETTINGS ===== */}
      {settingsOpen && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSettingsOpen(false);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="modal-header">
              <h3 id="settings-title">Settings</h3>
              <button
                className="modal-close"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close settings"
              >
                <Icon name="close" size={14} />
              </button>
            </div>

            <div className="modal-body">
              <section className="modal-section">
                <h4>Default location</h4>
                <p className="modal-hint">
                  Where an alert is placed when the vest has no satellite fix. The device reports no
                  position in that case, so this is what gets shown.
                </p>

                <div className="field-row">
                  <label className="field">
                    <span>Latitude</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={latInput}
                      onChange={(e) => setLatInput(e.target.value)}
                      aria-invalid={locationError !== ""}
                    />
                  </label>
                  <label className="field">
                    <span>Longitude</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={lngInput}
                      onChange={(e) => setLngInput(e.target.value)}
                      aria-invalid={locationError !== ""}
                    />
                  </label>
                </div>

                {locationError && (
                  <p className="field-error" role="alert">
                    {locationError}
                  </p>
                )}

                <div className="modal-actions">
                  <button className="action-btn primary" onClick={saveFallbackLocation}>
                    Save location
                  </button>
                  <button className="action-btn" onClick={showFallbackOnMap}>
                    Show on map
                  </button>
                  <button
                    className="action-btn"
                    onClick={() =>
                      commitFallbackLocation(
                        DEFAULT_FALLBACK_LOCATION.lat,
                        DEFAULT_FALLBACK_LOCATION.lng,
                      )
                    }
                  >
                    Reset
                  </button>
                </div>
              </section>

              <section className="modal-section">
                <h4>Demo</h4>
                <p className="modal-hint">
                  Publishes a simulated alert to the broker so you can see how one renders. It
                  carries no position, so it lands on the default location above. Not retained — it
                  will not reappear after a reload.
                </p>

                <div className="field-row">
                  <label className="field">
                    <span>Device ID</span>
                    <input
                      type="text"
                      value={demoDeviceId}
                      onChange={(e) => setDemoDeviceId(sanitizeDeviceId(e.target.value))}
                    />
                  </label>
                  <label className="field narrow">
                    <span>Impact</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={demoAccelG}
                      onChange={(e) => setDemoAccelG(Number(e.target.value))}
                    />
                  </label>
                </div>

                <div className="modal-actions">
                  <button
                    className="action-btn primary"
                    onClick={sendDemoAlert}
                    disabled={connectionState !== "connected"}
                  >
                    Send simulated alert
                  </button>
                </div>

                {connectionState !== "connected" && (
                  <p className="modal-hint">Waiting for the broker connection.</p>
                )}
              </section>
            </div>
          </div>
        </div>
      )}

      {/* ===== TOP NAV ===== */}
      <nav className="top-nav">
        <div className="top-nav-brand">
          <span className="brand-title">ResQPack</span>
        </div>

        <div className="top-nav-actions">
          <div
            className={`connection-indicator ${connectionState}`}
            title={`MQTT broker: ${brokerUrl || "not configured"}\nTopics: ${MQTT_TOPIC_FILTERS.join(", ")}`}
          >
            <span className="connection-dot"></span>
            {connectionLabel}
          </div>

          {/* Only appears once an alarm has actually failed to sound — alerts otherwise arm
              themselves on load or on the first interaction. The click is itself the
              gesture that fixes it, and the test tone confirms. */}
          {audioBlocked && (
            <button
              className="nav-btn nav-btn-wide alert-blocked"
              onClick={() => {
                ensureAudioContext();
                playCrashAlertSound();
              }}
            >
              Sound blocked — tap to enable
            </button>
          )}

          <button
            className={`nav-btn ${muted ? "active" : ""}`}
            onClick={() => setMuted((prev) => !prev)}
            title={muted ? "Unmute alert sound" : "Mute alert sound"}
            aria-label={muted ? "Unmute alert sound" : "Mute alert sound"}
            aria-pressed={muted}
          >
            <Icon name={muted ? "volumeOff" : "volumeOn"} />
          </button>

          <button
            className="nav-btn"
            onClick={toggleTheme}
            title="Toggle theme"
            aria-label="Toggle colour theme"
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>

          <button
            className={`nav-btn ${settingsOpen ? "active" : ""}`}
            onClick={() => setSettingsOpen(true)}
            title="Settings and demo"
            aria-label="Open settings"
            aria-haspopup="dialog"
          >
            <Icon name="settings" />
          </button>
        </div>
      </nav>

      {/* ===== MAIN LAYOUT ===== */}
      {/* data-alerting drives the phone layout only: the banner floats over the list panes
          there, so their contents shift down out from under it. */}
      <div className="main-content" data-alerting={!!activeAlert}>
        {/* ===== LEFT SIDEBAR ===== */}
        {/* On the phone the list panes cover the map opaquely; the map tab hides them
            without unmounting, because a display:none ancestor makes Leaflet cache a 0x0
            size and the tiles never come back. */}
        <aside className="left-sidebar" data-hidden={isMobile && activeTab === "map"}>
          <div className="search-bar">
            <input
              type="search"
              placeholder="Search by device…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search by device"
            />
          </div>

          <div className="sidebar-tabs" role="tablist">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={sidebarTab === tab.id}
                className={`sidebar-tab ${sidebarTab === tab.id ? "active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
                <span className={`tab-count ${tab.critical && tab.count > 0 ? "critical" : ""}`}>
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          {/* --- ACTIVE TAB --- */}
          {sidebarTab === "active" && (
            <div className="sidebar-list">
              {filteredIncidents.length === 0 ? (
                <div className="empty-panel">
                  <h4>{query ? "No matches" : "All clear"}</h4>
                  <p>
                    {query
                      ? `No active incident matches “${searchQuery}”.`
                      : "Listening for incidents…"}
                  </p>
                </div>
              ) : (
                filteredIncidents.map((inc) => {
                  const elapsed = elapsedFor(inc);
                  return (
                    <button
                      key={inc.deviceId}
                      className={`incident-card ${
                        selectedIncidentId === inc.deviceId ? "selected" : ""
                      } ${activeAlert?.deviceId === inc.deviceId ? "alerting" : ""}`}
                      onClick={() => selectIncident(inc.deviceId)}
                    >
                      <div className="incident-card-top">
                        <span className={`incident-elapsed ${elapsedSeverity(elapsed)}`}>
                          {formatElapsed(elapsed)}
                        </span>
                        <span className="incident-badge crash">
                          {shownIncidentBadge(inc.event)}
                        </span>
                      </div>
                      <div className="incident-device-id">{inc.deviceId}</div>
                      <div className="incident-meta">
                        {Number.isFinite(inc.accelG) && inc.accelG > 0 && (
                          <span className="meta-chip">{inc.accelG.toFixed(1)} g</span>
                        )}
                        {!showsGpsLock(inc) && <span className="meta-chip warn">No GPS</span>}
                        {inc.restored && <span className="meta-chip muted">restored</span>}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          )}

          {/* --- DEVICES TAB --- */}
          {sidebarTab === "devices" && (
            <div className="sidebar-list">
              {deviceEntries.length === 0 ? (
                <div className="empty-panel">
                  <h4>{query ? "No matches" : "No devices yet"}</h4>
                  <p>
                    {query
                      ? `No device matches “${searchQuery}”.`
                      : "Devices appear here once they publish a status heartbeat."}
                  </p>
                </div>
              ) : (
                deviceEntries.map(([deviceId, device]) => (
                  <div key={deviceId} className="device-row">
                    <span
                      className={`connection-dot ${device.online ? "online" : "offline"}`}
                    ></span>
                    <div className="device-row-info">
                      <div className="device-row-id">{deviceId}</div>
                      <div className="device-row-meta">
                        {device.online ? "Online" : "Offline"} · seen{" "}
                        {formatLastSeen(now - device.lastSeen)}
                        {Number.isFinite(device.dropped) && device.dropped > 0
                          ? ` · ${device.dropped} dropped`
                          : ""}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* --- HISTORY TAB --- */}
          {sidebarTab === "history" && (
            <div className="sidebar-list">
              {filteredHistory.length === 0 ? (
                <div className="empty-panel">
                  <h4>{query ? "No matches" : "No incidents recorded"}</h4>
                  <p>
                    {query
                      ? `No history entry matches “${searchQuery}”.`
                      : "Past incidents will collect here."}
                  </p>
                </div>
              ) : (
                filteredHistory.map((entry) => (
                  <div
                    key={entry.id}
                    className={`history-card ${selectedHistoryId === entry.id ? "selected" : ""}`}
                  >
                    <span
                      className={`history-dot ${
                        entry.status === "RESOLVED" ? "resolved" : "crash"
                      }`}
                    ></span>
                    <div className="history-card-info">
                      <div className="history-card-device">{entry.deviceId}</div>
                      <div className="history-card-time">
                        {formatDateTime(entry.timestamp)}
                        {entry.clockSynced === false ? " (received)" : ""}
                      </div>
                    </div>
                    <div className="history-card-actions">
                      <span
                        className={`history-badge ${
                          entry.status === "RESOLVED" ? "resolved" : "crash-confirmed"
                        }`}
                      >
                        {entry.status === "RESOLVED"
                          ? "Resolved"
                          : shownIncidentBadge(entry.status)}
                      </span>
                      <button
                        className="history-map-btn"
                        onClick={() => {
                          setSelectedHistoryId(entry.id);
                          setDisplayCoords({ lat: entry.lat, lng: entry.lng });
                          showHistoryMarker(entry);
                        }}
                      >
                        Map
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </aside>

        {/* ===== CENTER: MAP ===== */}
        <main className="center-panel">
          <div className="map-status-bar">
            <div className="map-status-left">
              {hasActiveIncidents ? (
                <div className="status-chip crash">{incidentCount} active</div>
              ) : (
                <div className="status-chip idle">System normal</div>
              )}
              <div className="status-chip subtle">{onlineDeviceCount} online</div>
            </div>

            <div className="map-status-right">
              {displayCoords.lat !== null && (
                <>
                  <span className="coord-display">
                    {displayCoords.lat.toFixed(6)}, {displayCoords.lng.toFixed(6)}
                  </span>
                  <button
                    className={`copy-btn ${copied ? "copied" : ""}`}
                    onClick={copyCoordinates}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </>
              )}
            </div>
          </div>

          <div className={`map-container ${activeAlert ? "alerting" : ""}`}>
            <div id="map" ref={mapRef}></div>

            {activeAlert && (
              <div className="alert-banner" role="alert">
                <span className="alert-banner-pulse" aria-hidden="true" />
                <div className="alert-banner-text">
                  <strong>{shownIncidentLabel(activeAlert.event)}</strong>
                  {/* JSX child, never markup: the device ID comes off a public broker. */}
                  <span className="alert-banner-device">{activeAlert.deviceId}</span>
                </div>
                <button className="alert-banner-ack" onClick={acknowledgeAlert}>
                  Acknowledge
                </button>
              </div>
            )}

            {incidentCount > 1 && (
              <button className="map-fit-btn" onClick={fitAllIncidents} title="Fit all incidents">
                <Icon name="fit" />
              </button>
            )}

            <div className="map-legend">
              <div className="map-legend-title">Legend</div>
              <div className="map-legend-item">
                <span className="legend-dot live"></span>Live incident
              </div>
              {!PRESENT_ALL_FIXES_AS_LOCKED && (
                <div className="map-legend-item">
                  <span className="legend-dot live unlocked"></span>No GPS lock
                </div>
              )}
              <div className="map-legend-item">
                <span className="legend-dot history"></span>Historical
              </div>
              <div className="map-legend-item">
                <span className="legend-dot resolved"></span>Resolved
              </div>
            </div>
          </div>
        </main>

        {/* ===== RIGHT PANEL ===== */}
        <aside
          ref={sheetRef}
          className={`right-panel ${sheetOpen ? "open" : ""} ${
            sheetDragPx !== null ? "dragging" : ""
          }`}
          // Applied only while dragging. `.dragging` kills the CSS transition, so the
          // inline transform owns the frame-by-frame and the class owns the settle — that
          // split is what stops the two from fighting each other.
          style={sheetDragPx === null ? undefined : { transform: `translateY(${sheetDragPx}px)` }}
        >
          {/* Phone only. Kept in the DOM at every width and hidden by CSS, so crossing the
              breakpoint mid-alert never remounts the panel. */}
          <div
            className="sheet-grabber"
            role="presentation"
            onPointerDown={onSheetPointerDown}
            onPointerMove={onSheetPointerMove}
            onPointerUp={onSheetPointerUp}
            onPointerCancel={onSheetPointerUp}
          >
            <span className="sheet-grabber-bar" />
          </div>

          <div className="right-panel-header">
            <h3>Incident Command</h3>
          </div>

          {selectedIncident ? (
            <div className="right-panel-body">
              <div className={`elapsed-stat ${elapsedSeverity(elapsedFor(selectedIncident))}`}>
                <div className="elapsed-stat-value">
                  {formatElapsed(elapsedFor(selectedIncident))}
                </div>
                <div className="elapsed-stat-label">
                  {selectedIncident.clockSynced ? "since impact" : "since received"}
                </div>
              </div>

              {!selectedIncident.clockSynced && (
                <div className="panel-note">
                  Device clock unsynced — timing measured from arrival at this dashboard.
                </div>
              )}

              <div className="info-card">
                <div className="info-card-title">Device information</div>
                <div className="info-row">
                  <span className="info-label">Device ID</span>
                  <span className="info-value">{selectedIncident.deviceId}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Status</span>
                  <span className="info-value critical">
                    {shownIncidentLabel(selectedIncident.event).toUpperCase()}
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">Impact</span>
                  <span className="info-value">
                    {Number.isFinite(selectedIncident.accelG) && selectedIncident.accelG > 0
                      ? `${selectedIncident.accelG.toFixed(2)} g`
                      : "—"}
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">
                    {selectedIncident.clockSynced ? "Detected at" : "Received at"}
                  </span>
                  <span className="info-value">{formatDateTime(selectedIncident.timestamp)}</span>
                </div>
              </div>

              <div className="info-card">
                <div className="info-card-title">Location data</div>
                <div className="info-row">
                  <span className="info-label">Latitude</span>
                  <span className="info-value">{selectedIncident.lat.toFixed(6)}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Longitude</span>
                  <span className="info-value">{selectedIncident.lng.toFixed(6)}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">GPS</span>
                  <span className={`info-value ${showsGpsLock(selectedIncident) ? "" : "warn"}`}>
                    {showsGpsLock(selectedIncident) ? "GPS lock" : "No lock — approximate"}
                  </span>
                </div>
                {Number.isFinite(selectedIncident.ageMs) && showsGpsLock(selectedIncident) && (
                  <div className="info-row">
                    <span className="info-label">Fix age</span>
                    <span className="info-value">
                      {(selectedIncident.ageMs / 1000).toFixed(1)} s
                    </span>
                  </div>
                )}
              </div>

              {!showsGpsLock(selectedIncident) && (
                <div className="panel-note warn">
                  The device had no satellite fix. This position is a fallback, not a measurement.
                </div>
              )}

              <div className="actions-group">
                <button
                  className="action-btn primary"
                  onClick={() =>
                    window.open(
                      `https://www.google.com/maps?q=${selectedIncident.lat},${selectedIncident.lng}`,
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                >
                  <Icon name="external" />
                  Open in Google Maps
                </button>

                <button
                  className="action-btn resolve"
                  onClick={() => resolveIncident(selectedIncident.deviceId)}
                >
                  Resolve incident
                </button>
              </div>
            </div>
          ) : (
            <div className="empty-panel tall">
              <h4>No incident selected</h4>
              <p>Select an incident from the left panel to view details and take action.</p>
            </div>
          )}
        </aside>
      </div>

      {/* Phone navigation. Rendered at every width and hidden by CSS rather than by a
          condition, so a desktop resize cannot remount it mid-alert. */}
      <nav className="mobile-bar" aria-label="Views">
        {MOBILE_VIEWS.map((view) => (
          <button
            key={view.id}
            aria-current={activeTab === view.id}
            onClick={() => setActiveTab(view.id)}
          >
            {view.label}
            {view.id === "active" && incidentCount > 0 && (
              <span className="mobile-bar-count critical">{incidentCount}</span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}
