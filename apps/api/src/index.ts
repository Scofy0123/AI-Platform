import { createApplication } from "./composition.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const application = await createApplication(config);
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  application.app.log.info({ signal }, "Stopping CodexPlatform");
  await application.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await application.app.listen({ host: config.server.host, port: config.server.port });
  application.app.log.info(
    {
      runtimeMode: config.runtime.mode,
      credentialIsolation: application.safetyProbe?.status ?? "SIMULATED",
    },
    "CodexPlatform is ready",
  );
} catch (error) {
  await application.close();
  throw error;
}
