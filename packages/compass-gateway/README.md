# Compass gateway usage emitter

This private workspace package converts `GatewayUsageEvent` hooks into Compass `TokenUsageEvent` batches.

The gateway entrypoint creates an emitter with an injected sender and caller-identity attribution function, then passes `emitter.onUsage` as the auth-gateway `onUsage` boot option. Call `close()` during shutdown.
