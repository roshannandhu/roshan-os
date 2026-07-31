# CYBERDECK M8 — Full Build Log & Reference

**Device:** Lenovo Tab M8 HD (TB-8505F) · MediaTek MT6761 / Helio A22 · Serial `HNP06KSC`
**Result:** LineageOS 18.1 (Android 11) GSI, rooted (PHH SuperUser), + CYBERDECK dashboard v0.1
**Date:** 2026-07-20

---

## TL;DR — current state

- ✅ Bootloader unlocked
- ✅ Running **LineageOS 18.1** (`arm64_bvS` GSI, Android 11)
- ✅ **Rooted** via PHH SuperUser (`/system/bin/phh-su`) — **NOT Magisk** (Magisk bootloops this device)
- ✅ Apps installed: AdAway, AFWall+, SD Maid SE, SmartPack Manager
- ✅ CYBERDECK dashboard v0.1 running on laptop, shown on tablet over USB (`adb reverse`)

All tooling lives in `C:\platform-tools\platform-tools\`.
Dashboard project lives in `C:\Users\Roshan Raj\cyberdeck\`.

---

## 1. The device — verified facts

| Property | Value |
|---|---|
| Product (`fastboot getvar product`) | `akita_row_wifi` (= Lenovo TB-8505F codename) |
| Partition layout | **A-only** (`slot-count: 0`, no `super`) |
| system partition size | `0xf3800000` = 3896 MB |
| **CPU ABI (from stock firmware)** | **`arm64-v8a`** (64-bit userspace) — see note below |
| Stock firmware used | `TB-8505F_S301039_240809_ROW` |

### CRITICAL LESSON: architecture
`fastboot getvar` does NOT reveal userspace ABI. I read it directly from the stock
`system.img` build.prop:
```
ro.product.cpu.abi       = arm64-v8a
ro.product.cpu.abilist   = arm64-v8a,armeabi-v7a,armeabi
ro.product.cpu.abilist64 = arm64-v8a
```
=> device runs **64-bit userspace** => correct GSI is **`arm64_bvS`**, NOT `a64_bvS`.
Flashing the 32-bit `a64_bvS` first caused a frozen boot (32-bit userspace can't bind
the stock 64-bit vendor HALs). Many online guides wrongly say "a64" for this model —
the firmware is the source of truth.

---

## 2. GSI used

- **File:** `lineage-18.1-20240121-UNOFFICIAL-arm64_bvS.img.xz`
- **Source:** Andy Yan GSI, SourceForge `andyyan-gsi/lineage-18.x`
- Naming: `arm64` = 64-bit · `b` = system-as-root · `v` = vanilla (no GApps) · `S` = **PHH SuperUser included**
- Extracted `system_arm64.img` = 1764.6 MB (fits 3896 MB partition)
- Extract `.xz` on Windows (no 7-Zip/WSL): Python `lzma` — see snippet in section 8.

---

## 3. vbmeta — MUST be flag-patched (verity/verification disabled)

`fastboot --disable-verity --disable-verification flash vbmeta ...` **FAILS** on fastboot v37
with `Failed to find AVB_MAGIC at offset: 0` (tool bug). Workaround = patch the flags byte manually:

- vbmeta AVB header: **flags = uint32 big-endian at offset 120**. Set to `0x00000003`
  (bit0 HASHTREE_DISABLED | bit1 VERIFICATION_DISABLED).
- Patched file: `C:\platform-tools\platform-tools\vbmeta_patched.img`
- Stock `vbmeta.img` SHA256: `60f133e6f31b159f268293e934ee3780269ccf1757257126ddd0aa635523e116`
- Flashing the **original** vbmeta => `dm-verity corruption / device is corrupt` loop.
- Flashing the **patched** vbmeta => boots.

---

## 4. The exact flash sequence that worked

Tablet in fastboot mode, from `C:\platform-tools\platform-tools\`:

```bat
fastboot devices                              REM confirm HNP06KSC
fastboot getvar unlocked                       REM unlocked: yes
fastboot flash vbmeta vbmeta_patched.img       REM verity disabled
fastboot flash system system_arm64.img         REM the arm64 GSI (14 sparse chunks)
fastboot -w                                     REM wipe userdata+cache (REQUIRED, else bootloop)
fastboot reboot
```

**First boot takes 5-10 min** on this slow chip — the Orange State "device can't be trusted"
text stays frozen on screen while the kernel boots behind it. That warning is **normal and
permanent** on any unlocked bootloader; it always auto-continues after 5s. Do NOT interrupt
first boot (that was the mistake that cost 2 cycles).

### Recovery safety net
Stock boot image saved at `C:\platform-tools\platform-tools\boot_tmp.img`
(extracted from firmware). If a bad boot image bootloops:
```bat
fastboot flash boot boot_tmp.img
fastboot reboot
```

---

## 5. Root — PHH SuperUser (NOT Magisk)

**Magisk was tried and REMOVED** — the Magisk-patched boot bootloops back to fastboot on this
MTK A-only + GSI setup. Do not re-attempt Magisk here.

Root that works, built into the `S` GSI variant:
- `/system/bin/phh-su` — PHH SuperUser binary. `phh-su -c id` => `uid=0(root)` ✅
- `adb root` also works (userdebug GSI) — gives a root ADB shell from the PC.
- **Grant root to apps:** open **Treble Settings** app (`me.phh.treble.app`) → Misc/Superuser,
  and allow when an app requests root.

Trade-off vs Magisk: no **Zygisk** => **no LSPosed** and no systemless modules. Everything else works.

---

## 6. Apps installed (via `adb install`)

| App | Package | Source | Notes |
|---|---|---|---|
| AdAway 6.1.4 | `org.adaway` | GitHub | root-mode hosts blocking |
| AFWall+ 4.0.3 | `dev.ukanth.ufirewall` | GitHub | needs root + iptables |
| SD Maid SE 1.7.5 | `eu.darken.sdmse` | GitHub | cleanup; root optional |
| SmartPack Manager | `com.smartpack.kernelmanager` | F-Droid | limited on GSI (stock MTK kernel) |

APKs cached in `C:\platform-tools\platform-tools\apks\`.

---

## 7. CYBERDECK dashboard v0.1

**Architecture:** tablet = interface, laptop = compute. Dashboard runs on the **laptop**
(FastAPI); tablet just shows it in a browser over USB via `adb reverse`. The tablet needs
nothing but a browser.

**Project files:** `C:\Users\Roshan Raj\cyberdeck\`
- `app.py` — FastAPI: serves dashboard, `/api/status` REST, `/ws` WebSocket (live stats every 2s)
- `index.html` — cyberpunk UI (matrix rain, neon panel, live CPU/RAM/battery, service tiles, 6 action tiles)
- `config.json` — service list to monitor (GitHub, Cloudflare, AWS, PostgreSQL, Ollama, SSH)

**Deps (laptop, Python 3.11):** `fastapi uvicorn[standard] psutil httpx`

### How to run it (every time you dock the tablet)
```bat
REM 1. start the dashboard server on the laptop
python "C:\Users\Roshan Raj\cyberdeck\app.py"

