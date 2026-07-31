# Inventory

All sensitive device, network, and credential values are redacted by design.

## Host development environment

| Tool                          | Finding                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| Shell                         | Windows PowerShell 5.1                                                    |
| Working project               | E:\IMP PROJECT 2\TABLET ROOTED\tablet-control                             |
| Git                           | 2.54.0.windows.1                                                          |
| Node.js                       | v24.17.0                                                                  |
| npm                           | 11.13.0                                                                   |
| Java / javac / Gradle on PATH | Missing                                                                   |
| Android SDK                   | Present under %LOCALAPPDATA%\Android\Sdk; environment variables are unset |
| SDK platforms                 | android-34, 35, 36, 36.1, 37.0                                            |
| Build tools                   | 34.0.0 through 37.0.0                                                     |
| ADB used                      | Separate platform-tools installation, ADB 37.0.0                          |

## Tablet packages

| Role                 | Package                | Version               | State                                 |
| -------------------- | ---------------------- | --------------------- | ------------------------------------- |
| Camera/listening     | com.pas.webcam         | 1.14.37.759 (aarch64) | Installed, foreground service running |
| Private network      | com.tailscale.ipn      | 1.96.4                | Installed, VPN connected              |
| Fully Kiosk Browser  | de.ozerov.fully        | —                     | Not installed                         |
| Existing kiosk       | uk.nktnet.webviewkiosk | 0.26.17               | Installed                             |
| Existing clock       | systems.sieber.fsclock | 2.2                   | Installed                             |
| Launcher             | app.lawnchair          | 15.Beta 3             | Current HOME resolver                 |
| Root manager         | com.topjohnwu.magisk   | 30.7                  | Installed                             |
| Treble configuration | me.phh.treble.app      | 1.0                   | Installed                             |

## Services, interfaces, and ports

| Item               | Verified finding                                                    |
| ------------------ | ------------------------------------------------------------------- |
| Wi-Fi              | Connected and validated; SSID/BSSID/IP intentionally redacted       |
| Tailscale          | Connected, validated VPN using tun0; tailnet/DNS/IP values redacted |
| IP Webcam HTTP     | TCP 8080 wildcard listener, process owned by com.pas.webcam         |
| KDE Connect        | TCP 1716 wildcard listener                                          |
| Spotify            | TCP 55621 wildcard listener                                         |
| Fully remote admin | Not applicable; Fully is not installed                              |
| Companion service  | Not present                                                         |

## IP Webcam integration contract verified from the installed UI

| Function        | Path or evidence                                                       | Discovery status                                                      |
| --------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Health/status   | GET /status.json and GET /status.json?show_avail=1                     | Confirmed returning JSON                                              |
| Video           | /video                                                                 | Advertised by installed UI; stream lifecycle not yet tested           |
| Listening audio | /audio.wav and /audio.opus                                             | Advertised by installed UI; playback not yet tested                   |
| Torch           | /enabletorch and /disabletorch                                         | Endpoint exists; hardware has no flash, so unsupported on this tablet |
| Zoom            | /ptz?zoom=                                                             | Endpoint exists; range comes from status data and needs validation    |
| Focus           | /focus, /nofocus, and /settings/focus_distance?set=                    | Endpoint exists; mode/range needs validation                          |
| Quality         | /settings/quality?set=                                                 | Endpoint exists                                                       |
| Resolution      | Generic settings UI binds video_size through /settings/video_size?set= | Path inferred from installed UI code; values require validation       |
| FPS             | Camera2 reports FPS ranges; no discrete endpoint was verified          | Further inspection/testing needed                                     |
| Camera switch   | Front/back assets are present; no command path was verified            | Further inspection/testing needed                                     |
| Snapshot        | Photo resources exist, but a dedicated action path was not verified    | Further inspection/testing needed                                     |

## Existing startup mechanisms

| Mechanism                | Purpose                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| IP Webcam BootUpReceiver | App declares boot-completed handling.                                 |
| Root 20-cctv-camera.sh   | Health-gated IP Webcam startup and conditional screen-off after boot. |
| Root 21-cctv-watchdog.sh | Starts the existing five-minute health-check daemon.                  |
| Tailscale IPNService     | VPN service is startRequested; boot receiver is declared.             |

## Relevant granted IP Webcam permissions

- CAMERA
- RECORD_AUDIO
- INTERNET
- ACCESS_NETWORK_STATE
- ACCESS_WIFI_STATE
- WAKE_LOCK
- RECEIVE_BOOT_COMPLETED
- FOREGROUND_SERVICE
