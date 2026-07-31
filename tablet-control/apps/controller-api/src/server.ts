import { loadEnv } from "./envLoader.js";
loadEnv();

import { createApp } from "./app.js";
import { createConfig } from "./config.js";
import { readDpapiCompanionSecretSync } from "./controller-secret-store.js";

const runtimeSecrets: { companionSecret?: string } = {};
if (process.env.CONTROLLER_LOAD_DPAPI_COMPANION_SECRET === "true") {
  runtimeSecrets.companionSecret = readDpapiCompanionSecretSync();
  delete process.env.TABLET_COMPANION_SECRET;
}
const config = createConfig({}, runtimeSecrets);
const app = createApp({ config });

try {
  await app.listen({ host: config.bindHost, port: config.port });
} catch (error) {
  console.error("Startup error:", error);
  app.log.error(error);
  process.exit(1);
}
