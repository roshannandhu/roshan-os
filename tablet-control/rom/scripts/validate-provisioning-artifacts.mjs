#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");

const paths = {
  componentManifest: path.join(repositoryRoot, "rom", "manifest", "components.json"),
  androidManifest: path.join(
    repositoryRoot,
    "apps",
    "tablet-agent",
    "app",
    "src",
    "main",
    "AndroidManifest.xml"
  ),
  appBuildFile: path.join(repositoryRoot, "apps", "tablet-agent", "app", "build.gradle.kts"),
  imagePreparationScript: path.join(repositoryRoot, "rom", "scripts", "prepare-working-image.sh"),
  imagePreparationFixtureTest: path.join(
    repositoryRoot,
    "rom",
    "tests",
    "prepare-working-image-fixture-test.sh"
  ),
  permissionAllowlist: path.join(
    repositoryRoot,
    "rom",
    "staging",
    "system",
    "etc",
    "permissions",
    "privapp-permissions-roshan.xml"
  ),
  sysconfig: path.join(
    repositoryRoot,
    "rom",
    "staging",
    "system",
    "etc",
    "sysconfig",
    "roshan-sysconfig.xml"
  ),
  bootAnimation: path.join(
    repositoryRoot,
    "rom",
    "staging",
    "system",
    "media",
    "bootanimation.zip"
  ),
  bootArtwork: path.join(repositoryRoot, "rom", "branding", "roshanos-boot.svg"),
  bootBuildScript: path.join(repositoryRoot, "rom", "scripts", "build-bootanimation.ps1")
};

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function readStoredZipEntries(filePath) {
  const zip = fs.readFileSync(filePath);
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const flags = zip.readUInt16LE(offset + 6);
    const method = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const fileNameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    assert((flags & 0x08) === 0, "bootanimation.zip must not use ZIP data descriptors");
    assert(method === 0, "bootanimation.zip entries must be stored without compression");
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    assert(dataEnd <= zip.length, "bootanimation.zip contains a truncated entry");
    const name = zip.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    assert(!entries.has(name), `bootanimation.zip contains duplicate entry ${name}`);
    entries.set(name, zip.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }
  return entries;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function xmlComponentBlock(xml, tagName, shortClassName) {
  const escapedClass = escapeRegExp(shortClassName);
  const selfClosingExpression = new RegExp(
    `<${tagName}\\b(?=[^>]*android:name="${escapedClass}")[^>]*/>`,
    "m"
  );
  const selfClosingMatch = xml.match(selfClosingExpression);
  if (selfClosingMatch) {
    return selfClosingMatch[0];
  }
  const pairedExpression = new RegExp(
    `<${tagName}\\b(?=[^>]*android:name="${escapedClass}")[\\s\\S]*?<\\/${tagName}>`,
    "m"
  );
  const match = xml.match(pairedExpression);
  assert(match, `AndroidManifest.xml is missing <${tagName} android:name="${shortClassName}">`);
  return match[0];
}

function assertContains(text, expected, context) {
  assert(text.includes(expected), `${context} is missing ${expected}`);
}

function sorted(values) {
  return [...values].sort();
}

function assertSameValues(actual, expected, context) {
  const actualValues = [...actual];
  const expectedValues = [...expected];
  assert(
    JSON.stringify(sorted(actualValues)) === JSON.stringify(sorted(expectedValues)),
    `${context} mismatch.\nExpected: ${expectedValues.join(", ")}\nActual: ${actualValues.join(", ")}`
  );
}

function valuesFromXmlElements(xml, tagName) {
  const values = [];
  const expression = new RegExp(`<${tagName}\\b[^>]*android:name="([^"]+)"[^>]*/>`, "g");
  for (const match of xml.matchAll(expression)) {
    values.push(match[1]);
  }
  return values;
}

function declaredAndroidComponentClasses(xml, packageName) {
  const classes = [];
  const expression = /<(?:activity|service|receiver)\b[^>]*android:name="([^"]+)"/g;
  for (const match of xml.matchAll(expression)) {
    const className = match[1];
    classes.push(className.startsWith(".") ? `${packageName}${className}` : className);
  }
  return classes;
}

