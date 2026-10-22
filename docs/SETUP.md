# From zero to flashed boards

Setting up a brand-new laptop, a new hotspot, and both boards. Written for macOS; Windows
differences are noted where they matter.

If the laptop is already set up and you only changed hotspot, skip to step 5 — or just read
`DEMO.md`, which covers that case alone.

---

## 1. Install the toolchain

**Git** — check first, macOS often has it:

```bash
git --version
```

If it prompts to install Command Line Tools, accept.

**PlatformIO Core.** This is what compiles and uploads. It installs its own Python environment,
so you do not need to manage Python yourself:

```bash
curl -fsSL -o get-platformio.py https://raw.githubusercontent.com/platformio/platformio-core-installer/master/get-platformio.py && python3 get-platformio.py
```

Then put `pio` on your PATH. For zsh (the macOS default):

```bash
echo 'export PATH="$HOME/.platformio/penv/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

Verify:

```bash
pio --version
```

> Prefer a GUI? Install VS Code and the **PlatformIO IDE** extension instead — it bundles the same
> Core. The `pio` commands below then live under the PlatformIO toolbar, or you can use VS Code's
> built-in terminal where `pio` is already on the PATH.

## 2. Get the code

```bash
git clone https://github.com/benedictnareswara/ResQPack.git && cd ResQPack
```

## 3. Create your credentials file

The repo is public, so real WiFi credentials are **not** committed. You must create them locally:

```bash
cp firmware/esp32/secrets.ini.example firmware/esp32/secrets.ini
```

You will fill this in at step 5, once the hotspot exists. `secrets.ini` is gitignored — never move
these values into `platformio.ini`.

## 4. Wire the hardware

Follow **`HARDWARE.md`** — it has the full pin map and a diagram. The three things that most often
go wrong:

- **Common ground.** Mega, ESP32, GPS, MPU6050 and buzzer must share GND. Without it the UART
  link produces garbage rather than failing cleanly.
- **Level shifter on Mega TX2 → ESP32 RX2.** Mega drives 5 V logic; the ESP32 is 3.3 V and not
  5 V tolerant. ESP32 TX2 → Mega RX2 needs no shifter.
- **GPS needs sky.** It will not get a fix indoors. Expect several minutes outdoors on a cold
  start.

## 5. Set up the hotspot

On your phone, turn on Personal Hotspot and set the password.

**iPhone: enable Settings → Personal Hotspot → Maximize Compatibility.** The ESP32 has no 5 GHz
radio and will never see the network without this. This is the single most common reason the
board sits at `WiFi: attempting connect...` forever.

Now put those values in `firmware/esp32/secrets.ini`:

```ini
[secrets]
wifi_ssid = your-hotspot-name
wifi_password = your-hotspot-password
device_id = resqpack-esp32-01
```

`device_id` must be unique per board — two boards sharing one ID collide on the same MQTT topic
and overwrite each other on the dashboard.

## 6. Check the laptop can see both boards

Plug both in over USB, then:

```bash
pio device list
```

You should see two ports. On macOS they look like `/dev/cu.usbmodem*` (Mega) and
`/dev/cu.usbserial*` or `/dev/cu.wchusbserial*` (ESP32).

**If a board does not appear, it needs a USB-serial driver.** Which one depends on the chip:

| Board shows up as | Driver needed |
|---|---|
| Nothing, ESP32 clone | CH340 (WCH) or CP210x (Silicon Labs) — check the chip marking next to the USB port |
| Nothing, Mega clone | CH340 |
| Genuine Arduino Mega | None — uses a built-in ATmega16U2 |

After installing a driver on macOS you may need to approve it in **System Settings → Privacy &
Security** and reboot. Do not skip the reboot; the port will not appear until you do.

## 7. Flash the Mega

From `firmware/mega/`:

```bash
pio run -t upload
```

First run downloads the AVR toolchain, so it takes a few minutes. Later runs are fast.

If upload fails with both boards plugged in, PlatformIO may have picked the wrong port. Name it
explicitly using the port from step 6:

```bash
pio run -t upload --upload-port /dev/cu.usbmodem1101
```

## 8. Flash the ESP32

From `firmware/esp32/`:

```bash
cd firmware/esp32 && pio run -t upload
```

If it stalls at `Connecting........_____`, hold the **BOOT** button on the ESP32 until upload
starts, then release. Some dev boards need this every time; some never do.

## 9. Verify

Two terminals, one per board.

ESP32, from `firmware/esp32/`:

```bash
pio device monitor -b 115200
```

Expect it to print its topics, then `WiFi connected`, then `MQTT connected`.

Mega, from `firmware/mega/`:

```bash
pio device monitor -b 115200
```

Expect MPU detection, then GPS lines once it has sky.

Now press the button on the Mega and let the 5-second window expire without pressing again. The
Mega should emit an `EVT,...,MANUAL,...` line, and the ESP32 should print that it published it.

Open the dashboard to confirm it arrived:

<https://benedictnareswara.github.io/ResQPack/>

The laptop running the dashboard does **not** need to be on the hotspot — that is the whole point
of the MQTT broker. Any internet connection anywhere works.

---

## 10. Run the dashboard

The dashboard is independent of the boards: it only needs Node 20+ and an internet connection.

```bash
cd dashboard
npm install
npm run dev
```

Open <http://localhost:5173>. With no vest publishing there is nothing on the map, so use
**Settings → Demo** to publish a test alert and watch the full arrival path. Copy `.env.example` to
`.env` only if you want a different broker or topic namespace; the defaults match the firmware.

The deployed copy at <https://benedictnareswara.github.io/ResQPack/> watches the same broker, so a
vest on a hotspot anywhere shows up there without running anything locally.

---

## When something does not work

| Symptom | Cause |
|---|---|
| `pio: command not found` | PATH not set — redo the `~/.zshrc` line in step 1 and open a new terminal |
| Board missing from `pio device list` | USB-serial driver, or a charge-only USB cable. Try a different cable first — this is common |
| ESP32 stuck at `WiFi: attempting connect...` | 5 GHz-only hotspot (enable Maximize Compatibility), or wrong values in `secrets.ini` |
| ESP32 connects but dashboard shows nothing | Check `device_id` is not colliding with another board |
| Mega prints `MPU6050 not found` | I2C wiring on pins 20/21, or missing common ground |
| GPS never gets a fix | Indoors. Go outside and allow several minutes on a cold start |
| Upload to Mega fails | Wrong port — pass `--upload-port` explicitly |
| Garbage characters in serial monitor | Baud mismatch — both boards are 115200 |

For the per-demo runbook once everything is built, see `DEMO.md`.
