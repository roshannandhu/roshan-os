#!/system/bin/sh
# CCTV Camera Automation - Common Functions (FIXED v2)
CCTV_DIR="/data/local/tmp/cctv"
CCTV_LOG="$CCTV_DIR/cctv.log"
CCTV_LOCK="$CCTV_DIR/start.lock"
CCTV_DISABLED="$CCTV_DIR/disabled.flag"
CCTV_FAILURE_COUNT="$CCTV_DIR/failure.count"
CCTV_RESTART_COUNT="$CCTV_DIR/restart.count"
CCTV_RESTART_WINDOW="$CCTV_DIR/restart.window"
CCTV_LAST_SUCCESS="$CCTV_DIR/last.success"
CCTV_LAST_FAILURE="$CCTV_DIR/last.failure"
CCTV_BOOT_PENDING="$CCTV_DIR/boot.pending"
AUTH_MODE_FILE="/data/adb/cctv/ipwebcam-health.mode"
AUTH_CURL_CONFIG="/data/adb/cctv/ipwebcam-auth.curl"
HTTP_HEALTH_STATE="unknown"
IP_WEBCAM_PKG="com.pas.webcam"
TAILSCALE_PKG="com.tailscale.ipn"
PORT=8080
MAX_RESTART_ATTEMPTS=3
RESTART_WINDOW_MINUTES=30
LOG_MAX_SIZE=1048576
setup_dirs() { mkdir -p "$CCTV_DIR"; touch "$CCTV_LOG"; }
log() {
    local msg; msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    local sz; sz=$(wc -c < "$CCTV_LOG" 2>/dev/null || echo 0)
    if [ "$sz" -gt "$LOG_MAX_SIZE" ]; then mv "$CCTV_LOG" "${CCTV_LOG}.old"; touch "$CCTV_LOG"; fi
    echo "$msg" >> "$CCTV_LOG"; echo "$msg"
}
is_disabled() { [ -f "$CCTV_DISABLED" ]; }
acquire_lock() {
    local lockpid; lockpid="$CCTV_LOCK.$$"
    echo "$$" > "$lockpid"
    if ln "$lockpid" "$CCTV_LOCK" 2>/dev/null; then rm -f "$lockpid"; return 0; fi
    rm -f "$lockpid"; return 1
}
release_lock() { rm -f "$CCTV_LOCK"; }
is_locked() { [ -f "$CCTV_LOCK" ]; }
check_boot_completed() {
    local val; val=$(getprop sys.boot_completed 2>/dev/null)
    [ "$val" = "1" ]
}
check_user_unlocked() {
    dumpsys user 2>/dev/null | grep -q "RUNNING_UNLOCKED" && return 0
    return 1
}
check_network() {
    ip route 2>/dev/null | grep -q "^default" && return 0
    return 1
}
check_tailscale() {
    pidof "$TAILSCALE_PKG" > /dev/null 2>&1 && return 0
    return 1
}
check_port() {
    ss -lntp 2>/dev/null | grep -q ":${PORT} " && return 0
    return 1
}
read_auth_mode() {
    AUTH_MODE="disabled"
    [ -e "$AUTH_MODE_FILE" ] || return 0
    [ -f "$AUTH_MODE_FILE" ] || { AUTH_MODE="invalid"; return 1; }
    IFS= read -r mode < "$AUTH_MODE_FILE" || { AUTH_MODE="invalid"; return 1; }
    case "$mode" in
        disabled|enabled) AUTH_MODE="$mode"; return 0 ;;
        *) AUTH_MODE="invalid"; return 1 ;;
    esac
}
auth_curl_config_ready() {
    [ -s "$AUTH_CURL_CONFIG" ] || return 1
    [ "$(stat -c %a "$AUTH_CURL_CONFIG" 2>/dev/null)" = "600" ] || return 1
    [ "$(stat -c %U "$AUTH_CURL_CONFIG" 2>/dev/null)" = "root" ] || return 1
}
parse_http_probe_result() {
    HTTP_CODE=""
    HTTP_BYTES=""
    HTTP_PROBE_STATE="invalid-probe"
    HTTP_PROBE_PARSED=$(printf '%s' "$1" | awk -F '|' '
        NR > 1 { exit 1 }
        {
            sub(/\r$/, "", $2)
            if (NF != 2 || $1 !~ /^[0-9][0-9][0-9]$/ || $2 !~ /^[0-9]+$/) exit 1
            print $1 "|" $2
        }
    ') || return 1
    [ -n "$HTTP_PROBE_PARSED" ] || {
        [ -n "$1" ] || HTTP_PROBE_STATE="empty-response"
        return 1
    }
    HTTP_CODE=${HTTP_PROBE_PARSED%%\|*}
    HTTP_BYTES=${HTTP_PROBE_PARSED#*\|}
    HTTP_PROBE_STATE="valid"
    return 0
}
http_probe() {
    local result curl_rc parse_rc
    if [ "$1" = "authenticated" ]; then
        result=$(curl --config "$AUTH_CURL_CONFIG" --anyauth --connect-timeout 5 --max-time 8 -s -o /dev/null -w "%{http_code}|%{size_download}" "http://127.0.0.1:${PORT}/" 2>/dev/null)
        curl_rc=$?
    else
        result=$(curl --connect-timeout 5 --max-time 8 -s -o /dev/null -w "%{http_code}|%{size_download}" "http://127.0.0.1:${PORT}/" 2>/dev/null)
        curl_rc=$?
    fi
    HTTP_CURL_EXIT="$curl_rc"
    HTTP_PROBE_STATE="unknown"
    parse_http_probe_result "$result"
    parse_rc=$?
    if [ "$curl_rc" -ne 0 ]; then
        case "$HTTP_CODE" in
            [1-5][0-9][0-9]) HTTP_PROBE_STATE="response-completion-timeout" ;;
            *) HTTP_PROBE_STATE="curl-failed" ;;
        esac
        return 1
    fi
    return "$parse_rc"
}
check_http_response() {
    read_auth_mode || true
    if [ "$AUTH_MODE" = "enabled" ] && auth_curl_config_ready; then
        http_probe authenticated
    else
        http_probe unauthenticated
    fi
    if [ "$HTTP_CURL_EXIT" -ne 0 ]; then
        case "$HTTP_PROBE_STATE" in
            response-completion-timeout) HTTP_HEALTH_STATE="response-completion-timeout" ;;
            *) HTTP_HEALTH_STATE="partial-or-timeout" ;;
        esac
        return 1
    fi
    case "$HTTP_PROBE_STATE" in
        valid) ;;
        empty-response) HTTP_HEALTH_STATE="empty-response"; return 1 ;;
        *) HTTP_HEALTH_STATE="invalid-probe"; return 1 ;;
    esac
    case "$HTTP_CODE" in
        200)
            if [ "$AUTH_MODE" = "enabled" ] && ! auth_curl_config_ready; then
                HTTP_HEALTH_STATE="auth-config-missing-or-invalid"
            else
                HTTP_HEALTH_STATE="healthy"
            fi
            return 0
            ;;
        401)
            if [ "$AUTH_MODE" = "enabled" ]; then
                if auth_curl_config_ready; then
                    HTTP_HEALTH_STATE="auth-invalid"
                else
                    HTTP_HEALTH_STATE="auth-config-missing-or-invalid"
                fi
            else
                HTTP_HEALTH_STATE="auth-required-while-disabled"
            fi
            return 0
            ;;
        *)
            HTTP_HEALTH_STATE="http-unhealthy"
            return 1
            ;;
    esac
}
check_process() {
    pidof "$IP_WEBCAM_PKG" > /dev/null 2>&1 && return 0
    return 1
}
full_health_check() {
    check_process || return 1
    check_port    || return 1
    check_http_response || return 1
    return 0
}
partial_health_check() {
    check_process || return 1
    check_port    || return 1
    return 0
}
check_restart_rate_limit() {
    local now; now=$(date +%s)
    local window_start=0
    [ -f "$CCTV_RESTART_WINDOW" ] && window_start=$(cat "$CCTV_RESTART_WINDOW" 2>/dev/null || echo 0)
    local elapsed=$(( (now - window_start) / 60 ))
    if [ "$elapsed" -ge "$RESTART_WINDOW_MINUTES" ]; then
        echo "$now" > "$CCTV_RESTART_WINDOW"
        echo "1" > "$CCTV_RESTART_COUNT"
        return 0
    fi
    local count=0
    [ -f "$CCTV_RESTART_COUNT" ] && count=$(cat "$CCTV_RESTART_COUNT" 2>/dev/null || echo 0)
    if [ "$count" -ge "$MAX_RESTART_ATTEMPTS" ]; then
        log "RATE LIMIT: $count restarts in ${elapsed}min (max $MAX_RESTART_ATTEMPTS per ${RESTART_WINDOW_MINUTES}min)"
        return 1
    fi
    count=$((count + 1))
    echo "$count" > "$CCTV_RESTART_COUNT"
    return 0
}
record_success() { date +%s > "$CCTV_LAST_SUCCESS"; rm -f "$CCTV_FAILURE_COUNT"; }
record_failure() {
    date +%s > "$CCTV_LAST_FAILURE"
    local fc=0
    [ -f "$CCTV_FAILURE_COUNT" ] && fc=$(cat "$CCTV_FAILURE_COUNT" 2>/dev/null || echo 0)
    fc=$((fc + 1))
    echo "$fc" > "$CCTV_FAILURE_COUNT"
}
get_failure_count() {
    [ -f "$CCTV_FAILURE_COUNT" ] && cat "$CCTV_FAILURE_COUNT" 2>/dev/null || echo 0
}
start_ip_webcam() {
    if full_health_check; then log "Camera already healthy -- skipping"; return 0; fi
    if ! acquire_lock; then log "Lock held -- skipping"; return 1; fi
    log "Starting IP Webcam (.Rolling only, no .Configuration)..."
    input keyevent KEYCODE_WAKEUP 2>/dev/null
    sleep 2
    am start -a android.intent.action.RUN -n "${IP_WEBCAM_PKG}/.Rolling" 2>>"$CCTV_LOG"
    log "am start sent. Waiting up to 45s..."
    local max_wait=45; local waited=0; local port_n=0; local http_n=0
    while [ "$waited" -lt "$max_wait" ]; do
        sleep 3; waited=$((waited + 3))
        if ! check_process; then log "  t=${waited}s: no process"; port_n=0; continue; fi
        if check_port; then
            port_n=$((port_n + 1)); log "  t=${waited}s: port open (n=${port_n})"
            if [ "$port_n" -ge 2 ]; then
                if check_http_response; then
                    http_n=$((http_n + 1)); log "  t=${waited}s: HTTP ${HTTP_HEALTH_STATE} (n=${http_n})"
                    if [ "$http_n" -ge 2 ]; then
                        log "Camera started OK after ${waited}s"
                        record_success; release_lock; return 0
                    fi
                else log "  t=${waited}s: HTTP not ready"; http_n=0; fi
            fi
        else log "  t=${waited}s: port closed"; port_n=0; http_n=0; fi
    done
    log "FAILED after ${max_wait}s"; record_failure; release_lock; return 1
}
turn_screen_off() { log "Screen off (KEYCODE_SLEEP)..."; input keyevent KEYCODE_SLEEP 2>/dev/null; }
is_screen_off() {
    dumpsys power 2>/dev/null | grep "mWakefulness=" | grep -qE "Dozing|Asleep" && return 0
    return 1
}
get_battery_temp() { dumpsys battery 2>/dev/null | grep "temperature:" | sed 's/.*temperature: *//' | tr -d '\r\n'; }
get_battery_level() { dumpsys battery 2>/dev/null | grep " level:" | sed 's/.*level: *//' | tr -d '\r\n'; }
is_charging() { dumpsys battery 2>/dev/null | grep -q "AC powered: true"; }