const expectedPackage = "com.tabletcontrol.companion";
const expectedShortOwner = `${expectedPackage}/.TabletDeviceAdminReceiver`;
const expectedFullOwner = `${expectedPackage}/${expectedPackage}.TabletDeviceAdminReceiver`;

const expectedBootActions = [
  "android.intent.action.LOCKED_BOOT_COMPLETED",
  "android.intent.action.BOOT_COMPLETED",
  "android.intent.action.USER_UNLOCKED",
  "android.intent.action.MY_PACKAGE_REPLACED"
];

const expectedProvisioningActivities = new Map([
  [".GetProvisioningModeActivity", "android.app.action.GET_PROVISIONING_MODE"],
  [".PolicyComplianceActivity", "android.app.action.ADMIN_POLICY_COMPLIANCE"],
  [".ProvisioningSuccessfulActivity", "android.app.action.PROVISIONING_SUCCESSFUL"]
]);

const componentManifest = readJson(paths.componentManifest);
const androidManifest = readText(paths.androidManifest);
const appBuildFile = readText(paths.appBuildFile);
const imagePreparationScript = readText(paths.imagePreparationScript);
const imagePreparationFixtureTest = readText(paths.imagePreparationFixtureTest);

assert(componentManifest.schema_version === 2, "components.json schema_version must be 2");
assert(
  componentManifest.package_name === expectedPackage,
  "components.json package_name is incorrect"
);
assertContains(
  appBuildFile,
  `applicationId = "${expectedPackage}"`,
  "apps/tablet-agent/app/build.gradle.kts"
);
assertContains(
  appBuildFile,
  `namespace = "${expectedPackage}"`,
  "apps/tablet-agent/app/build.gradle.kts"
);
assert(
  componentManifest.provisioning?.management_mode === "fully_managed_device",
  "components.json must declare fully_managed_device provisioning"
);
assert(
  componentManifest.provisioning?.device_owner_component === expectedShortOwner,
  "components.json short Device Owner component is incorrect"
);
assert(
  componentManifest.provisioning?.device_owner_component_fully_qualified === expectedFullOwner,
  "components.json fully-qualified Device Owner component is incorrect"
);
assert(
  componentManifest.provisioning?.self_assigns_device_owner === false,
  "components.json must not claim that RoshanOS self-assigns Device Owner"
);
assert(
  componentManifest.provisioning?.requires_unprovisioned_device === true,
  "components.json must record the unprovisioned-device requirement"
);

