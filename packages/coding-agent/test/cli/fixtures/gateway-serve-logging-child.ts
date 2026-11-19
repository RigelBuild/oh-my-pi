import { logger } from "@oh-my-pi/pi-utils";
import { runAuthGatewayCommand } from "../../../src/cli/auth-gateway-cli";

// A closed loopback port makes the broker snapshot fetch fail at once, so `runServe`
// rejects instead of blocking. The transports it sets must still apply to this record.
process.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:1";
process.env.OMP_AUTH_BROKER_TOKEN = "test-token";

await runAuthGatewayCommand({ action: "serve", flags: { gatewayToken: "test-token" } }).catch(() => undefined);
logger.info("gateway-serve-logging-probe");
