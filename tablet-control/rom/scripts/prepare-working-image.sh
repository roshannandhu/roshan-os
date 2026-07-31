#!/usr/bin/env bash
# Build an offline RoshanOS system image copy. This script never invokes
# fastboot, adb, flashing, formatting, or a block-device write.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
STAGING_ROOT="${REPO_ROOT}/rom/staging/system"
BOOT_ANIMATION="${STAGING_ROOT}/media/bootanimation.zip"
SETUPWIZARD_OVERLAY_APK="${REPO_ROOT}/rom/build/RoshanSetupWizardOverlay.apk"

TAILSCALE_APK=""
IP_WEBCAM_APK=""
TAILSCALE_OPTION_SEEN=0
IP_WEBCAM_OPTION_SEEN=0
VALIDATE_APKS_ONLY=0
POSITIONAL_ARGS=()

usage() {
    cat <<'EOF'
Usage:
  prepare-working-image.sh [OPTIONS] INPUT_SYSTEM_IMG [OUTPUT_RAW_IMG] [TARGET_MB] [ROSHANCORE_APK]
  prepare-working-image.sh --validate-apks-only [EXTERNAL_APK_OPTIONS]

Options:
  --tailscale-apk PATH     Embed this caller-supplied APK only if its package is
                           exactly com.tailscale.ipn.
  --ip-webcam-apk PATH     Embed this caller-supplied APK only if its package is
                           exactly com.pas.webcam.
  --validate-apks-only     Validate supplied external APK identities and exit
                           without opening, copying, mounting, or changing an image.
  -h, --help               Show this help.

The output is an offline raw ext4 image. Root privileges and Linux loop-mount
support are required for image preparation. The input image is never modified.

External APKs are optional and are never downloaded by this script. If an option
is omitted, the completed image is explicitly reported as degraded for that
package's factory-reset persistence.
EOF
}

die() {
    echo "FATAL: $*" >&2
    exit 1
}

warn() {
    echo "WARNING: $*" >&2
}

set_external_apk_option() {
    local option_name="$1"
    local option_value="$2"

    [[ -n "${option_value}" ]] || die "${option_name} requires a non-empty path."

    case "${option_name}" in
        --tailscale-apk)
            (( TAILSCALE_OPTION_SEEN == 0 )) ||
                die "Duplicate --tailscale-apk option."
            TAILSCALE_OPTION_SEEN=1
            TAILSCALE_APK="${option_value}"
            ;;
        --ip-webcam-apk)
            (( IP_WEBCAM_OPTION_SEEN == 0 )) ||
                die "Duplicate --ip-webcam-apk option."
            IP_WEBCAM_OPTION_SEEN=1
            IP_WEBCAM_APK="${option_value}"
            ;;
        *)
            die "Internal option parser error: ${option_name}"
            ;;
    esac
}

