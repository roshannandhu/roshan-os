import { createConfig } from "./apps/controller-api/dist/config.js";
try {
  const cfg = createConfig();
  console.log("mode=" + cfg.adapterMode);
  console.log("fully=" + (cfg.fully ? cfg.fully.baseUrl : "NULL"));
  console.log("companion=" + (cfg.companion ? cfg.companion.baseUrl : "NULL"));
} catch (e) {
  console.log("ERROR: " + e.message);
}