const core = componentManifest.components?.find(
  (component) => component.package === expectedPackage
);
assert(core, `components.json has no component group for ${expectedPackage}`);
const declaredComponents = new Map(core.contains.map((component) => [component.class, component]));
const expectedComponentClasses = [
  "com.tabletcontrol.companion.MainActivity",
  "com.tabletcontrol.companion.KioskActivity",
  "com.tabletcontrol.companion.GetProvisioningModeActivity",
  "com.tabletcontrol.companion.PolicyComplianceActivity",
  "com.tabletcontrol.companion.ProvisioningSuccessfulActivity",
  "com.tabletcontrol.companion.CompanionService",
  "com.tabletcontrol.companion.CameraService",
  "com.tabletcontrol.companion.BootReceiver",
  "com.tabletcontrol.companion.UpdateResultReceiver",
  "com.tabletcontrol.companion.TabletDeviceAdminReceiver"
];
assertSameValues(
  declaredComponents.keys(),
  expectedComponentClasses,
  "components.json component classes"
);
assertSameValues(
  declaredAndroidComponentClasses(androidManifest, expectedPackage),
  expectedComponentClasses,
  "application component classes in AndroidManifest.xml"
);
assert(
  !androidManifest.includes("<activity-alias"),
  "AndroidManifest.xml contains an untracked activity-alias"
);
assertSameValues(
  componentManifest.permissions_allowlist ?? [],
  [
    "android.permission.CHANGE_COMPONENT_ENABLED_STATE",
    "android.permission.INSTALL_SELF_UPDATES",
    "android.permission.MANAGE_ROLLBACKS"
  ],
  "components.json privileged-permission allowlist"
);
assert(
  componentManifest.self_update_policy?.target_package === expectedPackage,
  "components.json self-update target package is incorrect"
);
assert(
  componentManifest.self_update_policy?.installer === "android.content.pm.PackageInstaller",
  "components.json must require PackageInstaller for self updates"
);
assert(
  componentManifest.self_update_policy?.silent_permission ===
    "android.permission.INSTALL_SELF_UPDATES",
  "components.json must use the narrow self-update permission"
);
assert(
  componentManifest.self_update_policy?.generic_install_packages_permission === false,
  "components.json must reject generic INSTALL_PACKAGES authority"
);
assert(
  componentManifest.self_update_policy?.hidden_api_whitelisted_for_android_11_rollback === true,
  "components.json must record the Android 11 rollback hidden-API whitelist"
);
assert(
  componentManifest.self_update_policy?.automatic_boot_failure_rollback_guaranteed === false,
  "components.json must not claim guaranteed boot-failure rollback"
);
const optionalFactoryResetPackages = new Map(
  (componentManifest.optional_factory_reset_packages ?? []).map((entry) => [entry.package, entry])
);
const expectedOptionalFactoryResetPackages = new Map([
  [
    "com.tailscale.ipn",
    {
      name: "Tailscale",
      cliOption: "--tailscale-apk",
      target: "/system/app/RoshanTailscale/Tailscale.apk"
    }
  ],
  [
    "com.pas.webcam",
    {
      name: "IP Webcam",
      cliOption: "--ip-webcam-apk",
      target: "/system/app/RoshanIpWebcam/IPWebcam.apk"
    }
  ]
]);
assert(
  (componentManifest.optional_factory_reset_packages ?? []).length ===
    expectedOptionalFactoryResetPackages.size,
  "optional_factory_reset_packages must not contain duplicate or extra entries"
);
assertSameValues(
  optionalFactoryResetPackages.keys(),
  expectedOptionalFactoryResetPackages.keys(),
  "optional factory-reset package IDs"
);
for (const [packageName, expected] of expectedOptionalFactoryResetPackages) {
  const actual = optionalFactoryResetPackages.get(packageName);
  assert(actual.name === expected.name, `${packageName} has the wrong display name`);
  assert(actual.cli_option === expected.cliOption, `${packageName} has the wrong CLI option`);
  assert(
    actual.artifact_source === "caller_supplied_only",
    `${packageName} must remain caller-supplied`
  );
  assert(actual.target_location === expected.target, `${packageName} has the wrong target`);
  assert(
    actual.target_location.startsWith("/system/app/") &&
      !actual.target_location.includes("/priv-app/"),
    `${packageName} must be a non-privileged immutable system app`
  );
  assert(actual.priv_app === false, `${packageName} must not be marked privileged`);
  assert(
    actual.copy_policy === "byte_for_byte_unchanged",
    `${packageName} must use the unchanged-copy policy`
  );
  assert(
    actual.when_omitted === "degraded_factory_reset_persistence",
    `${packageName} omission must be reported as degraded`
  );

  for (const forbiddenKey of ["source_apk", "download_url", "url", "checksum", "sha256"]) {
    assert(!(forbiddenKey in actual), `${packageName} must not embed ${forbiddenKey}`);
  }

  assertContains(imagePreparationScript, expected.cliOption, "prepare-working-image.sh");
  assertContains(imagePreparationScript, packageName, "prepare-working-image.sh");
  assertContains(imagePreparationScript, expected.target, "prepare-working-image.sh");
}
for (const requiredText of [
  "--validate-apks-only",
  "ensure_optional_packages_absent",
  "ensure_safe_system_destination",
  "verify_unchanged_copy",
  "DEGRADED",
  "apkanalyzer",
  "aapt2",
  "aapt",
  "Block devices are never accepted",
  "Publishing the verified working image atomically"
]) {
  assertContains(imagePreparationScript, requiredText, "prepare-working-image.sh");
}
for (const requiredText of [
  "--validate-apks-only",
  "com.tailscale.ipn",
  "com.pas.webcam",
  "changed while its package identity was being validated",
  "unexpectedly invoked mount"
]) {
  assertContains(
    imagePreparationFixtureTest,
    requiredText,
    "prepare-working-image-fixture-test.sh"
  );
}
const configurationFiles = new Map(
  (componentManifest.configuration_files ?? []).map((entry) => [entry.source, entry])
);
const expectedConfigurationFiles = new Map([
  [
    "rom/staging/system/etc/permissions/privapp-permissions-roshan.xml",
    {
      target: "/system/etc/permissions/privapp-permissions-roshan.xml",
      mode: "0644"
    }
  ],
  [
    "rom/staging/system/etc/sysconfig/roshan-sysconfig.xml",
    {
      target: "/system/etc/sysconfig/roshan-sysconfig.xml",
      mode: "0644"
    }
  ]
]);
assertSameValues(
  configurationFiles.keys(),
  expectedConfigurationFiles.keys(),
  "components.json configuration file sources"
);
for (const [source, expected] of expectedConfigurationFiles) {
  const actual = configurationFiles.get(source);
  assert(actual.target === expected.target, `${source} has the wrong target path`);
  assert(actual.mode === expected.mode, `${source} has the wrong target mode`);
}

