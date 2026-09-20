export type Member = `${"movie" | "show" | "season" | "episode"}:${number}`;
export type Side = "david" | "emalie";
export const sides: Side[] = ["david", "emalie"];
export type Snapshot = Record<Side, Member[]>;
export type Journal = {
  desired: Member[];
  expected: Snapshot;
  inflight?: { side: Side; after: Member[] };
  startedAt: string;
};
export type State = {
  baseline?: Member[];
  pending?: Journal;
  verifiedAt?: string;
};
export const equal = (a: Member[], b: Member[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export function desired(b: Member[], d: Member[], e: Member[]): Member[] {
  const removed = new Set(b.filter((k) => !d.includes(k) || !e.includes(k)));
  return [...new Set([...d, ...e])].filter((k) => !removed.has(k)).sort();
}
export interface IO {
  read(): Promise<Snapshot>;
  save(s: State): Promise<void>;
  mutate(side: Side, action: "add" | "remove", items: Member[]): Promise<void>;
}
export async function synchronize(state: State, io: IO, dry = false) {
  let current = await io.read();
  if (state.baseline === undefined)
    throw Error("Baseline must be initialized explicitly");
  if (dry)
    return {
      desired:
        state.pending?.desired ??
        desired(state.baseline, current.david, current.emalie),
      current,
      pending: !!state.pending,
    };
  if (state.pending) {
    const p = state.pending;
    for (const side of sides) {
      const possible = p.inflight?.side === side ? p.inflight.after : undefined;
      const changed = possible
        ? new Set(
            [...p.expected[side], ...possible].filter(
              (k) => p.expected[side].includes(k) !== possible.includes(k),
            ),
          )
        : new Set<Member>();
      const compatible =
        possible &&
        equal(
          current[side].filter((k) => !changed.has(k)),
          p.expected[side].filter((k) => !changed.has(k)),
        );
      if (!equal(current[side], p.expected[side]) && !compatible)
        throw Error(
          "Concurrent change conflicts with pending sync; manual reconciliation required",
        );
    }
    p.expected = structuredClone(current);
    delete p.inflight;
    await io.save(state);
  } else {
    state.pending = {
      desired: desired(state.baseline, current.david, current.emalie),
      expected: structuredClone(current),
      startedAt: new Date().toISOString(),
    };
    await io.save(state);
  }
  const p = state.pending;
  for (const side of sides)
    for (const action of ["remove", "add"] as const) {
      const items =
        action === "remove"
          ? current[side].filter((k) => !p.desired.includes(k))
          : p.desired.filter((k) => !current[side].includes(k));
      for (let i = 0; i < items.length; i += 50) {
        const batch = items.slice(i, i + 50);
        current = await io.read();
        for (const s of sides)
          if (!equal(current[s], p.expected[s]))
            throw Error("List changed during sync; pending journal retained");
        const after =
          action === "remove"
            ? current[side].filter((k) => !batch.includes(k))
            : [...current[side], ...batch];
        p.inflight = { side, after };
        await io.save(state);
        await io.mutate(side, action, batch);
        current = await io.read();
        for (const s of sides)
          if (!equal(current[s], s === side ? after : p.expected[s]))
            throw Error("Mutation verification failed; journal retained");
        p.expected = structuredClone(current);
        delete p.inflight;
        await io.save(state);
      }
    }
  current = await io.read();
  if (!equal(current.david, p.desired) || !equal(current.emalie, p.desired))
    throw Error("Final verification failed");
  state.baseline = p.desired;
  delete state.pending;
  state.verifiedAt = new Date().toISOString();
  await io.save(state);
  return { count: state.baseline.length, verifiedAt: state.verifiedAt };
}
