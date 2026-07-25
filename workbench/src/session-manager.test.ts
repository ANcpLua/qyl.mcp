import assert from "node:assert/strict";
import test from "node:test";
import {
    WORKBENCH_SESSION_COOKIE,
    WorkbenchSessionManager,
    readCookie,
} from "./session-manager.js";

test("workbench session uses HttpOnly SameSite cookie and returns metadata without the token", () => {
    const manager = new WorkbenchSessionManager({
        userId: "user-1",
        defaultWorkspaceId: "workspace-1",
        secureCookies: true,
        now: () => Date.parse("2026-07-15T00:00:00Z"),
    });
    const created = manager.create();
    assert.equal(created.identity.userId, "user-1");
    assert.equal(created.identity.defaultWorkspaceId, "workspace-1");
    assert.match(created.setCookie, /^qyl-workbench-session=/u);
    assert.match(created.setCookie, /HttpOnly/u);
    assert.match(created.setCookie, /SameSite=Strict/u);
    assert.match(created.setCookie, /Secure/u);
    assert.doesNotMatch(JSON.stringify(created.identity), /qyl-workbench-session|token|cookie/iu);

    const identity = manager.authenticate(created.setCookie);
    assert.deepEqual(identity, created.identity);
});

test("workbench session expires on idle or absolute timeout", () => {
    let now = 1_000_000;
    const manager = new WorkbenchSessionManager({
        idleTimeoutMs: 2_000,
        absoluteTimeoutMs: 5_000,
        now: () => now,
    });
    const created = manager.create();
    now += 1_000;
    assert.ok(manager.authenticate(created.setCookie));
    now += 2_000;
    assert.equal(manager.authenticate(created.setCookie), null);
    assert.equal(manager.size, 0);

    const second = manager.create();
    now += 1_000;
    assert.ok(manager.authenticate(second.setCookie));
    now += 1_000;
    assert.ok(manager.authenticate(second.setCookie));
    now += 3_000;
    assert.equal(manager.authenticate(second.setCookie), null);
});

test("revocation removes the session and returns an expired cookie", () => {
    const manager = new WorkbenchSessionManager();
    const created = manager.create();
    const cleared = manager.revoke(created.setCookie);
    assert.equal(manager.authenticate(created.setCookie), null);
    assert.match(cleared, new RegExp(`^${WORKBENCH_SESSION_COOKIE}=`));
    assert.match(cleared, /Max-Age=0/u);
});

test("cookie parsing handles multiple cookies and rejects malformed encoding", () => {
    assert.equal(readCookie("theme=dark; qyl-workbench-session=abc%20123; mode=dense", WORKBENCH_SESSION_COOKIE), "abc 123");
    assert.equal(readCookie("qyl-workbench-session=%E0%A4%A", WORKBENCH_SESSION_COOKIE), undefined);
    assert.equal(readCookie("qyl-workbench-session=", WORKBENCH_SESSION_COOKIE), undefined);
    assert.equal(readCookie(undefined, WORKBENCH_SESSION_COOKIE), undefined);
});

test("session timeout configuration is bounded", () => {
    assert.throws(() => new WorkbenchSessionManager({ idleTimeoutMs: 999 }), /between one second and 31 days/u);
    assert.throws(
        () => new WorkbenchSessionManager({ idleTimeoutMs: 5_000, absoluteTimeoutMs: 2_000 }),
        /cannot exceed/u,
    );
});