const brandingFiles = componentManifest.branding_files ?? [];
assert(brandingFiles.length === 1, "components.json must declare exactly one branding file");
const bootBranding = brandingFiles[0];
assert(
  bootBranding.source === "rom/staging/system/media/bootanimation.zip",
  "RoshanOS boot branding has the wrong source"
);
assert(
  bootBranding.editable_source === "rom/branding/roshanos-boot.svg",
  "RoshanOS boot branding has the wrong editable source"
);
assert(
  bootBranding.build_script === "rom/scripts/build-bootanimation.ps1",
  "RoshanOS boot branding has the wrong build script"
);
assert(
  bootBranding.target === "/system/media/bootanimation.zip" &&
    bootBranding.mode === "0644" &&
    bootBranding.format === "android_bootanimation_zip_stored",
  "RoshanOS boot branding target metadata is invalid"
);
assert(fs.statSync(paths.bootAnimation).size < 2 * 1024 * 1024, "bootanimation.zip is too large");
const bootEntries = readStoredZipEntries(paths.bootAnimation);
assertSameValues(bootEntries.keys(), ["desc.txt", "part0/00000.png"], "bootanimation.zip entries");
assert(
  bootEntries.get("desc.txt").toString("utf8") === "800 1280 30\np 0 0 part0\n",
  "bootanimation.zip descriptor is invalid"
);
const bootPng = bootEntries.get("part0/00000.png");
assert(
  bootPng.length >= 33 &&
    bootPng.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    bootPng.readUInt32BE(16) === 800 &&
    bootPng.readUInt32BE(20) === 1280,
  "RoshanOS boot frame must be a valid 800x1280 PNG"
);
assertContains(readText(paths.bootArtwork), ">RoshanOS</text>", "roshanos-boot.svg");
assertContains(readText(paths.bootBuildScript), "Write-StoredZip", "build-bootanimation.ps1");
assertContains(
  imagePreparationScript,
  "${SYSTEM_ROOT}/media/bootanimation.zip",
  "prepare-working-image.sh"
);

function declared(shortName) {
  const fullName = `${expectedPackage}${shortName}`;
  const component = declaredComponents.get(fullName);
  assert(component, `components.json is missing ${fullName}`);
  return component;
}

const mainActivity = declared(".MainActivity");
assert(mainActivity.enabled === true, "MainActivity must be recorded as enabled");
assert(mainActivity.exported === false, "MainActivity must be recorded as unexported");
assert(
  mainActivity.app_drawer_entry === false,
  "MainActivity must not be recorded as an app-drawer entry"
);
const mainActivityBlock = xmlComponentBlock(androidManifest, "activity", ".MainActivity");
assertContains(mainActivityBlock, 'android:enabled="true"', "MainActivity");
assertContains(mainActivityBlock, 'android:exported="false"', "MainActivity");
assertContains(mainActivityBlock, 'android:excludeFromRecents="true"', "MainActivity");
assert(
  !mainActivityBlock.includes("android.intent.category.LAUNCHER"),
  "MainActivity must not expose a LAUNCHER category"
);

