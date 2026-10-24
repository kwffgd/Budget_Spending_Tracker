import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const CFG = "config";
const DEFAULT_TAGS = [
  ["Groceries", "#22c55e"], ["Fuel", "#f97316"], ["Eating Out", "#ef4444"],
  ["Snacks/Drinks", "#eab308"], ["Household", "#3b82f6"], ["Kids", "#a855f7"],
  ["Personal", "#ec4899"], ["Misc", "#64748b"],
];

class HttpErr extends Error { constructor(s, m) { super(m); this.status = s; } }
const store = () => getStore({ name: "budget", consistency: "strong" });
const json = (d, status = 200) => new Response(JSON.stringify(d), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const rid = (n = 12) => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "").slice(0, n);
const initCfg = () => ({
  users: [], accounts: [], picks: [],
  tags: DEFAULT_TAGS.map(([name, color]) => ({ id: rid(8), name, color, owner: null })),
});

// Read-modify-write with optimistic concurrency (retries if someone else saved first)
async function mutate(key, init, fn) {
  const s = store();
  for (let i = 0; i < 6; i++) {
    const r = await s.getWithMetadata(key, { type: "json" });
    const data = r ? r.data : init();
    const out = await fn(data);
    const res = await s.setJSON(key, data, r ? { onlyIfMatch: r.etag } : { onlyIfNew: true });
    if (!res || res.modified !== false) return out;
  }
  throw new HttpErr(409, "Save conflict, try again");
}

async function loadCfg() {
  let cfg = await store().get(CFG, { type: "json" });
  if (!cfg) { await mutate(CFG, initCfg, () => {}); cfg = await store().get(CFG, { type: "json" }); }
  return cfg;
}

async function auth(req) {
  const t = req.headers.get("x-token") || "";
  if (!t) throw new HttpErr(401, "No access link");
  const cfg = await loadCfg();
  if (process.env.ADMIN_TOKEN && t === process.env.ADMIN_TOKEN)
    return { cfg, me: { id: "admin", name: process.env.ADMIN_NAME || "Admin", role: "admin" } };
  const u = cfg.users.find((u) => u.token === t && !u.revoked);
  if (!u) throw new HttpErr(401, "Invalid or revoked link");
  return { cfg, me: { id: u.id, name: u.name, role: "member" } };
}

const isAdmin = (me) => me.role === "admin";
const visibleAccounts = (cfg, me) =>
  cfg.accounts.filter((a) => !a.archived && (isAdmin(me) || (a.members || []).includes(me.id)));
const monthsBetween = (from, to) => {
  const out = []; let [y, m] = from.split("-").map(Number); const [ty, tm] = to.split("-").map(Number);
  while ((y < ty || (y === ty && m <= tm)) && out.length < 60) {
    out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; }
  }
  return out;
};
const num = (v) => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) ? n : NaN; };
const clean = (s, n = 60) => String(s || "").trim().slice(0, n);

