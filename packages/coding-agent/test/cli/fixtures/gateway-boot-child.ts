import { runGatewayBoot } from "../../../src/cli/gateway-boot";

await runGatewayBoot();
process.stdout.write("READY\n");