const kiosk = declared(".KioskActivity");
assert(kiosk.exported === true, "KioskActivity must be recorded as exported");
assert(
  kiosk.exclude_from_recents === true,
  "KioskActivity must be recorded as excluded from recents"
);
assertSameValues(
  kiosk.intent_actions ?? [],
  ["android.intent.action.MAIN"],
  "KioskActivity actions in components.json"
);
assertSameValues(
  kiosk.intent_categories ?? [],
  ["android.intent.category.HOME", "android.intent.category.DEFAULT"],
  "KioskActivity categories in components.json"
);
assert(
  kiosk.app_drawer_entry === false,
  "KioskActivity must not be recorded as an app-drawer entry"
);
const kioskBlock = xmlComponentBlock(androidManifest, "activity", ".KioskActivity");
assertContains(kioskBlock, 'android:exported="true"', "KioskActivity");
assertContains(kioskBlock, 'android:excludeFromRecents="true"', "KioskActivity");
assertContains(kioskBlock, 'android:name="android.intent.action.MAIN"', "KioskActivity");
assertContains(kioskBlock, 'android:name="android.intent.category.HOME"', "KioskActivity");
assertContains(kioskBlock, 'android:name="android.intent.category.DEFAULT"', "KioskActivity");
assertSameValues(
  valuesFromXmlElements(kioskBlock, "action"),
  ["android.intent.action.MAIN"],
  "KioskActivity actions in AndroidManifest.xml"
);
assertSameValues(
  valuesFromXmlElements(kioskBlock, "category"),
  ["android.intent.category.HOME", "android.intent.category.DEFAULT"],
  "KioskActivity categories in AndroidManifest.xml"
);
assert(
  !kioskBlock.includes("android.intent.category.LAUNCHER"),
  "KioskActivity must not expose a LAUNCHER category"
);

for (const [shortName, action] of expectedProvisioningActivities) {
  const metadata = declared(shortName);
  assertSameValues(
    metadata.intent_actions ?? [],
    [action],
    `${shortName} actions in components.json`
  );
  assert(
    metadata.permission === "android.permission.BIND_DEVICE_ADMIN",
    `${shortName} must be protected by BIND_DEVICE_ADMIN in components.json`
  );
  assert(metadata.exported === true, `${shortName} must be recorded as exported`);
  assert(
    metadata.exclude_from_recents === true,
    `${shortName} must be recorded as excluded from recents`
  );
  assert(metadata.no_history === true, `${shortName} must be recorded with no history`);
  assert(
    metadata.theme === "@android:style/Theme.NoDisplay",
    `${shortName} must be recorded with Theme.NoDisplay`
  );
  assert(metadata.app_drawer_entry === false, `${shortName} must not be an app-drawer entry`);
  const block = xmlComponentBlock(androidManifest, "activity", shortName);
  assertContains(block, 'android:exported="true"', shortName);
  assertContains(block, 'android:excludeFromRecents="true"', shortName);
  assertContains(block, 'android:noHistory="true"', shortName);
  assertContains(block, 'android:permission="android.permission.BIND_DEVICE_ADMIN"', shortName);
  assertContains(block, `android:name="${action}"`, shortName);
  assertContains(block, 'android:theme="@android:style/Theme.NoDisplay"', shortName);
  assertSameValues(
    valuesFromXmlElements(block, "action"),
    [action],
    `${shortName} actions in AndroidManifest.xml`
  );
  assertSameValues(
    valuesFromXmlElements(block, "category"),
    ["android.intent.category.DEFAULT"],
    `${shortName} categories in AndroidManifest.xml`
  );
  assert(
    !block.includes("android.intent.category.LAUNCHER"),
    `${shortName} must not expose a LAUNCHER category`
  );
}

const companionService = declared(".CompanionService");
const companionServiceBlock = xmlComponentBlock(androidManifest, "service", ".CompanionService");
assert(companionService.exported === false, "CompanionService must be recorded as unexported");
assert(
  companionService.direct_boot_aware === true,
  "CompanionService must be recorded as direct-boot aware"
);
assertContains(companionServiceBlock, 'android:exported="false"', "CompanionService");
assertContains(companionServiceBlock, 'android:directBootAware="true"', "CompanionService");
assertContains(
  companionServiceBlock,
  'android:foregroundServiceType="dataSync|location"',
  "CompanionService"
);

