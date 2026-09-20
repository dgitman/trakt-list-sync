import { test } from "node:test";
import assert from "node:assert/strict";
import {
  synchronize,
  desired,
  type State,
  type Snapshot,
  type IO,
  type Member,
} from "../src/sync.ts";
const a: Member = "movie:1",
  b: Member = "show:2",
  c: Member = "episode:3";
function fixture(baseline: Member[], snapshot: Snapshot) {
  let saved: State = { baseline };
  let live = structuredClone(snapshot);
  let writes = 0;
  const io: IO = {
    read: async () => structuredClone(live),
    save: async (s) => {
      saved = structuredClone(s);
    },
    mutate: async (side, action, items) => {
      writes++;
      live[side] =
        action === "add"
          ? [...new Set([...live[side], ...items])]
          : live[side].filter((x) => !items.includes(x));
    },
  };
  return {
    io,
    get state() {
      return structuredClone(saved);
    },
    get live() {
      return live;
    },
    get writes() {
      return writes;
    },
  };
}
test("addition union and baseline removal wins", () => {
  assert.deepEqual(desired([a], [a, b], [c]), [c, b].sort());
});
test("sync preserves all media additions and propagates removal", async () => {
  const f = fixture([a], { david: [a, b], emalie: [c] });
  await synchronize(f.state, f.io);
  assert.deepEqual(f.state.baseline, [c, b].sort());
  assert.equal(f.state.pending, undefined);
  assert.deepEqual([...f.live.david].sort(), [c, b].sort());
});
test("unchanged membership performs no writes", async () => {
  const f = fixture([a], { david: [a], emalie: [a] });
  await synchronize(f.state, f.io);
  assert.equal(f.writes, 0);
});
test("failed reads never journal or mutate", async () => {
  const f = fixture([a], { david: [a], emalie: [a] });
  f.io.read = async () => {
    throw Error("incomplete");
  };
  await assert.rejects(synchronize(f.state, f.io));
  assert.equal(f.writes, 0);
  assert.equal(f.state.pending, undefined);
});
test("lost response after successful write resumes without treating it as removal", async () => {
  const f = fixture([], { david: [a], emalie: [] });
  const mutate = f.io.mutate;
  f.io.mutate = async (...args) => {
    await mutate(...args);
    throw Error("lost response");
  };
  await assert.rejects(synchronize(f.state, f.io));
  assert.deepEqual(f.state.baseline, []);
  f.io.mutate = mutate;
  await synchronize(f.state, f.io);
  assert.deepEqual(f.state.baseline, [a]);
  assert.equal(f.writes, 1);
});
test("partial batch resumes remaining items", async () => {
  const f = fixture([], { david: [a, b], emalie: [] });
  const mutate = f.io.mutate;
  f.io.mutate = async (side, action, items) => {
    await mutate(side, action, items.slice(0, 1));
    throw Error("partial");
  };
  await assert.rejects(synchronize(f.state, f.io));
  f.io.mutate = mutate;
  await synchronize(f.state, f.io);
  assert.deepEqual(f.state.baseline, [a, b]);
});
test("concurrent edit stops without overwriting user changes", async () => {
  const f = fixture([], { david: [a], emalie: [] });
  const mutate = f.io.mutate;
  f.io.mutate = async (...args) => {
    await mutate(...args);
    f.live.david.push(c);
  };
  await assert.rejects(synchronize(f.state, f.io));
  const before = f.writes;
  await assert.rejects(synchronize(f.state, f.io), /Concurrent/);
  assert.equal(f.writes, before);
  assert.deepEqual(f.state.baseline, []);
  assert.ok(f.live.david.includes(c));
});
test("dry run preserves pending desired and performs no writes", async () => {
  const f = fixture([], { david: [a], emalie: [a] });
  const state: State = {
    baseline: [],
    pending: {
      desired: [a],
      expected: { david: [a], emalie: [] },
      inflight: { side: "emalie", after: [a] },
      startedAt: "test",
    },
  };
  const before = structuredClone(state);
  const out = await synchronize(state, f.io, true);
  assert.deepEqual(out.desired, [a]);
  assert.deepEqual(state, before);
  assert.equal(f.writes, 0);
});
test("partial removals resume without resurrecting removed entries", async () => {
  const f = fixture([a, b], { david: [], emalie: [a, b] });
  const mutate = f.io.mutate;
  f.io.mutate = async (side, action, items) => {
    await mutate(side, action, items.slice(0, 1));
    throw Error("partial");
  };
  await assert.rejects(synchronize(f.state, f.io));
  f.io.mutate = mutate;
  await synchronize(f.state, f.io);
  assert.deepEqual(f.state.baseline, []);
  assert.deepEqual(f.live, { david: [], emalie: [] });
});