REM 2. bridge tablet -> laptop over USB (tablet must have USB debugging on)
C:\platform-tools\platform-tools\adb.exe reverse tcp:8080 tcp:8080

REM 3. open it on the tablet
C:\platform-tools\platform-tools\adb.exe shell am start -a android.intent.action.VIEW -d "http://127.0.0.1:8080"
```
`adb reverse` must be re-run after each unplug/adb restart.

**v0.1 status:** live laptop stats + real GitHub/Cloudflare/Ollama checks + USB pipe + UI = DONE.
Stubs: the 6 tiles are visual only; AWS/Postgres need real host in `config.json`.

### Roadmap (next)
1. Wire tiles to real actions (plugin model: each tile = FastAPI endpoint + panel) —
   GITHUB=commit feed, DEPLOY=run laptop script, TERMINAL=SSH-to-AWS in browser.
2. Persistence: auto-start server + one-tap `adb reverse` so it "just works" on dock.
3. Kiosk mode: install Fully Kiosk so the dashboard IS the home screen.
4. (optional) small local models via Termux — but keep AI on the laptop (2 GB RAM on tablet).

---

## 8. Handy snippets

**Extract a `.xz` on Windows (no 7-Zip needed):**
```python
import lzma, shutil
with lzma.open(r"gsi.img.xz","rb") as fi, open(r"system.img","wb") as fo:
    shutil.copyfileobj(fi, fo, 8*1024*1024)
```

**Patch vbmeta flags to disable verity (offset 120 = 0x00000003):**
```python
b = bytearray(open("vbmeta.img","rb").read())
b[120:124] = b"\x00\x00\x00\x03"        # HASHTREE_DISABLED | VERIFICATION_DISABLED
open("vbmeta_patched.img","wb").write(b)
```

**Enter fastboot from a booted, USB-debugged tablet:** `adb reboot bootloader`
**Enter fastboot manually:** power off, then hold **Volume Down + Power**.

---

## 9. Key don'ts (hard-won)
- ❌ Do NOT re-lock the bootloader (hard-bricks a GSI device).
- ❌ Do NOT install Magisk here (bootloops).
- ❌ Do NOT flash the `a64` GSI (wrong arch — 32-bit; device is arm64).
- ❌ Do NOT interrupt first boot before 10 minutes.
- ✅ Keep `boot_tmp.img` (stock boot) as the recovery escape hatch.