function accountFields(b) {
  const weekly = num(b.weekly);
  if (!clean(b.name) || !(weekly >= 0)) throw new HttpErr(400, "Name and weekly amount required");
  return {
    name: clean(b.name), weekly,
    resetDay: Math.min(6, Math.max(0, parseInt(b.resetDay ?? 0, 10) || 0)),
    members: Array.isArray(b.members) ? b.members.map(String) : [],
  };
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const [res, id, sub] = url.pathname.replace(/^\/api\/?/, "").split("/");
    const method = req.method;
    const body = ["POST", "PUT"].includes(method) ? await req.json().catch(() => ({})) : {};
    const { cfg, me } = await auth(req);
    const admin = isAdmin(me);
    const needAdmin = () => { if (!admin) throw new HttpErr(403, "Admin only"); };

    // ---- state ----
    if (res === "state" && method === "GET") {
      const people = { admin: process.env.ADMIN_NAME || "Admin" };
      cfg.users.forEach((u) => (people[u.id] = u.name));
      return json({
        me, people,
        accounts: visibleAccounts(cfg, me),
        tags: cfg.tags,
        picks: cfg.picks.filter((p) => p.owner === me.id),
        users: admin ? cfg.users : undefined,
      });
    }

    // ---- entries ----
    if (res === "entries") {
      const vis = new Set(visibleAccounts(cfg, me).map((a) => a.id));
      if (method === "GET") {
        const from = url.searchParams.get("from"), to = url.searchParams.get("to") || from;
        if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) throw new HttpErr(400, "Bad range");
        const months = monthsBetween(from, to);
        const lists = await Promise.all(months.map((m) => store().get(`entries/${m}`, { type: "json" })));
        const out = {};
        months.forEach((m, i) => (out[m] = (lists[i] || []).filter((e) => vis.has(e.accountId))));
        return json(out);
      }
      if (method === "POST") {
        const amount = num(body.amount), exact = num(body.exact ?? body.amount);
        if (!vis.has(body.accountId)) throw new HttpErr(403, "No access to account");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || "")) throw new HttpErr(400, "Bad date");
        if (!(amount > 0) || amount > 100000) throw new HttpErr(400, "Bad amount");
        // optional split across tags: [{tagId, amount}]
        let splits = null;
        if (Array.isArray(body.splits) && body.splits.length > 1) {
          splits = body.splits.slice(0, 10).map((s) => ({ tagId: String(s.tagId || ""), amount: num(s.amount) }));
          if (splits.some((s) => !s.tagId || !(s.amount >= 0))) throw new HttpErr(400, "Bad split");
          if (Math.abs(splits.reduce((t, s) => t + s.amount, 0) - amount) > 0.011) throw new HttpErr(400, "Splits must add up to the total");
        }
        const e = {
          id: rid(), accountId: body.accountId, userId: me.id, amount, exact,
          date: body.date, tagId: splits ? splits[0].tagId : body.tagId || null, splits,
          note: clean(body.note, 120), comment: clean(body.comment, 500),
          pickId: body.pickId || null, ts: Date.now(),
        };
        await mutate(`entries/${e.date.slice(0, 7)}`, () => [], (arr) => { arr.push(e); });
        return json(e);
      }
      if (method === "DELETE") {
        if (!/^\d{4}-\d{2}$/.test(id || "")) throw new HttpErr(400, "Bad month");
        await mutate(`entries/${id}`, () => [], (arr) => {
          const i = arr.findIndex((e) => e.id === sub);
          if (i < 0) return;
          if (!admin && arr[i].userId !== me.id) throw new HttpErr(403, "Not your entry");
          arr.splice(i, 1);
        });
        return json({ ok: true });
      }
    }

    // ---- tags ----
    if (res === "tags") {
      if (method === "POST") {
        if (!clean(body.name, 30)) throw new HttpErr(400, "Name required");
        const t = { id: rid(8), name: clean(body.name, 30), color: /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : "#64748b", owner: admin ? null : me.id };
        await mutate(CFG, initCfg, (c) => { c.tags.push(t); });
        return json(t);
      }
      if (method === "DELETE") {
        await mutate(CFG, initCfg, (c) => {
          const t = c.tags.find((t) => t.id === id);
          if (!t) return;
          if (!admin && t.owner !== me.id) throw new HttpErr(403, "Not your tag");
          t.archived = true; // keep for history
        });
        return json({ ok: true });
      }
    }

    // ---- quick picks ----
    if (res === "picks") {
      if (method === "POST") {
        const amount = num(body.amount) > 0 ? num(body.amount) : null; // amount optional
        if (!clean(body.name, 40)) throw new HttpErr(400, "Name required");
        const p = { id: rid(8), owner: me.id, name: clean(body.name, 40), amount, exact: amount ? num(body.exact ?? amount) : null, tagId: body.tagId || null, accountId: body.accountId || null };
        await mutate(CFG, initCfg, (c) => { c.picks.push(p); });
        return json(p);
      }
      if (method === "DELETE") {
        await mutate(CFG, initCfg, (c) => {
          const i = c.picks.findIndex((p) => p.id === id);
          if (i >= 0 && (admin || c.picks[i].owner === me.id)) c.picks.splice(i, 1);
        });
        return json({ ok: true });
      }
    }

    // ---- admin: people ----
    if (res === "users") {
      needAdmin();
      if (method === "POST" && !id) {
        if (!clean(body.name, 30)) throw new HttpErr(400, "Name required");
        const u = { id: rid(8), name: clean(body.name, 30), token: rid(32), created: Date.now() };
        await mutate(CFG, initCfg, (c) => { c.users.push(u); });
        return json(u);
      }
      if (method === "POST" && sub === "rotate") {
        let u; await mutate(CFG, initCfg, (c) => { u = c.users.find((x) => x.id === id); if (u) { u.token = rid(32); u.revoked = false; } });
        return json(u || {});
      }
      if (method === "DELETE") {
        await mutate(CFG, initCfg, (c) => { const u = c.users.find((x) => x.id === id); if (u) u.revoked = true; });
        return json({ ok: true });
      }
    }

    // ---- admin: accounts ----
    if (res === "accounts") {
      needAdmin();
      if (method === "POST") {
        const a = { id: rid(8), ...accountFields(body) };
        await mutate(CFG, initCfg, (c) => { c.accounts.push(a); });
        return json(a);
      }
      if (method === "PUT") {
        const f = accountFields(body);
        await mutate(CFG, initCfg, (c) => { const a = c.accounts.find((x) => x.id === id); if (a) Object.assign(a, f); });
        return json({ ok: true });
      }
      if (method === "DELETE") {
        await mutate(CFG, initCfg, (c) => { const a = c.accounts.find((x) => x.id === id); if (a) a.archived = true; });
        return json({ ok: true });
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: e.message || "Server error" }, e.status || 500);
  }
};
