# Phase 4A.2e — IP Webcam listener diagnosis

Date: 2026-07-24

Scope: read-only diagnosis only. Authentication mode stayed `disabled`; the tablet curl-auth file was empty and the ignored local credential file was absent.

## Process and service snapshot

- ADB root identity was available.
- `com.pas.webcam` PID was `10838`, the same PID recorded before the listener-loss event.
- Snapshot resource use: sleeping process, 8.2% CPU, 110,628 KiB RSS, 164 threads, and 383 open file descriptors. This single snapshot does not indicate an acute resource-exhaustion condition.
- Android reported `.WebServer` as an active foreground service in the IP Webcam process.
- TCP 8080 was listening on the wildcard interface and associated with PID `10838`.
- A bounded tablet-local unauthenticated root request returned HTTP 200; the shared helper also reported healthy.
- The current IP Webcam UI exposed a `Stop` control, which indicates the server was running.

## Listener-loss and watchdog findings

- The watchdog recorded a failed health-check pass at `13:43:49`, then invoked its approved existing recovery path at `13:43:52`.
- The exact installed action is an Android activity launch of the IP Webcam `.Rolling` component with `android.intent.action.RUN`; it was inspected only and not executed during diagnosis.
- The same log recorded the port open at 3 and 6 seconds, HTTP healthy at 6 and 9 seconds, and `Camera started OK after 9s`.
- The caller nevertheless logged `Recovery: FAILED`. Read-only inspection found its result comparison has an empty numeric operand, so it cannot correctly recognize result zero. This is an existing watchdog-caller status-classification defect.
- Subsequent normal watchdog cycles were healthy. No manual recovery, process termination, or script change was performed.

## Log and cause assessment

- A bounded, redacted IP Webcam/WebServer/foreground-service/ANR/camera/audio logcat window contained no relevant crash, ANR, permission, camera, microphone, or port-binding failure evidence.
- The evidence best matches: the application process remained alive while the WebServer listener was transiently absent; the watchdog recovery action restored it, but the caller misreported its outcome.
- Confidence is high for the watchdog reporting defect and current healthy state; confidence is low for the original trigger of the transient listener loss because no matching app/system error was retained in the bounded log window.

## Safety result

No authentication setting, credential, camera/audio setting, network setting, process state, helper, watchdog script, or boot script was changed by this diagnostic phase.

## Follow-up gate

A normal user-attended `Start server` action is not justified while the UI already shows `Stop` and read-only liveness is healthy. Any watchdog-caller repair requires separate explicit approval and should include a backup, narrow patch review, rollback plan, and post-install recovery verification.