while (( $# > 0 )); do
    case "$1" in
        --tailscale-apk|--ip-webcam-apk)
            (( $# >= 2 )) || die "$1 requires a path."
            set_external_apk_option "$1" "$2"
            shift 2
            ;;
        --tailscale-apk=*)
            set_external_apk_option "--tailscale-apk" "${1#*=}"
            shift
            ;;
        --ip-webcam-apk=*)
            set_external_apk_option "--ip-webcam-apk" "${1#*=}"
            shift
            ;;
        --validate-apks-only)
            (( VALIDATE_APKS_ONLY == 0 )) ||
                die "Duplicate --validate-apks-only option."
            VALIDATE_APKS_ONLY=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        --)
            shift
            while (( $# > 0 )); do
                POSITIONAL_ARGS+=("$1")
                shift
            done
            ;;
        -*)
            die "Unknown option: $1"
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done

if (( VALIDATE_APKS_ONLY == 1 )); then
    (( ${#POSITIONAL_ARGS[@]} == 0 )) ||
        die "--validate-apks-only does not accept image arguments."
else
    (( ${#POSITIONAL_ARGS[@]} >= 1 )) || { usage; exit 2; }
    (( ${#POSITIONAL_ARGS[@]} <= 4 )) ||
        die "Too many positional arguments."
fi

INPUT_IMAGE="${POSITIONAL_ARGS[0]:-}"
OUTPUT_IMAGE="${POSITIONAL_ARGS[1]:-system_roshanos.raw.img}"
TARGET_MB="${POSITIONAL_ARGS[2]:-3500}"
ROSHAN_APK="${POSITIONAL_ARGS[3]:-${REPO_ROOT}/apps/tablet-agent/app/build/outputs/apk/release/app-release.apk}"

APK_INSPECTOR_KIND=""
APK_INSPECTOR_PATH=""
TAILSCALE_VALIDATED_SHA256=""
IP_WEBCAM_VALIDATED_SHA256=""

select_apk_inspector() {
    local candidate

    for candidate in apkanalyzer aapt2 aapt; do
        if command -v "${candidate}" >/dev/null 2>&1; then
            APK_INSPECTOR_KIND="${candidate}"
            APK_INSPECTOR_PATH="$(command -v "${candidate}")"
            return
        fi
    done

    die "Supplying an external APK requires apkanalyzer, aapt2, or aapt on PATH."
}

last_nonempty_line() {
    local input="$1"
    local line
    local result=""

    while IFS= read -r line; do
        line="${line%$'\r'}"
        [[ "${line}" =~ ^[[:space:]]*$ ]] || result="${line}"
    done <<<"${input}"

    result="${result#"${result%%[![:space:]]*}"}"
    result="${result%"${result##*[![:space:]]}"}"
    printf '%s\n' "${result}"
}

sha256_of() {
    local checksum_output
    checksum_output="$(sha256sum -- "$1")"
    printf '%s\n' "${checksum_output%% *}"
}

inspect_apk_package() {
    local apk_path="$1"
    local output
    local package_id=""
    local line

    case "${APK_INSPECTOR_KIND}" in
        apkanalyzer)
            output="$("${APK_INSPECTOR_PATH}" manifest application-id "${apk_path}" 2>/dev/null)" ||
                return 1
            package_id="$(last_nonempty_line "${output}")"
            ;;
        aapt2)
            output="$("${APK_INSPECTOR_PATH}" dump packagename "${apk_path}" 2>/dev/null)" ||
                return 1
            package_id="$(last_nonempty_line "${output}")"
            ;;
        aapt)
            output="$("${APK_INSPECTOR_PATH}" dump badging "${apk_path}" 2>/dev/null)" ||
                return 1
            while IFS= read -r line; do
                line="${line%$'\r'}"
                case "${line}" in
                    "package: name='"*)
                        package_id="${line#*name=\'}"
                        package_id="${package_id%%\'*}"
                        break
                        ;;
                esac
            done <<<"${output}"
            ;;
        *)
            return 1
            ;;
    esac

    [[ -n "${package_id}" ]] || return 1
    printf '%s\n' "${package_id}"
}

verify_external_apk() {
    local label="$1"
    local apk_path="$2"
    local expected_package="$3"
    local checksum_variable="$4"
    local actual_package
    local checksum_before
    local checksum_after

    [[ -f "${apk_path}" && ! -b "${apk_path}" ]] ||
        die "${label} APK is not a regular file: ${apk_path}"
    command -v sha256sum >/dev/null 2>&1 ||
        die "Supplying an external APK requires sha256sum."
    checksum_before="$(sha256_of "${apk_path}")"
    actual_package="$(inspect_apk_package "${apk_path}")" ||
        die "${APK_INSPECTOR_KIND} could not read the ${label} APK: ${apk_path}"
    checksum_after="$(sha256_of "${apk_path}")"
    [[ "${checksum_before}" == "${checksum_after}" ]] ||
        die "${label} APK changed while its package identity was being validated."
    [[ "${actual_package}" == "${expected_package}" ]] ||
        die "Rejected ${label} APK: expected package ${expected_package}, found ${actual_package}."
    printf -v "${checksum_variable}" '%s' "${checksum_after}"

    echo "VALIDATED: ${label} APK package is ${expected_package}."
}

if [[ -n "${TAILSCALE_APK}" && -n "${IP_WEBCAM_APK}" ]]; then
    [[ ! "${TAILSCALE_APK}" -ef "${IP_WEBCAM_APK}" ]] ||
        die "The same file cannot be supplied for both external APK options."
fi

if [[ -n "${TAILSCALE_APK}" || -n "${IP_WEBCAM_APK}" ]]; then
    select_apk_inspector
fi

if [[ -n "${TAILSCALE_APK}" ]]; then
    verify_external_apk \
        "Tailscale" "${TAILSCALE_APK}" "com.tailscale.ipn" \
        "TAILSCALE_VALIDATED_SHA256"
else
    warn "DEGRADED: --tailscale-apk was omitted; this image will not add factory-reset persistence for Tailscale."
fi

if [[ -n "${IP_WEBCAM_APK}" ]]; then
    verify_external_apk \
        "IP Webcam" "${IP_WEBCAM_APK}" "com.pas.webcam" \
        "IP_WEBCAM_VALIDATED_SHA256"
else
    warn "DEGRADED: --ip-webcam-apk was omitted; this image will not add factory-reset persistence for IP Webcam."
fi

if (( VALIDATE_APKS_ONLY == 1 )); then
    echo "External APK validation/degraded-state check completed without opening, copying, mounting, or changing an image."
    exit 0
fi

# All caller-supplied external APK identities have been proven before any
# working image or output directory is created.
[[ "${TARGET_MB}" =~ ^[0-9]+$ ]] || die "TARGET_MB must be a positive integer."
TARGET_MB_VALUE="$((10#${TARGET_MB}))"
(( TARGET_MB_VALUE >= 1024 )) || die "TARGET_MB is implausibly small."
[[ -f "${INPUT_IMAGE}" && ! -b "${INPUT_IMAGE}" ]] ||
    die "Input image is not a regular file: ${INPUT_IMAGE}"
[[ -f "${ROSHAN_APK}" && ! -b "${ROSHAN_APK}" ]] ||
    die "Signed RoshanCore APK is not a regular file: ${ROSHAN_APK}"
[[ -f "${STAGING_ROOT}/etc/permissions/privapp-permissions-roshan.xml" ]] ||
    die "Priv-app permission XML is missing from staging."
[[ -f "${STAGING_ROOT}/etc/sysconfig/roshan-sysconfig.xml" ]] ||
    die "RoshanOS sysconfig XML is missing from staging."
[[ -f "${BOOT_ANIMATION}" && ! -b "${BOOT_ANIMATION}" ]] ||
    die "RoshanOS bootanimation.zip is missing from staging."
[[ -f "${SETUPWIZARD_OVERLAY_APK}" && ! -b "${SETUPWIZARD_OVERLAY_APK}" ]] ||
    die "Signed RoshanOS Setup Wizard resource overlay is missing. Run rom/scripts/build-setupwizard-overlay.ps1."

command -v aapt2 >/dev/null 2>&1 ||
    die "aapt2 is required to validate the mandatory Setup Wizard overlay."
SETUP_OVERLAY_BADGING="$(aapt2 dump badging "${SETUPWIZARD_OVERLAY_APK}" 2>/dev/null)" ||
    die "aapt2 could not inspect the mandatory Setup Wizard overlay."
[[ "${SETUP_OVERLAY_BADGING}" == *"package: name='com.tabletcontrol.roshanos.setupwizard.overlay'"* ]] ||
    die "Setup Wizard overlay has the wrong package ID."
[[ "${SETUP_OVERLAY_BADGING}" == *"overlay: targetPackage='org.lineageos.setupwizard' priority='10' isStatic='true'"* ]] ||
    die "Setup Wizard overlay has the wrong target, priority, or static policy."
unzip -Z1 "${SETUPWIZARD_OVERLAY_APK}" |
    grep -Fxq "classes.dex" &&
    die "Setup Wizard overlay must not contain executable DEX code."

for command_name in \
    file stat sha256sum truncate e2fsck resize2fs tune2fs mount umount install findmnt \
    find readlink cp mv mkdir mktemp rm grep id chown chmod sync unzip; do
    command -v "${command_name}" >/dev/null 2>&1 ||
        die "Required command is missing: ${command_name}"
done

if command -v setfattr >/dev/null 2>&1; then
    LABEL_TOOL="setfattr"
elif command -v chcon >/dev/null 2>&1; then
    LABEL_TOOL="chcon"
else
    die "setfattr or chcon is required to apply SELinux labels."
fi

[[ "$(id -u)" -eq 0 ]] ||
    die "Run as root inside a Linux environment with loop-mount support."

INPUT_ABS="$(readlink -f -- "${INPUT_IMAGE}")"
ROSHAN_APK_ABS="$(readlink -f -- "${ROSHAN_APK}")"
SETUPWIZARD_OVERLAY_APK_ABS="$(readlink -f -- "${SETUPWIZARD_OVERLAY_APK}")"
TAILSCALE_APK_ABS=""
IP_WEBCAM_APK_ABS=""
[[ -z "${TAILSCALE_APK}" ]] ||
    TAILSCALE_APK_ABS="$(readlink -f -- "${TAILSCALE_APK}")"
[[ -z "${IP_WEBCAM_APK}" ]] ||
    IP_WEBCAM_APK_ABS="$(readlink -f -- "${IP_WEBCAM_APK}")"

if [[ -e "${OUTPUT_IMAGE}" || -L "${OUTPUT_IMAGE}" ]]; then
    [[ -f "${OUTPUT_IMAGE}" && ! -L "${OUTPUT_IMAGE}" ]] ||
        die "An existing output must be a regular, non-symlink file: ${OUTPUT_IMAGE}"
fi
OUTPUT_PARENT="$(dirname -- "${OUTPUT_IMAGE}")"
OUTPUT_PARENT_ABS="$(readlink -m -- "${OUTPUT_PARENT}")"
case "${OUTPUT_PARENT_ABS}" in
    /dev|/dev/*|/proc|/proc/*|/sys|/sys/*)
        die "Output is forbidden under a device or kernel pseudo-filesystem: ${OUTPUT_PARENT_ABS}"
        ;;
esac
mkdir -p -- "${OUTPUT_PARENT}"
OUTPUT_PARENT_ABS="$(readlink -f -- "${OUTPUT_PARENT}")"
OUTPUT_ABS="${OUTPUT_PARENT_ABS}/$(basename -- "${OUTPUT_IMAGE}")"

[[ "${INPUT_ABS}" != "${OUTPUT_ABS}" ]] ||
    die "Output must not overwrite the input image."
[[ "${ROSHAN_APK_ABS}" != "${OUTPUT_ABS}" ]] ||
    die "Output must not overwrite the RoshanCore APK."
[[ "${SETUPWIZARD_OVERLAY_APK_ABS}" != "${OUTPUT_ABS}" ]] ||
    die "Output must not overwrite the RoshanOS Setup Wizard overlay APK."
[[ -z "${TAILSCALE_APK_ABS}" || "${TAILSCALE_APK_ABS}" != "${OUTPUT_ABS}" ]] ||
    die "Output must not overwrite the caller-supplied Tailscale APK."
[[ -z "${IP_WEBCAM_APK_ABS}" || "${IP_WEBCAM_APK_ABS}" != "${OUTPUT_ABS}" ]] ||
    die "Output must not overwrite the caller-supplied IP Webcam APK."
[[ ! -b "${INPUT_ABS}" && ! -b "${OUTPUT_ABS}" ]] ||
    die "Block devices are never accepted as input or output."

INPUT_FILE_DESCRIPTION="$(file -- "${INPUT_ABS}")"
if [[ "${INPUT_FILE_DESCRIPTION}" == *"Android sparse image"* ]]; then
    command -v simg2img >/dev/null 2>&1 ||
        die "simg2img is required for a sparse input image."
    INPUT_IS_SPARSE=1
else
    INPUT_IS_SPARSE=0
fi

WORK_DIR="$(mktemp -d -t roshanos-image.XXXXXXXX)"
WORK_IMAGE="${WORK_DIR}/system.raw.img"
MOUNT_DIR="${WORK_DIR}/mnt"
MOUNTED=0
OUTPUT_TEMP=""

cleanup() {
    if [[ "${MOUNTED}" -eq 1 ]] &&
        findmnt -rn --target "${MOUNT_DIR}" >/dev/null 2>&1; then
        umount -- "${MOUNT_DIR}" || true
    fi
    if [[ -n "${OUTPUT_TEMP}" &&
        "${OUTPUT_TEMP}" == "${OUTPUT_ABS}.partial."* ]]; then
        rm -f -- "${OUTPUT_TEMP}"
    fi
    if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" &&
        "$(basename -- "${WORK_DIR}")" == roshanos-image.* ]]; then
        rm -rf -- "${WORK_DIR}"
    fi
}
trap cleanup EXIT INT TERM

mkdir -p -- "${MOUNT_DIR}"

echo "[1/8] Creating an isolated raw working copy."
if (( INPUT_IS_SPARSE == 1 )); then
    simg2img "${INPUT_ABS}" "${WORK_IMAGE}"
else
    cp --reflink=auto --sparse=always -- "${INPUT_ABS}" "${WORK_IMAGE}"
fi

CURRENT_BYTES="$(stat -c '%s' -- "${WORK_IMAGE}")"
TARGET_BYTES="$((TARGET_MB_VALUE * 1024 * 1024))"
(( TARGET_BYTES >= CURRENT_BYTES )) ||
    die "TARGET_MB is smaller than the current raw image ($((CURRENT_BYTES / 1024 / 1024)) MiB)."

echo "[2/8] Checking and expanding ext4 to ${TARGET_MB_VALUE} MiB."
set +e
e2fsck -fy -- "${WORK_IMAGE}"
FSCK_RC=$?
set -e
(( FSCK_RC <= 2 )) || die "Initial e2fsck failed with status ${FSCK_RC}."
truncate -s "${TARGET_BYTES}" -- "${WORK_IMAGE}"
resize2fs "${WORK_IMAGE}"

# Android GSIs commonly use ext4 shared_blocks deduplication. Such an image is
# intentionally read-only and a writable loop mount fails with EIO. Expand
# first so enough free blocks exist, then materialize every shared extent in
# this isolated copy. The source image is never changed.
FILESYSTEM_FEATURES="$(tune2fs -l "${WORK_IMAGE}" 2>/dev/null |
    grep -m1 '^Filesystem features:' || true)"
if [[ "${FILESYSTEM_FEATURES}" == *"shared_blocks"* ]]; then
    echo "      Materializing Android shared blocks for a writable offline copy."
    set +e
    e2fsck -fy -E unshare_blocks -- "${WORK_IMAGE}"
    FSCK_RC=$?
    set -e
    (( FSCK_RC <= 2 )) ||
        die "Shared-block materialization failed with status ${FSCK_RC}."
    FILESYSTEM_FEATURES="$(tune2fs -l "${WORK_IMAGE}" 2>/dev/null |
        grep -m1 '^Filesystem features:' || true)"
    [[ "${FILESYSTEM_FEATURES}" != *"shared_blocks"* ]] ||
        die "shared_blocks remained after materialization."
fi

echo "[3/8] Mounting the working copy only."
mount -o loop,rw,nodev,nosuid -- "${WORK_IMAGE}" "${MOUNT_DIR}"
MOUNTED=1
findmnt -rn --target "${MOUNT_DIR}" >/dev/null ||
    die "The working image did not mount."

# Some GSIs expose /system at the filesystem root; system-as-root layouts have
# a nested /system. Detect the real partition layout instead of assuming it.
if [[ -d "${MOUNT_DIR}/system/priv-app" ]]; then
    SYSTEM_ROOT="${MOUNT_DIR}/system"
elif [[ -d "${MOUNT_DIR}/priv-app" ]]; then
    SYSTEM_ROOT="${MOUNT_DIR}"
else
    die "Mounted image has neither /priv-app nor /system/priv-app."
fi
SYSTEM_ROOT_ABS="$(readlink -f -- "${SYSTEM_ROOT}")"

ensure_safe_system_destination() {
    local destination="$1"
    local resolved_destination

    [[ ! -L "${destination}" ]] ||
        die "Refusing symlink destination in the working image: ${destination}"
    resolved_destination="$(readlink -m -- "${destination}")"
    [[ "${resolved_destination}" == "${SYSTEM_ROOT_ABS}/"* ]] ||
        die "Destination escapes the mounted system root: ${destination}"
}

ensure_optional_packages_absent() {
    local existing_apk
    local existing_package

    [[ -z "${TAILSCALE_APK_ABS}" ||
        ( ! -e "${TAILSCALE_TARGET_DIR}" && ! -L "${TAILSCALE_TARGET_DIR}" ) ]] ||
        die "Refusing to replace existing Tailscale target directory: ${TAILSCALE_TARGET_DIR}"
    [[ -z "${IP_WEBCAM_APK_ABS}" ||
        ( ! -e "${IP_WEBCAM_TARGET_DIR}" && ! -L "${IP_WEBCAM_TARGET_DIR}" ) ]] ||
        die "Refusing to replace existing IP Webcam target directory: ${IP_WEBCAM_TARGET_DIR}"

    while IFS= read -r -d '' existing_apk; do
        existing_package="$(inspect_apk_package "${existing_apk}")" ||
            die "${APK_INSPECTOR_KIND} could not inspect existing system APK: ${existing_apk}"
        if [[ -n "${TAILSCALE_APK_ABS}" &&
            "${existing_package}" == "com.tailscale.ipn" ]]; then
            die "Duplicate Tailscale package com.tailscale.ipn already exists at ${existing_apk}."
        fi
        if [[ -n "${IP_WEBCAM_APK_ABS}" &&
            "${existing_package}" == "com.pas.webcam" ]]; then
            die "Duplicate IP Webcam package com.pas.webcam already exists at ${existing_apk}."
        fi
    done < <(find "${SYSTEM_ROOT}" -xdev -type f -name '*.apk' -print0)
}

TAILSCALE_TARGET_DIR="${SYSTEM_ROOT}/app/RoshanTailscale"
TAILSCALE_TARGET_APK="${TAILSCALE_TARGET_DIR}/Tailscale.apk"
IP_WEBCAM_TARGET_DIR="${SYSTEM_ROOT}/app/RoshanIpWebcam"
IP_WEBCAM_TARGET_APK="${IP_WEBCAM_TARGET_DIR}/IPWebcam.apk"
SETUP_OVERLAY_TARGET_DIR="${SYSTEM_ROOT}/product/overlay/RoshanSetupWizardOverlay"
SETUP_OVERLAY_TARGET_APK="${SETUP_OVERLAY_TARGET_DIR}/RoshanSetupWizardOverlay.apk"

[[ -d "${SYSTEM_ROOT}/product/overlay" ]] ||
    die "Target GSI does not expose the expected /product/overlay directory."

ensure_safe_system_destination "${SYSTEM_ROOT}/priv-app/RoshanCore"
ensure_safe_system_destination \
    "${SYSTEM_ROOT}/priv-app/RoshanCore/RoshanCore.apk"
ensure_safe_system_destination \
    "${SYSTEM_ROOT}/etc/permissions/privapp-permissions-roshan.xml"
ensure_safe_system_destination \
    "${SYSTEM_ROOT}/etc/sysconfig/roshan-sysconfig.xml"
ensure_safe_system_destination \
    "${SYSTEM_ROOT}/media/bootanimation.zip"
ensure_safe_system_destination "${SETUP_OVERLAY_TARGET_DIR}"
ensure_safe_system_destination "${SETUP_OVERLAY_TARGET_APK}"
[[ -z "${TAILSCALE_APK_ABS}" ]] || {
    ensure_safe_system_destination "${TAILSCALE_TARGET_DIR}"
    ensure_safe_system_destination "${TAILSCALE_TARGET_APK}"
}
[[ -z "${IP_WEBCAM_APK_ABS}" ]] || {
    ensure_safe_system_destination "${IP_WEBCAM_TARGET_DIR}"
    ensure_safe_system_destination "${IP_WEBCAM_TARGET_APK}"
}

# Detect every known duplicate before injecting any optional package.
[[ -z "${TAILSCALE_APK_ABS}" && -z "${IP_WEBCAM_APK_ABS}" ]] ||
    ensure_optional_packages_absent

echo "[4/8] Injecting RoshanCore, setup branding, policy files, and validated optional system apps."
install -d -o 0 -g 0 -m 0755 "${SYSTEM_ROOT}/priv-app/RoshanCore"
install -o 0 -g 0 -m 0644 "${ROSHAN_APK_ABS}" \
    "${SYSTEM_ROOT}/priv-app/RoshanCore/RoshanCore.apk"
install -d -o 0 -g 0 -m 0755 "${SYSTEM_ROOT}/etc/permissions"
install -o 0 -g 0 -m 0644 \
    "${STAGING_ROOT}/etc/permissions/privapp-permissions-roshan.xml" \
    "${SYSTEM_ROOT}/etc/permissions/privapp-permissions-roshan.xml"
install -d -o 0 -g 0 -m 0755 "${SYSTEM_ROOT}/etc/sysconfig"
install -o 0 -g 0 -m 0644 \
    "${STAGING_ROOT}/etc/sysconfig/roshan-sysconfig.xml" \
    "${SYSTEM_ROOT}/etc/sysconfig/roshan-sysconfig.xml"
install -d -o 0 -g 0 -m 0755 "${SYSTEM_ROOT}/media"
install -o 0 -g 0 -m 0644 \
    "${BOOT_ANIMATION}" \
    "${SYSTEM_ROOT}/media/bootanimation.zip"
install -d -o 0 -g 0 -m 0755 "${SETUP_OVERLAY_TARGET_DIR}"
install -o 0 -g 0 -m 0644 \
    "${SETUPWIZARD_OVERLAY_APK_ABS}" \
    "${SETUP_OVERLAY_TARGET_APK}"

OPTIONAL_STAGED_PATHS=()
OPTIONAL_APK_PATHS=()

if [[ -n "${TAILSCALE_APK_ABS}" ]]; then
    install -d -o 0 -g 0 -m 0755 "${TAILSCALE_TARGET_DIR}"
    install -o 0 -g 0 -m 0644 \
        "${TAILSCALE_APK_ABS}" "${TAILSCALE_TARGET_APK}"
    OPTIONAL_STAGED_PATHS+=("${TAILSCALE_TARGET_DIR}" "${TAILSCALE_TARGET_APK}")
    OPTIONAL_APK_PATHS+=("${TAILSCALE_TARGET_APK}")
fi

if [[ -n "${IP_WEBCAM_APK_ABS}" ]]; then
    install -d -o 0 -g 0 -m 0755 "${IP_WEBCAM_TARGET_DIR}"
    install -o 0 -g 0 -m 0644 \
        "${IP_WEBCAM_APK_ABS}" "${IP_WEBCAM_TARGET_APK}"
    OPTIONAL_STAGED_PATHS+=("${IP_WEBCAM_TARGET_DIR}" "${IP_WEBCAM_TARGET_APK}")
    OPTIONAL_APK_PATHS+=("${IP_WEBCAM_TARGET_APK}")
fi

echo "[5/8] Applying and verifying Android filesystem metadata."
ROSHAN_PATHS=(
    "${SYSTEM_ROOT}/priv-app/RoshanCore"
    "${SYSTEM_ROOT}/priv-app/RoshanCore/RoshanCore.apk"
    "${SYSTEM_ROOT}/etc/permissions/privapp-permissions-roshan.xml"
    "${SYSTEM_ROOT}/etc/sysconfig/roshan-sysconfig.xml"
    "${SYSTEM_ROOT}/media"
    "${SYSTEM_ROOT}/media/bootanimation.zip"
    "${OPTIONAL_STAGED_PATHS[@]}"
)
for staged_path in "${ROSHAN_PATHS[@]}"; do
    chown 0:0 -- "${staged_path}"
done
chmod 0755 -- \
    "${SYSTEM_ROOT}/priv-app/RoshanCore" \
    "${SYSTEM_ROOT}/media"
chmod 0644 -- \
    "${SYSTEM_ROOT}/priv-app/RoshanCore/RoshanCore.apk" \
    "${SYSTEM_ROOT}/etc/permissions/privapp-permissions-roshan.xml" \
    "${SYSTEM_ROOT}/etc/sysconfig/roshan-sysconfig.xml" \
    "${SYSTEM_ROOT}/media/bootanimation.zip"
[[ -z "${TAILSCALE_APK_ABS}" ]] || {
    chmod 0755 -- "${TAILSCALE_TARGET_DIR}"
    chmod 0644 -- "${TAILSCALE_TARGET_APK}"
}
[[ -z "${IP_WEBCAM_APK_ABS}" ]] || {
    chmod 0755 -- "${IP_WEBCAM_TARGET_DIR}"
    chmod 0644 -- "${IP_WEBCAM_TARGET_APK}"
}

if [[ "${LABEL_TOOL}" == "setfattr" ]]; then
    for staged_path in "${ROSHAN_PATHS[@]}"; do
        setfattr -n security.selinux -v "u:object_r:system_file:s0" -- "${staged_path}"
    done
else
    chcon "u:object_r:system_file:s0" -- "${ROSHAN_PATHS[@]}"
fi

chown 0:0 -- "${SETUP_OVERLAY_TARGET_DIR}" "${SETUP_OVERLAY_TARGET_APK}"
chmod 0755 -- "${SETUP_OVERLAY_TARGET_DIR}"
chmod 0644 -- "${SETUP_OVERLAY_TARGET_APK}"
if [[ "${LABEL_TOOL}" == "setfattr" ]]; then
    setfattr -n security.selinux -v "u:object_r:vendor_overlay_file:s0" -- \
        "${SETUP_OVERLAY_TARGET_DIR}" "${SETUP_OVERLAY_TARGET_APK}"
else
    chcon "u:object_r:vendor_overlay_file:s0" -- \
        "${SETUP_OVERLAY_TARGET_DIR}" "${SETUP_OVERLAY_TARGET_APK}"
fi

verify_mode() {
    local path_to_verify="$1"
    local expected_mode="$2"
    local label="$3"

    [[ "$(stat -c '%u:%g:%a' -- "${path_to_verify}")" == "0:0:${expected_mode}" ]] ||
        die "${label} ownership or mode verification failed."
}

verify_mode \
    "${SYSTEM_ROOT}/priv-app/RoshanCore/RoshanCore.apk" "644" "RoshanCore.apk"
verify_mode \
    "${SYSTEM_ROOT}/priv-app/RoshanCore" "755" "RoshanCore directory"
verify_mode \
    "${SYSTEM_ROOT}/media/bootanimation.zip" "644" "RoshanOS boot animation"
verify_mode \
    "${SETUP_OVERLAY_TARGET_DIR}" "755" "RoshanOS Setup Wizard overlay directory"
verify_mode \
    "${SETUP_OVERLAY_TARGET_APK}" "644" "RoshanOS Setup Wizard overlay APK"
[[ -z "${TAILSCALE_APK_ABS}" ]] || {
    verify_mode "${TAILSCALE_TARGET_DIR}" "755" "Tailscale directory"
    verify_mode "${TAILSCALE_TARGET_APK}" "644" "Tailscale APK"
}
[[ -z "${IP_WEBCAM_APK_ABS}" ]] || {
    verify_mode "${IP_WEBCAM_TARGET_DIR}" "755" "IP Webcam directory"
    verify_mode "${IP_WEBCAM_TARGET_APK}" "644" "IP Webcam APK"
}

if command -v getfattr >/dev/null 2>&1; then
    for staged_file in \
        "${SYSTEM_ROOT}/priv-app/RoshanCore/RoshanCore.apk" \
        "${SYSTEM_ROOT}/media/bootanimation.zip" \
        "${OPTIONAL_APK_PATHS[@]}"; do
        getfattr --only-values -n security.selinux \
            "${staged_file}" 2>/dev/null |
            grep -Fxq "u:object_r:system_file:s0" ||
             die "$(basename -- "${staged_file}") SELinux label verification failed."
    done
    getfattr --only-values -n security.selinux \
        "${SETUP_OVERLAY_TARGET_APK}" 2>/dev/null |
        grep -Fxq "u:object_r:vendor_overlay_file:s0" ||
        die "RoshanOS Setup Wizard overlay SELinux label verification failed."
fi

verify_unchanged_copy() {
    local source_path="$1"
    local destination_path="$2"
    local label="$3"
    local validated_checksum="$4"
    local source_checksum
    local destination_checksum

    source_checksum="$(sha256_of "${source_path}")"
    destination_checksum="$(sha256_of "${destination_path}")"
    [[ "${source_checksum}" == "${validated_checksum}" ]] ||
        die "${label} source changed after package validation."
    [[ "${destination_checksum}" == "${validated_checksum}" ]] ||
        die "${label} content changed during image injection."
}

[[ -z "${TAILSCALE_APK_ABS}" ]] ||
    verify_unchanged_copy \
        "${TAILSCALE_APK_ABS}" "${TAILSCALE_TARGET_APK}" "Tailscale APK" \
        "${TAILSCALE_VALIDATED_SHA256}"
[[ -z "${IP_WEBCAM_APK_ABS}" ]] ||
    verify_unchanged_copy \
        "${IP_WEBCAM_APK_ABS}" "${IP_WEBCAM_TARGET_APK}" "IP Webcam APK" \
        "${IP_WEBCAM_VALIDATED_SHA256}"
[[ "$(sha256_of "${SETUPWIZARD_OVERLAY_APK_ABS}")" ==
    "$(sha256_of "${SETUP_OVERLAY_TARGET_APK}")" ]] ||
    die "RoshanOS Setup Wizard overlay changed during image injection."

echo "[6/8] Recording checksums without exposing credentials."
CHECKSUM_PATHS=(
    "${SYSTEM_ROOT}/priv-app/RoshanCore/RoshanCore.apk"
    "${SYSTEM_ROOT}/etc/permissions/privapp-permissions-roshan.xml"
    "${SYSTEM_ROOT}/etc/sysconfig/roshan-sysconfig.xml"
    "${SYSTEM_ROOT}/media/bootanimation.zip"
    "${SETUP_OVERLAY_TARGET_APK}"
    "${OPTIONAL_APK_PATHS[@]}"
)
sha256sum -- "${CHECKSUM_PATHS[@]}"
sync

echo "[7/8] Unmounting and validating the completed filesystem."
umount -- "${MOUNT_DIR}"
MOUNTED=0
set +e
e2fsck -fy -- "${WORK_IMAGE}"
FSCK_RC=$?
set -e
(( FSCK_RC <= 2 )) || die "Final e2fsck failed with status ${FSCK_RC}."

echo "[8/8] Publishing the verified working image atomically."
OUTPUT_TEMP="${OUTPUT_ABS}.partial.$$"
cp --reflink=auto --sparse=always -- "${WORK_IMAGE}" "${OUTPUT_TEMP}"
mv -f -- "${OUTPUT_TEMP}" "${OUTPUT_ABS}"
OUTPUT_TEMP=""
sha256sum -- "${OUTPUT_ABS}"

cat <<EOF
RoshanOS offline image prepared successfully:
  ${OUTPUT_ABS}

Factory-reset persistence:
  RoshanCore: PERSISTENT (/system/priv-app/RoshanCore/RoshanCore.apk)
  Setup UI:   PERSISTENT (/product/overlay/RoshanSetupWizardOverlay/RoshanSetupWizardOverlay.apk)
  Tailscale:  $([[ -n "${TAILSCALE_APK_ABS}" ]] &&
      printf '%s' 'PERSISTENT (/system/app/RoshanTailscale/Tailscale.apk)' ||
      printf '%s' 'DEGRADED (caller APK omitted)')
  IP Webcam: $([[ -n "${IP_WEBCAM_APK_ABS}" ]] &&
      printf '%s' 'PERSISTENT (/system/app/RoshanIpWebcam/IPWebcam.apk)' ||
      printf '%s' 'DEGRADED (caller APK omitted)')

No tablet partition was modified. Before any future flash, independently verify
the image, every APK signing certificate, redistribution rights, vbmeta/AVB plan,
rollback images, and exact target device.
EOF
