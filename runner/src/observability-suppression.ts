import { AsyncLocalStorage } from "node:async_hooks";

const selfExportSuppression = new AsyncLocalStorage<true>();

/**
 * Runs a Qyl read operation in a context that self-telemetry exporters must
 * ignore. This prevents the workbench from recursively observing the queries
 * it performs to retrieve observability evidence.
 */
export function runWithObservabilitySelfExportSuppressed<T>(operation: () => T): T {
    return selfExportSuppression.run(true, operation);
}

/** True only while the current async call chain is reading Qyl evidence. */
export function isObservabilitySelfExportSuppressed(): boolean {
    return selfExportSuppression.getStore() === true;
}
