import { timingSafeEqual } from "node:crypto";
import { DurableObject } from "cloudflare:workers";
import {
  synchronize,
  equal,
  type Member,
  type Side,
  type Snapshot,
  type State,
  sides,
} from "./sync.ts";
const accounts = {
  david: "jarvis-16819012",
  emalie: "emalie-parkhurst-9c0e52",
};
type Token = {
  access_token: string;
  refresh_token: string;
  created_at: number;
  expires_in: number;
};
type List = {
  name: string;
  privacy: string;
  item_count: number;
  updated_at: string;
  ids: { trakt: number; slug: string };
};
const normalize = (s: string) => s.replaceAll("_", "-");
const encode = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export class DavEmalieSync extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  private async key() {
    return crypto.subtle.importKey(
      "raw",
      decode(this.env.ENCRYPTION_KEY),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  }
  private async seal(value: unknown) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return {
      iv: encode(iv),
      data: encode(
        new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            await this.key(),
            new TextEncoder().encode(JSON.stringify(value)),
          ),
        ),
      ),
    };
  }
  private async unseal<T>(value: { iv: string; data: string }): Promise<T> {
    return JSON.parse(
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: decode(value.iv) },
          await this.key(),
          decode(value.data),
        ),
      ),
    );
  }
  private async token(side: Side): Promise<Token> {
    const encrypted = await this.ctx.storage.get<{ iv: string; data: string }>(
      "token:" + side,
    );
    if (!encrypted) throw Error("Authorization missing: " + side);
    let t = await this.unseal<Token>(encrypted);
    if (Date.now() / 1000 > t.created_at + t.expires_in - 86400) {
      if (await this.ctx.storage.get("refreshing:" + side))
        throw Error("Token refresh interrupted; reconnect " + side);
      await this.ctx.storage.put("refreshing:" + side, true);
      t = (await this.oauth("/oauth/token", {
        refresh_token: t.refresh_token,
        grant_type: "refresh_token",
        redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
      })) as Token;
      this.validateToken(t);
      await this.ctx.storage.put("token:" + side, await this.seal(t));
      await this.ctx.storage.delete("refreshing:" + side);
    }
    return t;
  }
  private validateToken(t: Token) {
    if (
      !t.access_token ||
      !t.refresh_token ||
      !Number.isFinite(t.created_at) ||
      !Number.isFinite(t.expires_in)
    )
      throw Error("Invalid authorization response");
  }
  private async oauth(path: string, data: object): Promise<unknown> {
    const r = await fetch("https://auth.trakt.tv" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "DavEmalie-Sync/1.0",
      },
      body: JSON.stringify({
        ...data,
        client_id: this.env.TRAKT_CLIENT_ID,
        client_secret: this.env.TRAKT_CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw Error("Trakt authorization HTTP " + r.status);
    return r.json();
  }
  private async api(side: Side, path: string, data?: object, override?: Token) {
    const t = override ?? (await this.token(side));
    const r = await fetch("https://api.trakt.tv" + path, {
      method: data ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + t.access_token,
        "trakt-api-key": this.env.TRAKT_CLIENT_ID,
        "trakt-api-version": "2",
        "Content-Type": "application/json",
        "User-Agent": "DavEmalie-Sync/1.0",
      },
      body: data ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw Error("Trakt HTTP " + r.status + " for " + side);
    return r;
  }
  private async identity(side: Side, t?: Token) {
    const user = (await (
      await this.api(side, "/users/settings", undefined, t)
    ).json()) as { user: { username: string; ids: { slug: string } } };
    if (
      normalize(user.user.ids.slug) !== accounts[side] ||
      normalize(user.user.username) !== accounts[side]
    )
      throw Error("Account identity mismatch: " + side);
  }
  private base(side: Side) {
    return "/users/" + accounts[side] + "/lists/davemalie";
  }
  private async readOne(side: Side): Promise<Member[]> {
    await this.identity(side);
    const meta = (await (await this.api(side, this.base(side))).json()) as List;
    if (
      meta.name !== "DavEmalie" ||
      meta.privacy !== "private" ||
      meta.ids.slug !== "davemalie" ||
      !Number.isInteger(meta.item_count) ||
      meta.item_count < 0
    )
      throw Error("List identity/privacy/count mismatch: " + side);
    const pinned = await this.ctx.storage.get<number>("list:" + side);
    if (pinned !== undefined && pinned !== meta.ids.trakt)
      throw Error("List was replaced: " + side);
    const members: Member[] = [];
    let pages = 1;
    let count: number | undefined;
    for (let page = 1; page <= pages; page++) {
      if (page > 100) throw Error("List pagination limit exceeded");
      const r = await this.api(
        side,
        this.base(side) + "/items?page=" + page + "&limit=100",
      );
      const pc = r.headers.get("x-pagination-page-count"),
        ic = r.headers.get("x-pagination-item-count");
      if (!pc || !ic) throw Error("Missing complete-list pagination metadata");
      const total = Number(ic),
        pageCount = Math.max(1, Number(pc));
      if (
        total < 0 ||
        pageCount > 100 ||
        !Number.isInteger(total) ||
        !Number.isInteger(pageCount) ||
        (count !== undefined && (total !== count || pageCount !== pages))
      )
        throw Error("List changed during pagination");
      count = total;
      pages = pageCount;
      const rows = (await r.json()) as Array<{
        type: string;
        [key: string]: unknown;
      }>;
      if (!Array.isArray(rows)) throw Error("Invalid list response");
      for (const row of rows) {
        if (!["movie", "show", "season", "episode"].includes(row.type))
          throw Error("Unsupported list item type; manual review required");
        const id = (row[row.type] as { ids: { trakt: number } })?.ids?.trakt;
        if (!Number.isInteger(id) || id <= 0)
          throw Error("Invalid media identity");
        members.push(`${row.type}:${id}` as Member);
      }
    }
    const after = (await (
      await this.api(side, this.base(side))
    ).json()) as List;
    if (
      members.length !== count ||
      members.length !== meta.item_count ||
      new Set(members).size !== members.length ||
      after.updated_at !== meta.updated_at ||
      after.item_count !== meta.item_count ||
      after.ids.trakt !== meta.ids.trakt ||
      after.privacy !== "private"
    )
      throw Error("Incomplete or changing list: " + side);
    if (pinned === undefined)
      await this.ctx.storage.put("list:" + side, meta.ids.trakt);
    return members.sort();
  }
  private async read(): Promise<Snapshot> {
    return {
      david: await this.readOne("david"),
      emalie: await this.readOne("emalie"),
    };
  }
  private async runInner(dry = false) {
    const state = (await this.ctx.storage.get<State>("state")) ?? {};
    return synchronize(
      state,
      {
        read: () => this.read(),
        save: (s) => this.ctx.storage.put("state", s),
        mutate: async (side, action, items) => {
          await this.identity(side);
          const payload: Record<string, Array<{ ids: { trakt: number } }>> = {};
          for (const k of items) {
            const [type, id] = k.split(":");
            (payload[type + "s"] ??= []).push({ ids: { trakt: Number(id) } });
          }
          const r = await this.api(
            side,
            this.base(side) + "/items" + (action === "remove" ? "/remove" : ""),
            payload,
          );
          const body = (await r.json()) as {
            not_found?: Record<string, unknown[]>;
          };
          if (Object.values(body.not_found ?? {}).some((x) => x.length))
            throw Error("Media not found during list mutation");
        },
      },
      dry,
    );
  }
  private async notify(error: string, test = false) {
    const previous = await this.ctx.storage.get<{ error: string; at: number }>(
      "lastAlert",
    );
    if (
      !test &&
      previous?.error === error &&
      Date.now() - previous.at < 86400000
    )
      return;
    const result = await this.env.EMAIL.send({
      from: this.env.ALERT_FROM,
      to: this.env.ALERT_TO,
      subject: test
        ? "Trakt list sync: notification test"
        : "Trakt list sync needs attention",
      text: test
        ? "This verifies the Cloudflare notification path for DavEmalie list sync."
        : "The hourly DavEmalie sync could not finish. Its baseline and any pending operations have been retained.\n\n" +
          error,
    });
    if (!test)
      await this.ctx.storage.put("lastAlert", { error, at: Date.now() });
    return result;
  }
  async run() {
    return this.serialized(async () => {
      if (!(await this.ctx.storage.get<boolean>("enabled")))
        return { status: "disabled" };
      try {
        const result = await this.runInner();
        await this.ctx.storage.put("lastRun", {
          at: new Date().toISOString(),
          status: "success",
          result,
        });
        await this.ctx.storage.delete("lastAlert");
        return result;
      } catch (e) {
        const error = e instanceof Error ? e.message : "Sync failed";
        await this.ctx.storage.put("lastRun", {
          at: new Date().toISOString(),
          status: "failed",
          error,
        });
        console.error(
          JSON.stringify({ event: "davemalie_sync_failed", error }),
        );
        try {
          await this.notify(error);
        } catch {
          console.error(JSON.stringify({ event: "davemalie_alert_failed" }));
        }
        throw Error(error);
      }
    });
  }
  async admin(path: string, body: Record<string, unknown>) {
    return this.serialized(async () => {
      const side = body.side as Side;
      if (path.startsWith("/auth/")) {
        if (!sides.includes(side)) throw Error("Invalid account");
        if (path === "/auth/start") {
          const device = (await this.oauth("/oauth/device/code", {})) as {
            device_code: string;
            user_code: string;
            verification_url: string;
            expires_in: number;
            interval: number;
          };
          await this.ctx.storage.put(
            "device:" + side,
            await this.seal({
              ...device,
              expiresAt: Date.now() + device.expires_in * 1000,
            }),
          );
          return {
            user_code: device.user_code,
            verification_url: device.verification_url,
            expires_in: device.expires_in,
            interval: device.interval,
          };
        }
        if (path === "/auth/poll") {
          const sealed = await this.ctx.storage.get<{
            iv: string;
            data: string;
          }>("device:" + side);
          if (!sealed) throw Error("Start authorization first");
          const d = await this.unseal<{
            device_code: string;
            expiresAt: number;
          }>(sealed);
          if (d.expiresAt < Date.now()) throw Error("Device code expired");
          const t = (await this.oauth("/oauth/device/token", {
            code: d.device_code,
          })) as Token;
          this.validateToken(t);
          await this.identity(side, t);
          await this.ctx.storage.put("token:" + side, await this.seal(t));
          await this.ctx.storage.delete([
            "device:" + side,
            "refreshing:" + side,
          ]);
          return { authorized: side };
        }
      }
      if (path === "/initialize") {
        if (await this.ctx.storage.get("state"))
          throw Error("Baseline already initialized");
        const baseline = body.baseline;
        if (
          !Array.isArray(baseline) ||
          !baseline.every(
            (x) =>
              typeof x === "string" &&
              /^(movie|show|season|episode):[1-9]\d*$/.test(x),
          )
        )
          throw Error("Invalid baseline");
        const c = await this.read();
        if (
          !equal(c.david, baseline as Member[]) ||
          !equal(c.emalie, baseline as Member[])
        )
          throw Error("Migration baseline differs from live lists");
        await this.ctx.storage.put("state", {
          baseline,
          verifiedAt: new Date().toISOString(),
        });
        return { initialized: true };
      }
      if (path === "/notifications/test") {
        const result = await this.notify("", true);
        await this.ctx.storage.put(
          "notificationsVerifiedAt",
          new Date().toISOString(),
        );
        return { sent: true, result };
      }
      if (path === "/snapshot") return this.read();
      if (path === "/dry-run") return this.runInner(true);
      if (path === "/enable") {
        if (!(await this.ctx.storage.get("notificationsVerifiedAt")))
          throw Error("Test failure notifications before enabling");
        if ((await this.ctx.storage.get<State>("state"))?.pending)
          throw Error("Pending sync requires review before enabling");
        await this.runInner(true);
        await this.ctx.storage.put("enabled", true);
        return { enabled: true };
      }
      if (path === "/disable") {
        await this.ctx.storage.put("enabled", false);
        return { enabled: false };
      }
      if (path === "/status")
        return {
          enabled: (await this.ctx.storage.get("enabled")) ?? false,
          lastRun: await this.ctx.storage.get("lastRun"),
          state: await this.ctx.storage.get("state"),
          authorized: {
            david: !!(await this.ctx.storage.get("token:david")),
            emalie: !!(await this.ctx.storage.get("token:emalie")),
          },
        };
      throw Error("Unknown operation");
    });
  }
}
export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(env.SYNC.getByName("davemalie").run());
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 });
    const provided = request.headers.get("Authorization") ?? "";
    const digest = async (s: string) =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    if (
      !env.ADMIN_KEY ||
      !timingSafeEqual(
        new Uint8Array(await digest(provided)),
        new Uint8Array(await digest("Bearer " + env.ADMIN_KEY)),
      )
    )
      return new Response("Unauthorized", { status: 401 });
    if (Number(request.headers.get("content-length") ?? 0) > 16384)
      return new Response("Too large", { status: 413 });
    try {
      const reader = request.body?.getReader();
      let text = "";
      let length = 0;
      const decoder = new TextDecoder();
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 16384) {
            await reader.cancel();
            return new Response("Too large", { status: 413 });
          }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      }
      const body = text ? JSON.parse(text) : {};
      if (!body || typeof body !== "object" || Array.isArray(body))
        return new Response("Invalid body", { status: 400 });
      const path = new URL(request.url).pathname;
      const object = env.SYNC.getByName("davemalie");
      return Response.json(
        path === "/run" ? await object.run() : await object.admin(path, body),
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "Operation failed" },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
  },
} satisfies ExportedHandler<Env>;
