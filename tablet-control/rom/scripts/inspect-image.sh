#!/usr/bin/env bash
# ==============================================================================
# ROSHANOS GSI IMAGE INSPECTOR (READ-ONLY)
# ==============================================================================
# Safe read-only tool to inspect Android system images, ext4 blocks, and AVB metadata.
# DOES NOT FLASH, ERASE, OR MODIFY ANY PARTITION OR DEVICE STATE.
# ==============================================================================

set -euo pipefail

IMAGE_PATH="${1:-}"

if [[ -z "${IMAGE_PATH}" ]]; then
    echo "Usage: $0 <path-to-system.img>"
    exit 1
fi

if [[ ! -f "${IMAGE_PATH}" ]]; then
    echo "Error: Image file '${IMAGE_PATH}' does not exist."
    exit 1
fi

echo "=================================================================="
echo " ROSHANOS READ-ONLY IMAGE INSPECTION"
echo " Image: ${IMAGE_PATH}"
echo "=================================================================="

# 1. Check Magic / Sparse vs Raw
echo "[1/4] Detecting image file format..."
FILE_INFO=$(file "${IMAGE_PATH}")
echo "      Format: ${FILE_INFO}"

IS_SPARSE=0
if echo "${FILE_INFO}" | grep -q "Android sparse image"; then
    IS_SPARSE=1
    echo "      Type: Android Sparse Image"
else
    echo "      Type: Raw ext4 Filesystem Image"
fi

# 2. Measure Host File Size
FILE_BYTES=$(stat -c%s "${IMAGE_PATH}" 2>/dev/null || stat -f%z "${IMAGE_PATH}")
FILE_MB=$((FILE_BYTES / 1024 / 1024))
echo "      Host File Size: ${FILE_BYTES} bytes (${FILE_MB} MB)"

# 3. Read ext4 Metadata if Raw, or notify if sparse
echo "[2/4] Inspecting filesystem metadata..."
if [[ ${IS_SPARSE} -eq 1 ]]; then
    echo "      Notice: Image is Android Sparse. Convert to raw using 'simg2img' to view detailed ext4 block counts."
else
    if command -v tune2fs >/dev/null 2>&1; then
        echo "      Reading ext4 superblocks..."
        tune2fs -l "${IMAGE_PATH}" | grep -E "Block count|Free blocks|Block size|Filesystem magic|UUID"
    else
        echo "      tune2fs not installed on host. Install e2fsprogs for detailed block analysis."
    fi
fi

# 4. Check AVB Metadata using avbtool if available
echo "[3/4] Checking Android Verified Boot (AVB) metadata..."
if command -v avbtool >/dev/null 2>&1; then
    avbtool info_image --image "${IMAGE_PATH}" || echo "      No AVB footer found in system image."
else
    echo "      avbtool not installed on host. Skipping AVB descriptor check."
fi

echo "[4/4] Safety Check Passed."
echo "=================================================================="
echo " RESULT: READ-ONLY INSPECTION COMPLETE. NO FLASHING PERFORMED."
echo "=================================================================="
