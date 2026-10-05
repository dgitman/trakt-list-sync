import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return { url: "stub:workers", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "stub:workers")
      return {
        format: "module",
        source:
          "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}",
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const { DavEmalieSync, default: worker } = await import("../src/index.ts");
function fixture() {
  const data = new Map();
  const storage = {
    get: async (k) => structuredClone(data.get(k)),
    put: async (k, v) => data.set(k, structuredClone(v)),
    delete: async (k) =>
      Array.isArray(k) ? k.map((x) => data.delete(x)) : data.delete(k),
  };
  let emails = 0;
  const env = {
    ADMIN_KEY: "test-only",
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    ALERT_TO: "test@example.com",
    ALERT_FROM: "test@example.com",
    EMAIL: {
      send: async () => {
        emails++;
        return { messageId: "test" };
      },
    },
  };
  const obj = new DavEmalieSync({ storage }, env);
  return {
    obj,
    data,
    env,
    get emails() {
      return emails;
    },
  };
}
test("Worker rejects unauthorized and malformed requests", async () => {
  const f = fixture();
  assert.equal(
    (
      await worker.fetch(
        new Request("https://example.com/status", { method: "POST" }),
        f.env,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request("https://example.com/status", {
          method: "POST",
          headers: { Authorization: "Bearer test-only" },
          body: "null",
        }),
        f.env,
      )
    ).status,
    400,
  );
});
test("disabled scheduler does not read Trakt or send email", async () => {
  const f = fixture();
  f.obj.runInner = async () => {
    throw Error("must not run");
  };
  assert.deepEqual(await f.obj.run(), { status: "disabled" });
  assert.equal(f.emails, 0);
});
test("failed scheduled runs record state and deduplicate notifications", async () => {
  const f = fixture();
  f.data.set("enabled", true);
  f.obj.runInner = async () => {
    throw Error("Trakt unavailable");
  };
  await assert.rejects(f.obj.run());
  await assert.rejects(f.obj.run());
  assert.equal(f.emails, 1);
  assert.equal(f.data.get("lastRun").status, "failed");
});
test("failed email delivery retries next run", async () => {
  const f = fixture();
  f.data.set("enabled", true);
  f.obj.runInner = async () => {
    throw Error("failure");
  };
  f.env.EMAIL.send = async () => {
    throw Error("mail down");
  };
  await assert.rejects(f.obj.run());
  assert.equal(f.data.has("lastAlert"), false);
  f.env.EMAIL.send = async () => ({ messageId: "sent" });
  await assert.rejects(f.obj.run());
  assert.equal(f.data.has("lastAlert"), true);
});
test("operations are serialized across awaits", async () => {
  const f = fixture();
  f.data.set("enabled", true);
  let active = 0,
    max = 0;
  f.obj.runInner = async () => {
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return {};
  };
  await Promise.all([f.obj.run(), f.obj.run(), f.obj.run()]);
  assert.equal(max, 1);
});
test("OAuth tokens are encrypted and decrypt correctly", async () => {
  const f = fixture();
  const token = { access_token: "test-only-token" };
  const sealed = await f.obj.seal(token);
  assert.ok(!JSON.stringify(sealed).includes(token.access_token));
  assert.deepEqual(await f.obj.unseal(sealed), token);
});
test("wrong account identity prevents reads", async () => {
  const f = fixture();
  f.obj.api = async () =>
    Response.json({
      user: { username: "someone_else", ids: { slug: "someone-else" } },
    });
  await assert.rejects(f.obj.readOne("david"), /identity mismatch/);
});
function listAPI(f, { pageHeaders = true, replaced = false } = {}) {
  f.obj.identity = async () => {};
  f.data.set("list:david", 99);
  f.obj.api = async (_side, path) =>
    path.includes("/items")
      ? Response.json([{ type: "movie", movie: { ids: { trakt: 1 } } }], {
          headers: pageHeaders
            ? { "x-pagination-page-count": "1", "x-pagination-item-count": "1" }
            : {},
        })
      : Response.json({
          name: "DavEmalie",
          privacy: "private",
          item_count: 1,
          updated_at: "2026-09-20",
          ids: { trakt: replaced ? 100 : 99, slug: "davemalie" },
        });
}
test("complete list read verifies pagination and pinned identity", async () => {
  const f = fixture();
  listAPI(f);
  assert.deepEqual(await f.obj.readOne("david"), ["movie:1"]);
  listAPI(f, { pageHeaders: false });
  await assert.rejects(f.obj.readOne("david"), /pagination metadata/);
  listAPI(f, { replaced: true });
  await assert.rejects(f.obj.readOne("david"), /replaced/);
});
test("enable requires a tested notification path", async () => {
  const f = fixture();
  await assert.rejects(f.obj.admin("/enable", {}), /notifications/);
  assert.equal(f.data.get("enabled"), undefined);
});
test('daily cron routes to history checking and repair',async()=>{
 let checks=0,runs=0;const pending=[];
 const env={SYNC:{getByName:()=>({historyCheck:async()=>{checks++},run:async()=>{runs++}})}};
 await worker.scheduled({cron:'35 12 * * *'},env,{waitUntil:p=>pending.push(p)});
 await worker.scheduled({cron:'17 * * * *'},env,{waitUntil:p=>pending.push(p)});
 await Promise.all(pending);assert.equal(checks,1);assert.equal(runs,1);
});
test('history scan checks identities, reports issues, and deduplicates alerts',async()=>{
 const f=fixture();let identities=0,calls=0;
 f.obj.identity=async()=>{identities++};
 f.obj.api=async(side,path,data)=>{assert.equal(data,undefined);calls++;return Response.json([{id:side==='david'?1:2,type:'movie',watched_at:'1970-01-01T00:00:00Z',movie:{title:'Example',released:'2020-01-01'}}],{headers:{'x-pagination-page-count':'1','x-pagination-item-count':'1'}})};
 await f.obj.historyCheck();await f.obj.historyCheck();
 assert.equal(identities,4);assert.equal(calls,4);assert.equal(f.emails,1);
 assert.equal(f.data.get('history:lastRun').counts.david.issues,1);
 assert.equal(f.data.has('state'),false);
});
test('failed history scan retains prior complete report',async()=>{
 const f=fixture();f.data.set('history:summary:david',{scanned:99});
 f.obj.identity=async()=>{};f.obj.api=async()=>{throw Error('Trakt unavailable')};
 await assert.rejects(f.obj.historyCheck(),/Trakt unavailable/);
 assert.deepEqual(f.data.get('history:summary:david'),{scanned:99});assert.equal(f.emails,1);
});
test('explicit rate-limit rejection retries without repeating an accepted write',async()=>{
 const f=fixture(),original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>++calls===1?new Response('',{status:429,headers:{'Retry-After':'0'}}):Response.json({added:{movies:1}});
 try {
  const r=await f.obj.api('david','/sync/history',{movies:[]},{access_token:'test'});
  assert.equal(r.status,200);assert.equal(calls,2);
 } finally {globalThis.fetch=original;}
});
