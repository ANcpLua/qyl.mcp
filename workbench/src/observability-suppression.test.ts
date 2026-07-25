import assert from "node:assert/strict";
import test from "node:test";
import {
    isObservabilitySelfExportSuppressed,
    runWithObservabilitySelfExportSuppressed,
} from "./observability-suppression.js";

test("observability self-export suppression follows the async call chain and restores state", async () => {
    assert.equal(isObservabilitySelfExportSuppressed(), false);

    const result = await runWithObservabilitySelfExportSuppressed(async () => {
        assert.equal(isObservabilitySelfExportSuppressed(), true);
        await Promise.resolve();
        assert.equal(isObservabilitySelfExportSuppressed(), true);
        return 42;
    });

    assert.equal(result, 42);
    assert.equal(isObservabilitySelfExportSuppressed(), false);
});

test("nested suppression does not leak into neighboring async work", async () => {
    const neighboring = Promise.resolve().then(() => isObservabilitySelfExportSuppressed());
    const nested = runWithObservabilitySelfExportSuppressed(() =>
        runWithObservabilitySelfExportSuppressed(async () => {
            await Promise.resolve();
            return isObservabilitySelfExportSuppressed();
        }),
    );

    assert.equal(await neighboring, false);
    assert.equal(await nested, true);
    assert.equal(isObservabilitySelfExportSuppressed(), false);
});