const cameraService = declared(".CameraService");
const cameraServiceBlock = xmlComponentBlock(androidManifest, "service", ".CameraService");
assert(cameraService.exported === false, "CameraService must be recorded as unexported");
assertContains(cameraServiceBlock, 'android:exported="false"', "CameraService");
assertContains(
  cameraServiceBlock,
  'android:foregroundServiceType="camera|microphone"',
  "CameraService"
);

const bootReceiver = declared(".BootReceiver");
assert(bootReceiver.enabled === true, "BootReceiver must be recorded as enabled");
assert(bootReceiver.exported === true, "BootReceiver must be recorded as exported");
assertSameValues(
  bootReceiver.intent_actions ?? [],
  expectedBootActions,
  "BootReceiver actions in components.json"
);
assert(
  bootReceiver.direct_boot_aware === true,
  "BootReceiver must be recorded as direct-boot aware"
);
assertSameValues(
  bootReceiver.intent_categories ?? [],
  ["android.intent.category.DEFAULT"],
  "BootReceiver categories in components.json"
);
const bootReceiverBlock = xmlComponentBlock(androidManifest, "receiver", ".BootReceiver");
assertContains(bootReceiverBlock, 'android:enabled="true"', "BootReceiver");
assertContains(bootReceiverBlock, 'android:exported="true"', "BootReceiver");
for (const action of expectedBootActions) {
  assertContains(bootReceiverBlock, `android:name="${action}"`, "BootReceiver");
}
assertSameValues(
  valuesFromXmlElements(bootReceiverBlock, "action"),
  expectedBootActions,
  "BootReceiver actions in AndroidManifest.xml"
);
assertSameValues(
  valuesFromXmlElements(bootReceiverBlock, "category"),
  ["android.intent.category.DEFAULT"],
  "BootReceiver categories in AndroidManifest.xml"
);
assert(
  !bootReceiverBlock.includes("android.intent.action.QUICKBOOT_POWERON") &&
    !bootReceiverBlock.includes("com.htc.intent.action.QUICKBOOT_POWERON"),
  "BootReceiver unexpectedly registers a spoofable OEM quick-boot action"
);
assertContains(bootReceiverBlock, 'android:directBootAware="true"', "BootReceiver");

const updateResultReceiver = declared(".UpdateResultReceiver");
assert(updateResultReceiver.enabled === true, "UpdateResultReceiver must be recorded as enabled");
assert(
  updateResultReceiver.exported === false,
  "UpdateResultReceiver must be recorded as unexported"
);
assertSameValues(
  updateResultReceiver.intent_actions ?? [],
  [],
  "UpdateResultReceiver actions in components.json"
);
const updateResultReceiverBlock = xmlComponentBlock(
  androidManifest,
  "receiver",
  ".UpdateResultReceiver"
);
assertContains(updateResultReceiverBlock, 'android:enabled="true"', "UpdateResultReceiver");
assertContains(updateResultReceiverBlock, 'android:exported="false"', "UpdateResultReceiver");
assertSameValues(
  valuesFromXmlElements(updateResultReceiverBlock, "action"),
  [],
  "UpdateResultReceiver actions in AndroidManifest.xml"
);

