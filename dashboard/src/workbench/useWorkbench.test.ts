import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeNotice,
  removeNoticeByKey,
  type Notice,
} from "./useWorkbench.js";

test("connection notices coalesce and clear without hiding unrelated notices", () => {
  const initial: Notice[] = [
    { id: 1, tone: "info", message: "Execution accepted." },
    { id: 2, tone: "error", message: "Connection · Failed to fetch", key: "runner-connection" },
  ];

  const duplicate = mergeNotice(initial, {
    id: 3,
    tone: "error",
    message: "Connection · Failed to fetch",
    key: "runner-connection",
  });
  assert.deepEqual(duplicate, initial);

  const replaced = mergeNotice(duplicate, {
    id: 4,
    tone: "error",
    message: "Connection · Network request failed",
    key: "runner-connection",
  });
  assert.deepEqual(replaced, [
    initial[0],
    { id: 4, tone: "error", message: "Connection · Network request failed", key: "runner-connection" },
  ]);
  assert.deepEqual(removeNoticeByKey(replaced, "runner-connection"), [initial[0]]);
});

test("ordinary notices retain the existing four-item bound", () => {
  let notices: Notice[] = [];
  for (let id = 1; id <= 6; id += 1) {
    notices = mergeNotice(notices, { id, tone: "info", message: `notice-${id}` });
  }
  assert.deepEqual(notices.map((notice) => notice.id), [3, 4, 5, 6]);
});
