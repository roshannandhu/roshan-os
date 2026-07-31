#!/usr/bin/env bash

set -Eeuo pipefail

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${TEST_DIR}/../.." && pwd -P)"
PREPARE_SCRIPT="${REPO_ROOT}/rom/scripts/prepare-working-image.sh"
FIXTURE_ROOT="$(mktemp -d -t roshanos-apk-fixture.XXXXXXXX)"
MOUNT_MARKER="${FIXTURE_ROOT}/mount-was-called"

cleanup() {
    if [[ -n "${FIXTURE_ROOT}" && -d "${FIXTURE_ROOT}" &&
        "$(basename -- "${FIXTURE_ROOT}")" == roshanos-apk-fixture.* ]]; then
        rm -rf -- "${FIXTURE_ROOT}"
    fi
}
trap cleanup EXIT INT TERM

mkdir -p -- "${FIXTURE_ROOT}/apks"
printf 'fixture: tailscale\n' >"${FIXTURE_ROOT}/apks/tailscale.apk"
printf 'fixture: ip-webcam\n' >"${FIXTURE_ROOT}/apks/ip-webcam.apk"
printf 'fixture: wrong-package\n' >"${FIXTURE_ROOT}/apks/wrong.apk"
printf 'fixture: changes-during-validation\n' >"${FIXTURE_ROOT}/apks/mutating.apk"

create_fake_tooling() {
    local kind="$1"
    local bin_dir="${FIXTURE_ROOT}/bin-${kind}"
    local tool_path="${bin_dir}/${kind}"

    mkdir -p -- "${bin_dir}"
    cat >"${tool_path}" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

tool_name="$(basename -- "$0")"
apk_path="${@: -1}"
case "$(basename -- "${apk_path}")" in
    tailscale.apk)
        package_id="com.tailscale.ipn"
        ;;
    ip-webcam.apk)
        package_id="com.pas.webcam"
        ;;
    wrong.apk)
        package_id="com.example.wrong"
        ;;
    mutating.apk)
        package_id="com.tailscale.ipn"
        printf 'mutation\n' >>"${apk_path}"
        ;;
    *)
        exit 41
        ;;
esac

case "${tool_name}" in
    apkanalyzer)
        [[ "$1" == "manifest" && "$2" == "application-id" ]] || exit 42
        printf '%s\n' "${package_id}"
        ;;
    aapt2)
        [[ "$1" == "dump" && "$2" == "packagename" ]] || exit 43
        printf '%s\r\n' "${package_id}"
        ;;
    aapt)
        [[ "$1" == "dump" && "$2" == "badging" ]] || exit 44
        printf "package: name='%s' versionCode='1' versionName='fixture'\n" "${package_id}"
        ;;
    *)
        exit 45
        ;;
esac
EOF
    chmod 0755 -- "${tool_path}"

    cat >"${bin_dir}/mount" <<'EOF'
#!/usr/bin/env bash
printf 'unexpected mount invocation\n' >"${ROSHANOS_TEST_MOUNT_MARKER}"
exit 99
EOF
    chmod 0755 -- "${bin_dir}/mount"
}

for inspector_kind in apkanalyzer aapt2 aapt; do
    create_fake_tooling "${inspector_kind}"
done

run_with_inspector() {
    local inspector_kind="$1"
    shift
    PATH="${FIXTURE_ROOT}/bin-${inspector_kind}:/usr/bin:/bin" \
        ROSHANOS_TEST_MOUNT_MARKER="${MOUNT_MARKER}" \
        bash "${PREPARE_SCRIPT}" "$@"
}

expect_failure() {
    local expected_text="$1"
    shift
    local output

    if output="$("$@" 2>&1)"; then
        echo "Expected failure but command succeeded: $*" >&2
        exit 1
    fi
    [[ "${output}" == *"${expected_text}"* ]] || {
        echo "Failure did not contain expected text: ${expected_text}" >&2
        echo "${output}" >&2
        exit 1
    }
}

bash -n "${PREPARE_SCRIPT}"
bash -n "$0"

for inspector_kind in apkanalyzer aapt2 aapt; do
    validation_output="$(
        run_with_inspector "${inspector_kind}" \
            --validate-apks-only \
            --tailscale-apk "${FIXTURE_ROOT}/apks/tailscale.apk" \
            --ip-webcam-apk "${FIXTURE_ROOT}/apks/ip-webcam.apk" 2>&1
    )"
    [[ "${validation_output}" == *"VALIDATED: Tailscale APK package is com.tailscale.ipn."* ]]
    [[ "${validation_output}" == *"VALIDATED: IP Webcam APK package is com.pas.webcam."* ]]
    [[ "${validation_output}" == *"without opening, copying, mounting, or changing an image"* ]]
done

degraded_output="$(
    run_with_inspector apkanalyzer --validate-apks-only 2>&1
)"
[[ "${degraded_output}" == *"DEGRADED: --tailscale-apk was omitted"* ]]
[[ "${degraded_output}" == *"DEGRADED: --ip-webcam-apk was omitted"* ]]

expect_failure \
    "Rejected Tailscale APK: expected package com.tailscale.ipn, found com.example.wrong." \
    run_with_inspector apkanalyzer \
    --validate-apks-only \
    --tailscale-apk "${FIXTURE_ROOT}/apks/wrong.apk"

expect_failure \
    "Tailscale APK changed while its package identity was being validated." \
    run_with_inspector apkanalyzer \
    --validate-apks-only \
    --tailscale-apk "${FIXTURE_ROOT}/apks/mutating.apk"

expect_failure \
    "Duplicate --tailscale-apk option." \
    run_with_inspector apkanalyzer \
    --validate-apks-only \
    --tailscale-apk "${FIXTURE_ROOT}/apks/tailscale.apk" \
    --tailscale-apk "${FIXTURE_ROOT}/apks/tailscale.apk"

expect_failure \
    "The same file cannot be supplied for both external APK options." \
    run_with_inspector apkanalyzer \
    --validate-apks-only \
    --tailscale-apk "${FIXTURE_ROOT}/apks/tailscale.apk" \
    --ip-webcam-apk "${FIXTURE_ROOT}/apks/tailscale.apk"

expect_failure \
    "--validate-apks-only does not accept image arguments." \
    run_with_inspector apkanalyzer \
    --validate-apks-only \
    unexpected-system.img

[[ ! -e "${MOUNT_MARKER}" ]] ||
    {
        echo "Validation fixture unexpectedly invoked mount." >&2
        exit 1
    }

echo "PASS: offline image optional-APK validation fixtures passed."