const adminReceiver = declared(".TabletDeviceAdminReceiver");
assert(adminReceiver.exported === true, "TabletDeviceAdminReceiver must be recorded as exported");
assert(
  adminReceiver.permission === "android.permission.BIND_DEVICE_ADMIN",
  "TabletDeviceAdminReceiver must be protected by BIND_DEVICE_ADMIN in components.json"
);
assertSameValues(
  adminReceiver.intent_actions ?? [],
  ["android.app.action.DEVICE_ADMIN_ENABLED", "android.app.action.PROFILE_PROVISIONING_COMPLETE"],
  "TabletDeviceAdminReceiver actions in components.json"
);
assert(
  adminReceiver.metadata?.["android.app.device_admin"] === "@xml/device_admin_receiver",
  "TabletDeviceAdminReceiver device-admin metadata is incorrect in components.json"
);
const adminReceiverBlock = xmlComponentBlock(
  androidManifest,
  "receiver",
  ".TabletDeviceAdminReceiver"
);
assertContains(adminReceiverBlock, 'android:exported="true"', "TabletDeviceAdminReceiver");
assertContains(
  adminReceiverBlock,
  'android:permission="android.permission.BIND_DEVICE_ADMIN"',
  "TabletDeviceAdminReceiver"
);
assertContains(
  adminReceiverBlock,
  'android:name="android.app.device_admin"',
  "TabletDeviceAdminReceiver"
);
assertContains(
  adminReceiverBlock,
  'android:resource="@xml/device_admin_receiver"',
  "TabletDeviceAdminReceiver"
);
assertContains(
  adminReceiverBlock,
  'android:name="android.app.action.DEVICE_ADMIN_ENABLED"',
  "TabletDeviceAdminReceiver"
);
assertContains(
  adminReceiverBlock,
  'android:name="android.app.action.PROFILE_PROVISIONING_COMPLETE"',
  "TabletDeviceAdminReceiver"
);
assertSameValues(
  valuesFromXmlElements(adminReceiverBlock, "action"),
  ["android.app.action.DEVICE_ADMIN_ENABLED", "android.app.action.PROFILE_PROVISIONING_COMPLETE"],
  "TabletDeviceAdminReceiver actions in AndroidManifest.xml"
);

const qrRelativePath = componentManifest.provisioning.qr_payload_template;
const qrPath = path.join(repositoryRoot, ...qrRelativePath.split("/"));
const qrPayload = readJson(qrPath);
const allowedQrKeys = ["android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME"];
assertSameValues(Object.keys(qrPayload), allowedQrKeys, "QR payload keys");
assert(
  qrPayload["android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME"] === expectedShortOwner,
  "QR payload Device Owner component is incorrect"
);

const qrText = readText(qrPath);
const forbiddenQrPatterns = [
  /PASSWORD/i,
  /SECRET/i,
  /TOKEN/i,
  /DOWNLOAD_LOCATION/i,
  /CHECKSUM/i,
  /ADMIN_EXTRAS/i,
  /https?:\/\//i
];
for (const pattern of forbiddenQrPatterns) {
  assert(!pattern.test(qrText), `QR template contains forbidden content matching ${pattern}`);
}

for (const filePath of [paths.permissionAllowlist, paths.sysconfig]) {
  const xml = readText(filePath);
  assertContains(xml, `package="${expectedPackage}"`, path.relative(repositoryRoot, filePath));
}
assertContains(
  readText(paths.permissionAllowlist),
  '<permission name="android.permission.CHANGE_COMPONENT_ENABLED_STATE" />',
  "RoshanCore privileged-permission allowlist"
);
for (const permission of [
  "android.permission.INSTALL_SELF_UPDATES",
  "android.permission.MANAGE_ROLLBACKS"
]) {
  assertContains(
    androidManifest,
    `android:name="${permission}"`,
    "RoshanCore Android permission declarations"
  );
  assertContains(
    readText(paths.permissionAllowlist),
    `<permission name="${permission}" />`,
    "RoshanCore privileged-permission allowlist"
  );
}
assert(
  !androidManifest.includes('android:name="android.permission.INSTALL_PACKAGES"'),
  "RoshanCore must not request generic INSTALL_PACKAGES authority"
);
assertContains(
  readText(paths.sysconfig),
  `<rollback-whitelisted-app package="${expectedPackage}" />`,
  "RoshanCore Android 11 rollback whitelist"
);
assertContains(
  readText(paths.sysconfig),
  `<hidden-api-whitelisted-app package="${expectedPackage}" />`,
  "RoshanCore Android 11 rollback hidden-API whitelist"
);

console.log("PASS: RoshanOS provisioning artifacts match the Android manifest.");
console.log(`PASS: Device Owner component is ${expectedShortOwner}.`);
console.log(`PASS: secret-free QR payload contains ${allowedQrKeys.length} approved field.`);
console.log(`PASS: ${expectedBootActions.length} declared boot/package actions verified.`);
console.log(
  `PASS: ${expectedOptionalFactoryResetPackages.size} optional caller-supplied system-app contracts verified.`
);
