#!/system/bin/sh
# CCTV Health Check (FIXED v2 - run-once, no permanent loop)
CCTV_COMMON="/data/local/tmp/cctv-common-fixed.sh"
if [ -f "$CCTV_COMMON" ]; then . "$CCTV_COMMON"; else
    echo "[$(date)] FATAL: $CCTV_COMMON not found" >> /data/local/tmp/cctv-err.log; exit ; fi
setup_dirs
log "=== HEALTH CHECK STARTED ==="
if is_disabled; then log "DISABLED"; exit ; fi
if ! check_user_unlocked; then log "User not unlocked -- skip"; exit ; fi
if is_locked; then log "Lock present -- defer"; exit ; fi
if [ -f "$CCTV_BOOT_PENDING" ]; then log "Boot pending -- skip"; exit ; fi
battery_temp=$(get_battery_temp); battery_level=$(get_battery_level)
charging=$(is_charging && echo yes || echo no)
cam_pid=$(pidof "$IP_WEBCAM_PKG" 2>/dev/null || echo NONE)
log "Status: PID=${cam_pid}, Temp=${battery_temp}, Bat=${battery_level}%, Charging=${charging}"
if [ -n "$battery_temp" ] && [ "$battery_temp" -gt  ] 2>/dev/null; then
    log "CRITICAL TEMP ${battery_temp} -- abort"; exit ; fi
if full_health_check; then log "Camera healthy (pass )"; record_success
    log "=== HEALTH CHECK COMPLETED (healthy) ==="; exit ; fi
log "Pass  FAILED. Waiting 3s for pass 2..."; sleep 3
if full_health_check; then log "Camera healthy (pass 2)"; record_success
    log "=== HEALTH CHECK COMPLETED (healthy on retry) ==="; exit ; fi
log "Pass 2 FAILED. Attempting recovery..."; record_failure
if ! check_restart_rate_limit; then log "Rate limit exceeded"
    log "=== HEALTH CHECK COMPLETED (rate-limited) ==="; exit ; fi
start_ip_webcam
RESULT=$?
case "$RESULT" in
    0)
        log "Recovery: SUCCESS"
        am start -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null
        sleep 7
        if partial_health_check; then turn_screen_off; fi
        ;;
    '')
        log "Recovery: INVALID_RESULT"
        ;;
    *[!0-9]*)
        log "Recovery: INVALID_RESULT"
        ;;
    *)
        log "Recovery: FAILED"
        ;;
esac
log "=== HEALTH CHECK COMPLETED ==="
