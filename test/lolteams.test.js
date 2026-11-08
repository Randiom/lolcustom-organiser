'use strict';
// Tests with a stubbed Riot API and fake Discord interactions. Every payload the bot sends is run through
// discord.js builder validation (toJSON), so invalid embeds, menus or modals fail here instead of in Discord.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lol-')), 'data.json');
process.env.RIOT_KEY = 'test';
const m = require('../lolteams.js');
const { db } = m;

// ── fake Riot ────────────────────────────────────────────────────────────
const riotCalls = [];
let riotMode = 'ok'; // ok | 403 | 429once
const ACCOUNTS = {
  'skapligt snabb#SPEED': { puuid: 'P1', gameName: 'skapligt snabb', tagLine: 'SPEED' },
  'Foo#NA1': { puuid: 'P2', gameName: 'Foo', tagLine: 'NA1' },
  'Flexer#EUW': { puuid: 'P3', gameName: 'Flexer', tagLine: 'EUW' },
  'Bar#NA1': { puuid: 'P4', gameName: 'Bar', tagLine: 'NA1' },
};
const ENTRIES = {
  P1: [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 61 }],
  P2: [],
  P3: [{ queueType: 'RANKED_FLEX_SR', tier: 'SILVER', rank: 'I', leaguePoints: 10 }],
};
const PLATFORM = { P1: 'euw1', P2: 'na1', P3: 'euw1', P4: 'na1' };
let sent429 = false;
const json = (x, status = 200, headers = {}) => new Response(JSON.stringify(x), { status, headers });
global.fetch = async (url) => {
  riotCalls.push(String(url));
  if (riotMode === '403') return json({}, 403);
  if (riotMode === '429once' && !sent429) { sent429 = true; return json({}, 429, { 'retry-after': '0' }); }
  const u = new URL(url);
  let mm = u.pathname.match(/by-riot-id\/([^/]+)\/([^/]+)$/);
  if (mm) { const a = ACCOUNTS[`${decodeURIComponent(mm[1])}#${decodeURIComponent(mm[2])}`]; return a ? json(a) : json({}, 404); }
  mm = u.pathname.match(/entries\/by-puuid\/(.+)$/);
  if (mm) return json(ENTRIES[mm[1]] ?? []);
  mm = u.pathname.match(/summoners\/by-puuid\/(.+)$/); // only exists on the player's own platform
  if (mm) return u.hostname.startsWith(PLATFORM[mm[1]] + '.') ? json({ puuid: mm[1] }) : json({}, 404);
  return json({}, 404);
};

// ── fake Discord ─────────────────────────────────────────────────────────
const U = (n) => String(1000 + n); // user ids
const valid = (p) => { p.embeds?.forEach((e) => e.toJSON()); p.components?.forEach((r) => r.toJSON()); return p; };
const body = (p) => JSON.stringify([p.content, ...(p.embeds || []).map((e) => e.toJSON())]);
const last = (i, name) => [...i.calls].reverse().find((c) => c[0] === name)?.[1];

function mk(kind, o = {}) {
  const calls = [];
  const rec = (name) => async (arg) => {
    if (name === 'showModal') arg.toJSON(); else if (arg && typeof arg === 'object') valid(arg);
    calls.push([name, arg]);
    return { id: 'x', url: 'https://discord.test/x' };
  };
  const i = {
    user: { id: o.user }, memberPermissions: { has: () => !!o.admin }, member: o.member, guild: o.guild, channel: o.channel,
    channelId: 'c1', createdTimestamp: o.createdTimestamp ?? Date.now(), customId: o.customId, values: o.values,
    users: o.users, message: o.message, client: { ws: { ping: 7 } }, deferred: false, replied: false, calls,
    options: { getUser: () => o.target ?? null, getInteger: () => o.test ?? null },
    fields: { getTextInputValue: (k) => o.fields[k] },
    isChatInputCommand: () => kind === 'cmd', isModalSubmit: () => kind === 'modal', isMessageComponent: () => kind === 'comp',
    reply: rec('reply'), editReply: rec('editReply'), update: rec('update'), deferUpdate: rec('deferUpdate'),
    deferReply: rec('deferReply'), followUp: rec('followUp'), showModal: rec('showModal'),
    ...o.over,
  };
  return i;
}

// a guild with a lobby voice channel (vc1), optional Blue/Red team channels, and the given players inside
function world(players, { teamChannels = true } = {}) {
  const members = new Map(players.map((id) => [id, {
    id, user: { bot: false }, displayName: `Name${id}`,
    voice: { channelId: 'vc1', async setChannel(c) { this.channelId = c; } },
  }]));
  const vc = { id: 'vc1', name: 'Lobby', isVoiceBased: () => true, members };
  members.forEach((mem) => { mem.voice.channel = vc; });
  const chans = new Map([['vc1', vc]]);
  if (teamChannels) {
    chans.set('vb', { id: 'vb', name: 'Team Blue', isVoiceBased: () => true });
    chans.set('vr', { id: 'vr', name: 'Team Red', isVoiceBased: () => true });
  }
  const guild = {
    channels: { cache: { get: (id) => chans.get(id), find: (f) => [...chans.values()].find(f) } },
    members: { fetch: async (id) => members.get(id) ?? null },
  };
  const posted = [], edits = [];
  const channel = { id: 'c1', send: async (p) => { valid(p); posted.push(p); return { id: `msg${posted.length}`, url: `https://discord.test/${posted.length}` }; } };
  const message = (id = 'msg1') => ({ id, edit: async (p) => { valid(p); edits.push(p); } });
  return { members, vc, guild, channel, posted, edits, message };
}

const reset = () => {
  db.users = {}; db.ranks = {}; m.sessions.clear(); m.testLobbies.clear(); m.queues.clear(); riotCalls.length = 0; riotMode = 'ok'; sent429 = false;
};
const seed = (list, f = (i) => 800 + i * 150) => list.forEach((id, i) => { db.users[id] = { override: f(i) }; });
const ids = (n) => Array.from({ length: n }, (_, i) => U(i + 1));
const panelPress = (w, customId, user, extra = {}) =>
  mk('comp', { customId, user, guild: w.guild, channel: w.channel, member: w.members.get(user), ...extra });
const press = (w, customId, user, extra = {}) =>
  mk('comp', { customId, user, guild: w.guild, member: w.members.get(user) ?? { voice: { channelId: null } }, message: w.message(), ...extra });

async function startTeams(n, opts) {
  reset();
  const list = ids(n);
  seed(list);
  const w = world(list, opts);
  await m.handle(panelPress(w, `lol:teams:${U(1)}`, U(1)));
  return { w, list, s: m.sessions.get('msg1') };
}

// ── parsing + rating labels ──────────────────────────────────────────────
test('parseRiotId: Name#TAG and op.gg links', () => {
  assert.deepEqual(m.parseRiotId('skapligt snabb#SPEED'), { name: 'skapligt snabb', tag: 'SPEED' });
  assert.deepEqual(m.parseRiotId('https://op.gg/lol/summoners/euw/skapligt%20snabb-SPEED'), { region: 'euw', name: 'skapligt snabb', tag: 'SPEED' });
  assert.deepEqual(m.parseRiotId('https://www.op.gg/lol/summoners/na/Foo-NA1?queue=x'), { region: 'na', name: 'Foo', tag: 'NA1' });
  assert.equal(m.parseRiotId('nope'), null);
  assert.equal(m.parseRiotId('x#'), null);
});

test('parseRank: aliases, divisions, LP, clear', () => {
  assert.equal(m.parseRank('gold 2'), 1400);
  assert.equal(m.parseRank('g2'), 1400);
  assert.equal(m.parseRank('d3 45lp'), 2545);
  assert.equal(m.parseRank('emerald iv'), 2000);
  assert.equal(m.parseRank('master 120'), 2920);
  assert.equal(m.parseRank('iron'), 0);
  assert.equal(m.parseRank('clear'), 'clear');
  assert.equal(m.parseRank('nonsense'), null);
});

test('ratingLabel covers tiers, apex and never crashes below zero', () => {
  assert.equal(m.ratingLabel(0), 'Iron IV');
  assert.equal(m.ratingLabel(1400), 'Gold II');
  assert.equal(m.ratingLabel(2799), 'Diamond I');
  assert.equal(m.ratingLabel(2850), 'Master+ 50LP');
  assert.equal(m.ratingLabel(-120), 'Iron IV');
});

// ── balancing ────────────────────────────────────────────────────────────
const bruteBest = (ps) => {
  const n = ps.length, k = n >> 1, total = ps.reduce((s, p) => s + p.rating, 0);
  let best = Infinity;
  for (let mask = 0; mask < 1 << n; mask++) {
    let c = 0, sum = 0;
    for (let b = 0; b < n; b++) if (mask >> b & 1) { c++; sum += ps[b].rating; }
    if (c === k) best = Math.min(best, Math.abs(sum / k - (total - sum) / (n - k)));
  }
  return best;
};
const fakePs = (n, f = (i) => i * 237 % 2400) => Array.from({ length: n }, (_, i) => ({ id: U(i + 1), rating: f(i), roles: [], label: 'x', linked: true }));

test('pickSplit: near-optimal, full coverage, valid sizes for 2-10 players', () => {
  for (let n = 2; n <= 10; n++) {
    const ps = fakePs(n);
    for (let r = 0; r < 20; r++) {
      const { A, B, diff } = m.pickSplit(ps, null);
      assert.equal(A.length, n >> 1);
      assert.equal(A.length + B.length, n);
      assert.equal(new Set([...A, ...B].map((p) => p.id)).size, n);
      assert.ok(diff <= bruteBest(ps) + 20 + 1e-9, `n=${n} diff=${diff}`);
    }
  }
});

test('pickSplit: avoid key is honoured and results vary', () => {
  const ps = fakePs(10, (i) => 1000 + (i % 3) * 5); // many near-equal splits
  const seen = new Set();
  let key = null;
  for (let r = 0; r < 40; r++) {
    const res = m.pickSplit(ps, key);
    assert.notEqual(res.key, key);
    seen.add(res.key); key = res.key;
  }
  assert.ok(seen.size > 3);
});

test('duo partners always land on the same team (one-sided setting is enough)', async () => {
  reset();
  const list = ids(10);
  seed(list, (i) => 700 + i * 180);
  db.users[U(1)].duo = U(10); // best vs worst player: forces an unusual split
  for (let r = 0; r < 25; r++) {
    const res = await m.makeTeams(list);
    const side = (id) => res.teams.findIndex((t) => t.some((p) => p.id === id));
    assert.equal(side(U(1)), side(U(10)));
    assert.equal(res.duoIgnored, false);
  }
});

test('duo ignored when an exact split is impossible (3 duos, 6 players) and flagged', async () => {
  reset();
  const list = ids(6);
  seed(list);
  db.users[U(1)].duo = U(2); db.users[U(3)].duo = U(4); db.users[U(5)].duo = U(6);
  const res = await m.makeTeams(list);
  assert.equal(res.duoIgnored, true);
  assert.deepEqual(res.teams.map((t) => t.length), [3, 3]);
});

test('duo with an absent partner is ignored silently; odd player counts split n>>1 / rest', async () => {
  reset();
  const list = ids(9);
  seed(list);
  db.users[U(1)].duo = '999999';
  const res = await m.makeTeams(list);
  assert.equal(res.duoIgnored, false);
  assert.deepEqual(res.teams.map((t) => t.length).sort(), [4, 5]);
});

test('assignRoles gives everyone a unique role and honours main roles', () => {
  const team = [['top'], ['jungle'], ['mid'], ['bot'], ['support']].map((roles, i) => ({ id: U(i), rating: 1, roles }));
  for (let r = 0; r < 20; r++) {
    const out = m.assignRoles(team);
    assert.deepEqual(out.map((p) => p.role), ['top', 'jungle', 'mid', 'bot', 'support']);
    out.forEach((p, i) => assert.deepEqual(p.roles, team[i].roles));
  }
  const clash = m.assignRoles([{ id: 'a', rating: 1, roles: ['mid', 'top'] }, { id: 'b', rating: 1, roles: ['mid', 'jungle'] }]);
  assert.equal(new Set(clash.map((p) => p.role)).size, 2);
  assert.ok(clash.every((p) => p.roles.includes(p.role)));
});

// ── linking, rank, roles, duo, permissions (panel flows) ─────────────────
const modal = (customId, user, fields, extra) => mk('modal', { customId, user, fields, ...extra });
const notice = (i) => body(last(i, 'editReply'));

test('link: Name#TAG links account and shows rank; stale rank cache is used afterwards', async () => {
  reset();
  const i = modal(`lol:linkm:${U(1)}`, U(1), { riot_id: 'skapligt snabb#SPEED' });
  await m.handle(i);
  assert.match(notice(i), /Linked/);
  assert.match(notice(i), /Gold II 61LP/);
  assert.equal(db.users[U(1)].puuid, 'P1');
  assert.equal(db.users[U(1)].region, 'euw');
  assert.ok(riotCalls[0].includes('europe.api.riotgames.com'));
  assert.ok(riotCalls.some((u) => u.includes('euw1.api.riotgames.com')));
});

test('link: op.gg link sets the region (na -> americas host), duplicates and unknown ids rejected', async () => {
  reset();
  const a = modal(`lol:linkm:${U(1)}`, U(1), { riot_id: 'https://op.gg/lol/summoners/na/Foo-NA1' });
  await m.handle(a);
  assert.equal(db.users[U(1)].region, 'na');
  assert.ok(riotCalls[0].includes('americas.api.riotgames.com'));
  assert.match(notice(a), /Unranked/);

  const wrongRegion = modal(`lol:linkm:${U(2)}`, U(2), { riot_id: 'Bar#NA1' }); // NA player, no op.gg link, so EUW is assumed
  await m.handle(wrongRegion);
  assert.match(notice(wrongRegion), /no League account on EUW/);
  assert.match(notice(wrongRegion), /op\.gg/);
  assert.equal(db.users[U(2)]?.puuid, undefined);

  const dupe2 = modal(`lol:linkm:${U(2)}`, U(2), { riot_id: 'https://op.gg/lol/summoners/na/Foo-NA1' });
  await m.handle(dupe2);
  assert.match(notice(dupe2), /already linked to <@1001>/);

  const bad = modal(`lol:linkm:${U(2)}`, U(2), { riot_id: 'nope' });
  await m.handle(bad);
  assert.match(notice(bad), /Name#TAG/);
});

test('link: Riot key errors are shown to the user, flex rank is used when no solo rank', async () => {
  reset();
  riotMode = '403';
  const e = modal(`lol:linkm:${U(1)}`, U(1), { riot_id: 'skapligt snabb#SPEED' });
  await m.handle(e);
  assert.match(notice(e), /invalid or expired/);
  riotMode = 'ok';
  const f = modal(`lol:linkm:${U(1)}`, U(1), { riot_id: 'Flexer#EUW' });
  await m.handle(f);
  assert.match(notice(f), /Silver I 10LP \(flex\)/);
});

test('rank cache: fresh cache skips Riot, stale cache is served when Riot is down, 429 is retried', async () => {
  reset();
  db.users[U(1)] = { puuid: 'P1', region: 'euw', name: 'x', tag: 'y' };
  db.ranks.P1 = { at: Date.now(), rating: 1400, label: 'Gold II 61LP' };
  assert.equal((await m.getRank(db.users[U(1)])).label, 'Gold II 61LP');
  assert.equal(riotCalls.length, 0);

  db.ranks.P1.at = 0; riotMode = '403';
  const stale = await m.getRank(db.users[U(1)]);
  assert.equal(stale.label, 'Gold II 61LP');
  assert.equal(stale.rating, 1400);

  riotMode = '429once';
  const fresh = await m.getRank(db.users[U(1)], true);
  assert.equal(fresh.label, 'Gold II 61LP');
  assert.ok(riotCalls.length >= 3); // 403 attempt, 429, retry
});

test('/lol opens the panel, refreshing only a stale rank', async () => {
  reset();
  db.users[U(1)] = { puuid: 'P1', region: 'euw', name: 'skapligt snabb', tag: 'SPEED', roles: ['mid'] };
  db.ranks.P1 = { at: Date.now(), rating: 1, label: 'Fresh' };
  const a = mk('cmd', { user: U(1) });
  await m.handle(a);
  assert.equal(riotCalls.length, 0);
  assert.match(body(last(a, 'editReply')), /Fresh/);

  db.ranks.P1.at = Date.now() - 3600e3;
  const b = mk('cmd', { user: U(1) });
  await m.handle(b);
  assert.ok(riotCalls.length > 0);
  assert.match(body(last(b, 'editReply')), /Gold II 61LP/);
});

test('manual rank: set, parse errors, clear', async () => {
  reset();
  const a = modal(`lol:rankm:${U(1)}`, U(1), { rank: 'gold 2' });
  await m.handle(a);
  assert.equal(db.users[U(1)].override, 1400);
  assert.match(notice(a), /Gold II/);
  const bad = modal(`lol:rankm:${U(1)}`, U(1), { rank: 'banana' });
  await m.handle(bad);
  assert.match(notice(bad), /Couldn't read/);
  assert.equal(db.users[U(1)].override, 1400);
  await m.handle(modal(`lol:rankm:${U(1)}`, U(1), { rank: 'clear' }));
  assert.equal(db.users[U(1)].override, undefined);
});

test('roles: main, also-ok, switching main drops the duplicate, fill', async () => {
  reset();
  const sel = (id, values) => mk('comp', { customId: `lol:${id}:${U(1)}`, user: U(1), values });
  await m.handle(sel('main', ['mid']));
  assert.deepEqual(db.users[U(1)].roles, ['mid']);
  await m.handle(sel('alt', ['top', 'jungle']));
  assert.deepEqual(db.users[U(1)].roles, ['mid', 'top', 'jungle']);
  await m.handle(sel('main', ['top']));
  assert.deepEqual(db.users[U(1)].roles, ['top', 'jungle']);
  await m.handle(sel('main', ['fill']));
  assert.deepEqual(db.users[U(1)].roles, []);
});

test('duo select: set, clear, self and bots rejected', async () => {
  reset();
  const sel = (values, users) => mk('comp', { customId: `lol:duo:${U(1)}`, user: U(1), values, users });
  const ok = sel([U(2)], new Map([[U(2), { bot: false }]]));
  await m.handle(ok);
  assert.equal(db.users[U(1)].duo, U(2));
  assert.match(body(last(ok, 'update')), /same team/);
  const self = sel([U(1)], new Map([[U(1), { bot: false }]]));
  await m.handle(self);
  assert.equal(db.users[U(1)].duo, U(2));
  assert.match(body(last(self, 'update')), /someone else/);
  await m.handle(sel([U(3)], new Map([[U(3), { bot: true }]])));
  assert.equal(db.users[U(1)].duo, U(2));
  await m.handle(sel([], new Map()));
  assert.equal(db.users[U(1)].duo, undefined);
});

test('permissions: editing someone else needs Manage Server; admins can', async () => {
  reset();
  const denied = mk('comp', { customId: `lol:link:${U(1)}`, user: U(2) });
  await m.handle(denied);
  assert.match(last(denied, 'reply').content, /Manage Server/);
  const allowed = mk('comp', { customId: `lol:link:${U(1)}`, user: U(2), admin: true });
  await m.handle(allowed);
  assert.ok(last(allowed, 'showModal'));
  const cmd = mk('cmd', { user: U(2), target: { id: U(1) } });
  await m.handle(cmd);
  assert.match(last(cmd, 'reply').content, /Manage Server/);
});

test('unlink removes the account but keeps roles and record', async () => {
  reset();
  db.users[U(1)] = { puuid: 'P1', region: 'euw', name: 'a', tag: 'b', roles: ['mid'], w: 2, l: 1, adj: 10 };
  await m.handle(mk('comp', { customId: `lol:unlink:${U(1)}`, user: U(1) }));
  assert.deepEqual(db.users[U(1)], { roles: ['mid'], w: 2, l: 1, adj: 10 });
});

test('panel renders valid components in every state', () => {
  reset();
  const states = [{}, { puuid: 'P1', region: 'euw', name: 'a b', tag: 'C' }, { override: 1400, roles: [], duo: U(2) },
    { puuid: 'P1', region: 'euw', name: 'a', tag: 'b', roles: ['mid', 'top', 'jungle'], w: 3, l: 1, adj: -20, duo: U(2) }];
  for (const st of states) {
    db.users[U(1)] = st;
    const p = valid(m.panel(U(1), 'hello'));
    assert.ok(p.components.length >= 3 && p.components.length <= 5);
  }
  assert.match(body(m.panel(U(1))), /3W 1L · 75%/);
});

// ── making teams ─────────────────────────────────────────────────────────
test('Make teams: validations (not in voice, <2 players, >10 players)', async () => {
  reset();
  const w = world(ids(1));
  const lone = panelPress(w, `lol:teams:${U(1)}`, U(1));
  await m.handle(lone);
  assert.match(body(last(lone, 'update')), /at least 2/);
  const away = mk('comp', { customId: `lol:teams:${U(1)}`, user: U(1), guild: w.guild, channel: w.channel, member: { voice: {} } });
  await m.handle(away);
  assert.match(body(last(away, 'update')), /Join a voice channel/);
  const big = world(ids(11));
  const many = panelPress(big, `lol:teams:${U(1)}`, U(1));
  await m.handle(many);
  assert.match(body(last(many, 'update')), /Max 10/);
});

test('Make teams posts the embed, keeps a session, and links back from the panel', async () => {
  const { w, list, s } = await startTeams(10);
  assert.equal(w.posted.length, 1);
  assert.ok(s);
  assert.deepEqual(s.res.teams.map((t) => t.length), [5, 5]);
  assert.equal(new Set(s.res.teams.flat().map((p) => p.id)).size, 10);
  assert.deepEqual(s.res.teams.map((t) => t.map((p) => p.role)), [['top', 'jungle', 'mid', 'bot', 'support'], ['top', 'jungle', 'mid', 'bot', 'support']]);
  const labels = w.posted[0].components.flatMap((r) => r.toJSON().components.map((c) => c.label));
  assert.deepEqual(labels, ['Reroll', 'Captain draft', 'Move to team channels', '🔵 Blue won', '🔴 Red won']);
  assert.equal(list.length, 10);
});

test('teams view: one embed with header, two team sections of Role | Player | Rank columns, winner trophy', async () => {
  const { s } = await startTeams(10);
  const out = m.renderTeams(s, false);
  assert.equal(out.embeds.length, 1);
  const e = out.embeds[0].toJSON();
  assert.match(e.description, /Even match|Close|Uneven/);
  assert.match(e.fields[0].name, /^🔵 Blue Team$/);
  assert.match(e.fields[4].name, /^🔴 Red Team$/);
  assert.match(e.fields[0].value, / avg$/);
  for (const o of [1, 5]) {
    assert.deepEqual(e.fields.slice(o, o + 3).map((f) => f.name), ['Role', 'Player', 'Rank']);
    assert.ok(e.fields.slice(o, o + 3).every((f) => f.inline && f.value.split('\n').length === 5)); // one line per player so rows align
    assert.match(e.fields[o].value, /\*\*Top\*\*\n.*\*\*Jungle\*\*\n.*\*\*Mid\*\*\n.*\*\*Bot\*\*\n.*\*\*Support\*\*/);
    assert.match(e.fields[o + 2].value, /^(⚫|🟤|⚪|🟡|🔷|🟢|💎|🟣|<:lol_)/);
  }
  s.report = m.applyResult(s.res, 1, true);
  const done = m.renderTeams(s, false).embeds[0].toJSON();
  assert.match(done.fields[4].name, /^🏆 Red Team/);
  assert.match(done.fields[0].name, /^🔵 Blue Team/);
  assert.match(done.description, /Red won/);
});

test('rank icons: tiers, apex, unranked and unlinked players', async () => {
  reset();
  db.users[U(1)] = { override: 100 };            // iron
  db.users[U(2)] = { override: 1500 };           // gold
  db.users[U(3)] = { override: 2900 };           // master+
  db.users[U(4)] = { puuid: 'P2', region: 'na', name: 'Foo', tag: 'NA1' }; // linked, unranked
  const ps = await m.buildPlayers([U(1), U(2), U(3), U(4), U(5)]);
  assert.deepEqual(ps.map((p) => p.icon), ['⚫', '🟡', '🟣', '❔', '⚠️']);
});

test('Make teams without team channels hides the move button; unlinked players are called out', async () => {
  const { w } = await startTeams(4, { teamChannels: false });
  const labels = w.posted[0].components.flatMap((r) => r.toJSON().components.map((c) => c.label));
  assert.ok(!labels.includes('Move to team channels'));
  reset();
  const list = ids(4);
  seed(list.slice(0, 3));
  const w2 = world(list);
  await m.handle(panelPress(w2, `lol:teams:${U(1)}`, U(1)));
  assert.match(body(w2.posted[0]), new RegExp(`<@${U(4)}> hasn't linked`));
  assert.match(body(w2.posted[0]), /counted as Silver II/);
});

test('Reroll gives a different split and is voice-gated', async () => {
  const { w, s } = await startTeams(8);
  const before = s.res.key;
  const outsider = press(w, 'reroll', U(1), { member: { voice: { channelId: 'elsewhere' } } });
  await m.handle(outsider);
  assert.match(last(outsider, 'reply').content, /Join the voice channel/);
  const i = press(w, 'reroll', U(2));
  await m.handle(i);
  assert.ok(last(i, 'editReply'));
  assert.notEqual(s.res.key, before);
  const gone = press(w, 'reroll', U(1), { message: { id: 'nope' } });
  await m.handle(gone);
  assert.match(last(gone, 'reply').content, /Expired/);
});

test('Move to team channels then Move everyone back', async () => {
  const { w, s } = await startTeams(6);
  const mv = press(w, 'move', U(1));
  await m.handle(mv);
  assert.match(last(mv, 'editReply'), /Moved 6/);
  s.res.teams.forEach((team, side) => team.forEach((p) => assert.equal(w.members.get(p.id).voice.channelId, side ? 'vr' : 'vb')));
  assert.deepEqual(w.edits.at(-1).components.map((r) => r.toJSON().components.map((c) => c.label)), [['Move everyone back'], ['🔵 Blue won', '🔴 Red won']]);
  const back = press(w, 'back', U(1)); // pressed from inside a team channel
  await m.handle(back);
  assert.match(last(back, 'editReply'), /Moved 6/);
  w.members.forEach((mem) => assert.equal(mem.voice.channelId, 'vc1'));
  assert.equal(s.moved, false);
});

// ── results, ratings, leaderboard ────────────────────────────────────────
test('applyResult: even match is +/-12, upset pays more, clamp and undo are exact', () => {
  reset();
  const team = (ids2, rating) => ids2.map((id) => ({ id, rating }));
  const even = { teams: [team(['a', 'b'], 1000), team(['c', 'd'], 1000)], avg: [1000, 1000] };
  const r1 = m.applyResult(even, 0);
  assert.equal(r1.d, 12);
  assert.deepEqual([db.users.a.adj, db.users.c.adj], [12, -12]);
  assert.deepEqual([db.users.a.w, db.users.c.l], [1, 1]);
  m.undoResult(r1);
  assert.deepEqual([db.users.a.adj, db.users.a.w, db.users.c.adj, db.users.c.l], [0, 0, 0, 0]);

  const upset = { teams: [team(['a'], 600), team(['c'], 1000)], avg: [600, 1000] };
  assert.equal(m.applyResult(upset, 0).d, 22);

  db.users.e = { adj: 295 };
  const clamp = m.applyResult({ teams: [team(['e'], 1000), team(['f'], 1000)], avg: [1000, 1000] }, 0);
  assert.equal(db.users.e.adj, 300);
  assert.equal(clamp.deltas.e, 5);
  m.undoResult(clamp);
  assert.equal(db.users.e.adj, 295);
});

test('Blue/Red won updates records, adjusts balancing ratings, can be undone', async () => {
  const { w, s } = await startTeams(6);
  const win = press(w, 'win1', U(3));
  await m.handle(win);
  assert.match(body(last(win, 'update')), /Red won/);
  assert.deepEqual(last(win, 'update').components.map((r) => r.toJSON().components.map((c) => c.label)), [['Play again', 'Undo result']]);
  s.res.teams[1].forEach((p) => { assert.equal(db.users[p.id].w, 1); assert.ok(db.users[p.id].adj > 0); });
  s.res.teams[0].forEach((p) => { assert.equal(db.users[p.id].l, 1); assert.ok(db.users[p.id].adj < 0); });
  const sum = Object.values(db.users).reduce((t, u) => t + (u.adj || 0), 0);
  assert.equal(sum, 0);

  const winnerId = s.res.teams[1][0].id;
  const [p] = await m.buildPlayers([winnerId]);
  assert.equal(p.rating, db.users[winnerId].override + db.users[winnerId].adj);

  const undo = press(w, 'undo', U(3));
  await m.handle(undo);
  Object.values(db.users).forEach((u) => assert.deepEqual([u.adj, u.w || 0, u.l || 0], [0, 0, 0]));
  assert.equal(s.report, null);
});

test('result buttons: outsiders blocked, admins allowed, leavers can still report, no double report', async () => {
  const { w, s } = await startTeams(4);
  const outsider = press(w, 'win0', '4242');
  await m.handle(outsider);
  assert.match(last(outsider, 'reply').content, /Only players/);
  assert.equal(s.report, undefined);

  const admin = press(w, 'win0', '4242', { admin: true });
  await m.handle(admin);
  assert.ok(s.report);

  s.report = undefined; // player who already left voice
  w.members.get(U(2)).voice.channelId = null;
  await m.handle(press(w, 'win0', U(2)));
  assert.ok(s.report);

  const again = press(w, 'win1', U(2));
  await m.handle(again);
  assert.match(last(again, 'reply').content, /already reported/);
});

test('leaderboard: ranked by rank + adjustment, only players with games, empty state', async () => {
  reset();
  const press1 = () => mk('comp', { customId: `lol:board:${U(1)}`, user: U(1) });
  const empty = press1();
  await m.handle(empty);
  assert.match(body(last(empty, 'reply')), /No results yet/);

  db.users[U(1)] = { override: 1000, w: 3, l: 1, adj: 40 };
  db.users[U(2)] = { override: 1200, w: 1, l: 3, adj: -30 };
  db.users[U(3)] = { override: 2000 }; // no games
  db.users[U(4)] = { puuid: 'P1', w: 1, l: 0, adj: 5 }; // uses cached rank
  db.ranks.P1 = { at: 0, rating: 1400, label: 'Gold II' };
  const i = press1();
  await m.handle(i);
  const text = body(last(i, 'reply'));
  const order = [U(4), U(2), U(1)].map((id) => text.indexOf(`<@${id}>`));
  assert.ok(order.every((x) => x > 0) && order[0] < order[1] && order[1] < order[2], text);
  assert.ok(!text.includes(`<@${U(3)}>`));
  assert.match(text, /3W 1L · 75%/);
  assert.match(text, /🥇/);
  assert.match(text, /\+40/);
  assert.match(text, /−30/);
});

// ── captain draft ────────────────────────────────────────────────────────
test('pickTeam is a snake order and draft sizes work for 4-10 players', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(m.pickTeam), [0, 1, 1, 0, 0, 1, 1, 0]);
  for (let n = 4; n <= 10; n++) {
    const d = m.startDraft(fakePs(n), {});
    while (d.pool.length) m.draftPick(d, d.pool[0].id);
    assert.deepEqual(d.teams.map((t) => t.length).sort(), [n >> 1, n - (n >> 1)]);
    assert.equal(new Set(d.teams.flat().map((p) => p.id)).size, n);
  }
});

test('draft: top two rated captain, lower-rated captain picks first', () => {
  const d = m.startDraft(fakePs(8, (i) => i * 100), {});
  assert.deepEqual(d.teams.map((t) => t[0].rating), [600, 700]);
  assert.equal(m.draftCaptain(d).rating, 600);
  assert.equal(m.draftPick(d, 'nobody'), false);
});

test('captain draft flow: only the captain can pick, finishes into normal teams, cancel restores', async () => {
  const { w, s } = await startTeams(6);
  const original = s.res;

  const few = world(ids(3)); // a draft needs at least 4 players
  m.sessions.set('tiny', { vcId: 'vc1', res: original, t: Date.now() });
  const tiny = press(few, 'draft', U(1), { message: { id: 'tiny' } });
  await m.handle(tiny);
  assert.match(last(tiny, 'reply').content, /at least 4/);
  assert.equal(m.sessions.get('tiny').draft, undefined);

  const start = press(w, 'draft', U(1));
  await m.handle(start);
  assert.ok(s.draft);
  const menu = last(start, 'editReply').components[0].toJSON().components[0];
  assert.equal(menu.options.length, 4);
  assert.match(menu.options[0].label, /^Name/);

  // cancel restores the previous teams
  const cancel = press(w, 'cancel', U(2));
  await m.handle(cancel);
  assert.equal(s.draft, null);
  assert.equal(s.res, original);

  await m.handle(press(w, 'draft', U(1)));
  const wrong = press(w, 'pick', U(1), { values: [s.draft.pool[0].id] });
  const cap = m.draftCaptain(s.draft).id;
  const wrongUser = ids(6).find((x) => x !== cap);
  await m.handle(Object.assign(wrong, { user: { id: wrongUser } }));
  assert.match(last(wrong, 'reply').content, /Waiting for/);

  while (s.draft) {
    const c = m.draftCaptain(s.draft).id;
    await m.handle(press(w, 'pick', c, { values: [s.draft.pool[0].id] }));
  }
  assert.equal(s.drafted, true);
  assert.deepEqual(s.res.teams.map((t) => t.length), [3, 3]);
  assert.equal(new Set(s.res.teams.flat().map((p) => p.id)).size, 6);
  assert.match(body(m.renderTeams(s, true)), /captain draft/);

  const win = press(w, 'win0', U(1)); // a drafted result can be reported like any other
  await m.handle(win);
  assert.match(body(last(win, 'update')), /Blue won/);
});

// ── practice lobby (fake players, no voice channel) ──────────────────────
// the tester is NOT in any voice channel here
async function startPractice(n, { admin = true, duo } = {}) {
  reset();
  m.testLobbies.clear();
  const w = world([U(1)]);
  w.members.get(U(1)).voice = {}; // not in voice
  if (duo) db.users[U(1)] = { override: 1200, duo };
  const open = mk('cmd', { user: U(1), admin, test: n });
  await m.handle(open);
  const make = mk('comp', { customId: `lol:teams:${U(1)}`, user: U(1), guild: w.guild, channel: w.channel, member: w.members.get(U(1)) });
  await m.handle(make);
  return { w, open, make, s: m.sessions.get('msg1') };
}
const tpress = (w, customId, user = U(1), extra = {}) =>
  mk('comp', { customId, user, guild: w.guild, member: { voice: {} }, message: w.message(), ...extra });

test('/lol test:N needs Manage Server; the panel announces the practice lobby; plain /lol leaves it', async () => {
  reset(); m.testLobbies.clear();
  const denied = mk('cmd', { user: U(1), test: 6 });
  await m.handle(denied);
  assert.match(last(denied, 'reply').content, /Manage Server/);
  assert.equal(m.testLobbies.size, 0);

  const ok = mk('cmd', { user: U(1), admin: true, test: 6 });
  await m.handle(ok);
  assert.equal(m.testLobbies.get(U(1)), 6);
  assert.match(body(last(ok, 'editReply')), /Practice lobby: you \+ 5 fake players/);

  const leave = mk('cmd', { user: U(1), admin: true });
  await m.handle(leave);
  assert.equal(m.testLobbies.has(U(1)), false);
  assert.doesNotMatch(body(last(leave, 'editReply')), /Practice lobby/);
});

test('practice Make teams works alone: fake players by name, no move button, 🧪 marked', async () => {
  const { w, s, make } = await startPractice(8);
  assert.ok(s?.test);
  assert.equal(s.res.teams.flat().length, 8);
  assert.equal(w.posted.length, 1);
  const text = body(w.posted[0]);
  assert.match(text, /🧪 Teams/);
  assert.match(text, /\*\*Test 1\*\*/);
  assert.match(text, new RegExp(`<@${U(1)}>`));
  assert.doesNotMatch(text, /<@test:/);
  assert.doesNotMatch(text, /practice lobby, not saved/);
  const labels = w.posted[0].components.flatMap((r) => r.toJSON().components.map((c) => c.label));
  assert.deepEqual(labels, ['Reroll', 'Captain draft', '🔵 Blue won', '🔴 Red won']);
  assert.match(body(last(make, 'editReply')), /Test teams posted/);
});

test('without a practice lobby, Make teams still needs a voice channel', async () => {
  reset(); m.testLobbies.clear();
  const w = world([U(1)]);
  const i = mk('comp', { customId: `lol:teams:${U(1)}`, user: U(1), guild: w.guild, channel: w.channel, member: { voice: {} } });
  await m.handle(i);
  assert.match(body(last(i, 'update')), /Join a voice channel/);
});

test('practice lobby buttons are owner-only; reroll works without voice', async () => {
  const { w, s } = await startPractice(7);
  const stranger = tpress(w, 'reroll', U(2));
  await m.handle(stranger);
  assert.match(last(stranger, 'reply').content, /someone else's practice lobby/);
  const before = s.res.key;
  const i = tpress(w, 'reroll');
  await m.handle(i);
  assert.ok(last(i, 'editReply'));
  assert.notEqual(s.res.key, before);
  assert.equal(s.res.teams.flat().length, 7);
});

test('practice draft: you pick for both captains, finishes into teams', async () => {
  const { w, s } = await startPractice(8);
  await m.handle(tpress(w, 'draft'));
  assert.ok(s.draft);
  assert.match(body(m.renderDraft(s)), /🧪 Captain draft/);
  while (s.draft) await m.handle(tpress(w, 'pick', U(1), { values: [s.draft.pool[0].id] })); // always the same user
  assert.equal(s.drafted, true);
  assert.deepEqual(s.res.teams.map((t) => t.length), [4, 4]);
  assert.equal(new Set(s.res.teams.flat().map((p) => p.id)).size, 8);
});

test('practice draft needs 4 players', async () => {
  const { w, s } = await startPractice(3);
  const i = tpress(w, 'draft');
  await m.handle(i);
  assert.match(last(i, 'reply').content, /at least 4/);
  assert.equal(s.draft, undefined);
});

test('practice results are computed but never saved; undo works; no fake players leak into the db', async () => {
  const { w, s } = await startPractice(6);
  const win = tpress(w, 'win0');
  await m.handle(win);
  assert.match(body(last(win, 'update')), /🧪 Teams · 🔵 Blue won/);
  assert.match(body(last(win, 'update')), /🧪 Teams/);
  assert.equal(s.report.dry, true);
  assert.deepEqual(db.users, {});
  const undo = tpress(w, 'undo');
  await m.handle(undo);
  assert.equal(s.report, null);
  assert.deepEqual(db.users, {});
  assert.ok(!Object.keys(db.users).some((k) => k.startsWith('test:')));
  const board = mk('comp', { customId: `lol:board:${U(1)}`, user: U(1) });
  await m.handle(board);
  assert.match(body(last(board, 'reply')), /No results yet/);
});

test('practice lobby: your duo setting makes Test 1 your partner, always on your team', async () => {
  for (let r = 0; r < 15; r++) {
    const { s } = await startPractice(8, { duo: U(2) }); // U(2) isn't in the lobby; Test 1 stands in
    const side = (id) => s.res.teams.findIndex((t) => t.some((p) => p.id === id));
    assert.equal(side('test:1'), side(U(1)));
    assert.match(s.names['test:1'], /🤝/);
  }
});

// ── plumbing ─────────────────────────────────────────────────────────────
test('10062 Unknown interaction is logged as a diagnosis, never answered', async () => {
  const warns = [];
  const orig = console.warn; console.warn = (x) => warns.push(x);
  try {
    const err = Object.assign(new Error('Unknown interaction'), { code: 10062 });
    const late = mk('cmd', { user: U(1), createdTimestamp: Date.now() - 5000, over: { deferReply: async () => { throw err; } } });
    await m.handle(late);
    const prompt = mk('cmd', { user: U(1), over: { deferReply: async () => { throw err; } } });
    await m.handle(prompt);
    assert.equal(late.calls.length + prompt.calls.length, 0);
  } finally { console.warn = orig; }
  assert.match(warns[0], /arrived late/i);
  assert.match(warns[1], /another copy/i);
});

test('unexpected errors reply with a message instead of crashing', async () => {
  const orig = console.error; console.error = () => {};
  try {
    const i = mk('cmd', { user: U(1), over: { deferReply: async () => { throw new Error('boom'); } } });
    await m.handle(i);
    assert.match(last(i, 'reply').content, /Error/);
  } finally { console.error = orig; }
});

test('state is persisted to the database file', () => {
  reset();
  db.users[U(1)] = { roles: ['mid'] };
  m.applyResult({ teams: [[{ id: U(1) }], [{ id: U(2) }]], avg: [1000, 1000] }, 0);
  const onDisk = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
  assert.equal(onDisk.users[U(1)].w, 1);
  assert.deepEqual(onDisk.users[U(1)].roles, ['mid']);
});

test('rank crests: uploaded as app emojis, used in cards and select menus, fallback on failure', async () => {
  const made = [];
  const realFetch = global.fetch;
  global.fetch = async (u) => (/emblem-silver/.test(u) ? { arrayBuffer: async () => { throw new Error('404'); } } : { arrayBuffer: async () => new ArrayBuffer(4) });
  const app = { emojis: { fetch: async () => new Map([[1, { name: 'lol_gold', id: '900' }]]), create: async ({ name }) => { if (name === 'lol_silver') throw new Error('upload failed'); made.push(name); return { name, id: String(made.length) }; } } };
  try { await m.loadCrests(app); } finally { global.fetch = realFetch; }
  assert.ok(!made.includes('lol_gold'), 'existing emoji reused, not re-uploaded');
  assert.equal(m.rankIcon(1300), '<:lol_gold:900>');
  assert.match(m.rankIcon(2900), /^<:lol_master:\d+>$/);
  assert.equal(m.rankIcon(900), '⚪', 'failed upload falls back to unicode');
  const d = m.startDraft(fakePs(6, () => 1300).map((p) => ({ ...p, name: p.id, icon: m.rankIcon(1300) })), {});
  const out = m.renderDraft({ draft: d });
  assert.match(JSON.stringify(out), /<:lol_gold:900>/);
  JSON.stringify(out.components.map((c) => c.toJSON())); // builder validation of the menu emoji
  for (const t of Object.keys(m.crests)) delete m.crests[t];
});

test('teams message carries the banner image', async () => {
  const { w, s } = await startPractice(8);
  const out = m.renderTeams(s, false);
  assert.equal(out.files.length, 1);
  assert.equal(out.embeds[0].toJSON().image.url, 'attachment://banner.png');
});

// ── queue ────────────────────────────────────────────────────────────────
async function openQ(host = U(1)) {
  reset(); m.queues.clear();
  const list = ids(6); seed(list);
  const w = world([]); // nobody needs to be in voice
  const open = mk('cmd', { user: host, guild: w.guild, channel: w.channel, over: { commandName: 'queue' } });
  await m.handle(open);
  const q = [...m.queues.values()][0];
  const msgId = 'qmsg';
  m.queues.clear(); m.queues.set(msgId, q);
  const qpress = (id, user, o = {}) => mk('comp', { customId: id, user, guild: w.guild, channel: w.channel, message: { id: msgId }, ...o });
  return { w, q, qpress, open, list };
}

test('queue: /queue posts an empty queue with Join/Leave/Start/Profile/Host', async () => {
  const { q, open } = await openQ();
  assert.equal(q.host, U(1));
  const out = last(open, 'editReply');
  assert.match(body(out), /Nobody yet/);
  assert.deepEqual(out.components[0].toJSON().components.map((c) => c.label), ['Join queue', 'Leave', 'Start now', 'My profile', 'Host']);
  assert.equal(out.components[0].toJSON().components[2].disabled, true);
});

test('queue: join, duplicate join, leave, full queue', async () => {
  const { q, qpress, list } = await openQ();
  for (const u of list.slice(0, 2)) await m.handle(qpress('q:join', u));
  assert.deepEqual(q.ids, list.slice(0, 2));
  const dup = qpress('q:join', list[0]); await m.handle(dup);
  assert.match(last(dup, 'reply').content, /already/);
  const lv = qpress('q:leave', list[0]); await m.handle(lv);
  assert.deepEqual(q.ids, [list[1]]);
  const nope = qpress('q:leave', list[0]); await m.handle(nope);
  assert.match(last(nope, 'reply').content, /not in the queue/);
  q.ids = ids(10);
  const full = qpress('q:join', U(99)); await m.handle(full);
  assert.match(last(full, 'reply').content, /full/);
});

test('queue: start posts a pinging teams message, queue resets and stays open; reroll/results/move work without the lobby', async () => {
  const { w, q, qpress, list } = await openQ();
  q.ids = list.slice(0, 6); // pretend six joined
  const outsider = qpress('q:start', U(77)); await m.handle(outsider);
  assert.match(last(outsider, 'reply').content, /Join the queue/);
  const go = qpress('q:start', list[0]); await m.handle(go);
  assert.equal(w.posted.length, 2, 'teams, then the queue re-posted below them');
  assert.match(w.posted[0].content, /Match ready/);
  assert.deepEqual(w.posted[0].allowedMentions.users, list.slice(0, 6));
  assert.equal(m.queues.size, 1, 'queue stays open');
  assert.equal(m.queues.get('msg2'), q, 'under its new message id');
  assert.deepEqual(q.ids, []);
  assert.equal(q.games, 1);
  assert.match(body(w.posted[1]), /Last match/);
  const s = m.sessions.get('msg1');
  assert.ok(s.queue);
  assert.equal(s.res.teams.flat().length, 6);
  // a player can reroll without being in voice; strangers cannot
  const rr = press(w, 'reroll', list[1]); await m.handle(rr);
  assert.equal(last(rr, 'editReply').embeds.length, 1);
  const stranger = press(w, 'reroll', U(77)); await m.handle(stranger);
  assert.match(last(stranger, 'reply').content, /Only players/);
  const win = press(w, 'win1', list[2]); await m.handle(win);
  assert.match(body(last(win, 'update')), /Red won/);
});

test('queue: pops automatically at 10, profile button opens your panel, one queue per channel', async () => {
  const { w, q, qpress, list, open } = await openQ();
  q.ids = ids(9);
  const tenth = qpress('q:join', U(10)); await m.handle(tenth);
  assert.equal(w.posted.length, 2);
  assert.equal(m.sessions.get('msg1').res.teams.flat().length, 10);
  assert.deepEqual(q.ids, []);
  assert.match(body(w.posted[1]), /Custom game queue/);
  const me = qpress('q:me', list[0], { message: { id: 'msg2' } }); await m.handle(me);
  assert.match(body(last(me, 'reply')), /League profile/);
  assert.ok(last(me, 'reply').flags);
  q.channelId = 'c1';
  const again = mk('cmd', { user: U(2), guild: w.guild, channel: w.channel, over: { commandName: 'queue', channelId: 'c1' } });
  await m.handle(again);
  assert.match(last(again, 'reply').content, /already a queue/);
});

test('queue: unlinked joiner gets a hint; move to team channels remembers where everyone came from', async () => {
  const { w, q, qpress } = await openQ();
  const j = qpress('q:join', U(55)); await m.handle(j);
  assert.match(last(j, 'followUp').content, /link your Riot account/);
  // two queued players sitting in different voice channels
  reset();
  const list = ids(2); seed(list);
  const w2 = world(list);
  w2.members.get(list[1]).voice.channelId = 'afk';
  m.queues.set('qm2', { host: list[0], channelId: 'c2', ids: list.slice(), t: Date.now() });
  await m.handle(mk('comp', { customId: 'q:start', user: list[0], guild: w2.guild, channel: w2.channel, message: { id: 'qm2' } }));
  const s = m.sessions.get('msg1');
  const mv = press(w2, 'move', list[0]); await m.handle(mv);
  assert.match(last(mv, 'editReply'), /Moved 2/);
  assert.ok(['vb', 'vr'].includes(w2.members.get(list[1]).voice.channelId));
  const back = press(w2, 'back', list[0], { member: w2.members.get(list[0]) }); await m.handle(back);
  assert.equal(w2.members.get(list[1]).voice.channelId, 'afk');
  assert.equal(w2.members.get(list[0]).voice.channelId, 'vc1');
  assert.ok(s.origin);
});

test('queue: draft works from a queue, close is host-only', async () => {
  const { w, q, qpress, list } = await openQ();
  q.ids = list.slice(0, 6);
  await m.handle(qpress('q:start', list[0]));
  const dr = press(w, 'draft', list[0]); await m.handle(dr);
  assert.match(body(last(dr, 'editReply')), /Captain draft/);
  const { q: q2, qpress: qp2, list: l2 } = await openQ();
  q2.ids = [l2[1]];
  const bad = qp2('q:close', l2[1]); await m.handle(bad);
  assert.match(last(bad, 'reply').content, /Only the host/);
  const ok = qp2('q:close', U(1)); await m.handle(ok);
  assert.match(body(last(ok, 'update')), /Closed/);
  assert.equal(m.queues.size, 0);
  const gone = qp2('q:join', l2[1]); await m.handle(gone);
  assert.match(last(gone, 'reply').content, /expired/);
});

test('teams view: win-chance bar, off-role marker, result shows per-player rating change', async () => {
  const { s } = await startTeams(10);
  const e = m.renderTeams(s, false).embeds[0].toJSON();
  assert.match(e.description, /🔵 \*\*\d+%\*\* (🟦|🟥){10} \*\*\d+%\*\* 🔴/);
  // force an off-role assignment
  const p = s.res.teams[0][0]; p.roles = ['support']; p.role = 'top';
  const e2 = m.renderTeams(s, false).embeds[0].toJSON();
  assert.match(e2.fields[1].value, /Top\*\* ↻/);
  assert.match(e2.footer.text, /off-role/);
  s.report = m.applyResult(s.res, 0, true);
  const e3 = m.renderTeams(s, false).embeds[0].toJSON();
  assert.equal(e3.fields[3].name, 'Rank · in-house');
  assert.match(e3.fields[3].value, /\*\*\+\d+\*\*/);
  assert.match(e3.fields[7].value, /\*\*−\d+\*\*/);
});

test('play again: posts fresh teams for the same players in a new message, old one keeps the result', async () => {
  const { w, s, list } = await startTeams(6);
  await m.handle(press(w, 'win0', list[0], { member: w.members.get(list[0]) }));
  const before = w.posted.length;
  const again = press(w, 'again', list[0], { member: w.members.get(list[0]), channel: w.channel }); await m.handle(again);
  assert.equal(w.posted.length, before + 1);
  const ns = m.sessions.get(`msg${w.posted.length}`);
  assert.ok(ns && !ns.report);
  assert.equal(ns.res.teams.flat().length, 6);
  assert.match(body(last(again, 'editReply')), /Next game/);
  assert.deepEqual(last(again, 'editReply').components[0].toJSON().components.map((c) => c.label), ['Undo result']);
  const twice = press(w, 'again', list[0], { member: w.members.get(list[0]) }); await m.handle(twice);
  assert.match(last(twice, 'reply').content, /already/);
});

test('leaderboard shows your own position below the top 10; panel shows your rank crest', () => {
  reset();
  for (let k = 1; k <= 12; k++) db.users[U(k)] = { override: 2000 - k * 50, w: 1, l: 1 };
  const e = m.boardEmbed(U(12)).toJSON();
  const lines = e.description.split('\n');
  assert.equal(lines.length, 12);
  assert.equal(lines[10], '⋯');
  assert.match(lines[11], new RegExp(`12.*<@${U(12)}>`));
  assert.equal(m.boardEmbed(U(1)).toJSON().description.split('\n').length, 10);
  const p = m.panel(U(1));
  assert.equal(p.embeds[0].toJSON().thumbnail.url, 'attachment://crest.png');
  assert.match(String(p.files[0].attachment), /icons\/(gold|silver|platinum)\.png$/);
  assert.equal(m.panel(U(99)).files.length, 0, 'no crest before linking');
});

test('live state: queues and teams messages survive a restart', async () => {
  const { q, qpress, list } = await openQ();
  await m.handle(qpress('q:join', list[0]));
  q.ids = list.slice(0, 4);
  await m.handle(qpress('q:start', list[0]));
  await m.handle(qpress('q:join', list[5], { message: { id: 'msg2' } }));
  const sess = JSON.stringify(m.sessions.get('msg1').res.teams);
  const onDisk = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.live.queues), ['msg2']);
  assert.deepEqual(onDisk.live.queues.msg2.ids, [list[5]]);
  m.queues.clear(); m.sessions.clear();
  m.db.live = onDisk.live; m.restoreLive();
  assert.deepEqual(m.queues.get('msg2').ids, [list[5]]);
  assert.equal(JSON.stringify(m.sessions.get('msg1').res.teams), sess);
  // stale entries are dropped
  m.queues.clear(); m.sessions.clear();
  m.db.live = { queues: { old: { t: 0, ids: [] } }, sessions: { olds: { t: 0 } } }; m.restoreLive();
  assert.equal(m.queues.size + m.sessions.size, 0);
});

test('queue: a deleted queue message frees the channel; overlapping joins all show up', async () => {
  const { w, q, qpress, list } = await openQ();
  q.channelId = 'c1';
  const ch = { ...w.channel, messages: { fetch: async () => { const e = new Error('Unknown Message'); e.code = 10008; throw e; } } };
  const again = mk('cmd', { user: U(2), guild: w.guild, channel: ch, over: { commandName: 'queue' } });
  await m.handle(again);
  assert.ok(!last(again, 'reply'), 'no "already a queue" reply');
  assert.ok(last(again, 'editReply'), 'new queue posted');
  // three joins at once
  assert.ok(m.queues.get('x') && !m.queues.get('qmsg'));
  const presses = list.slice(0, 3).map((u) => qpress('q:join', u, { message: { id: 'x' } }));
  await Promise.all(presses.map((x) => m.handle(x)));
  const final = last(presses[2], 'editReply');
  for (const u of list.slice(0, 3)) assert.match(body(final), new RegExp(`<@${u}>`));
});

test('/leaderboard posts the board publicly', async () => {
  reset();
  db.users[U(1)] = { override: 1500, w: 2, l: 1 };
  const i = mk('cmd', { user: U(1), over: { commandName: 'leaderboard' } });
  await m.handle(i);
  const r = last(i, 'reply');
  assert.ok(!r.flags, 'public');
  assert.match(body(r), new RegExp(`<@${U(1)}>`));
});

test('balancing prefers splits where roles fit: two top-only players never share a team', () => {
  const ps = [
    { id: 'a', rating: 1000, roles: ['top'], label: 'x', linked: true }, { id: 'b', rating: 1000, roles: ['top'], label: 'x', linked: true },
    { id: 'c', rating: 1000, roles: ['mid'], label: 'x', linked: true }, { id: 'd', rating: 1000, roles: ['mid'], label: 'x', linked: true },
  ];
  for (let k = 0; k < 60; k++) {
    const res = m.balance(ps);
    const tops = res.teams.map((t) => t.filter((p) => p.roles[0] === 'top').length);
    assert.deepEqual(tops, [1, 1]);
    assert.ok(res.teams.flat().every((p) => p.role === p.roles[0]), 'everyone on their main');
  }
});

test('draft with 10 real players and long emoji codes stays within embed limits', () => {
  for (const t of ['iron', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'master', 'unranked', 'role_top', 'role_jungle', 'role_mid', 'role_bot', 'role_support'])
    m.crests[t] = `<:lol_${t}:123456789012345678>`;
  try {
    const R = ['support', 'jungle', 'top', 'mid', 'bot'];
    const ps = Array.from({ length: 10 }, (_, k) => ({ id: String(100000000000000000n + BigInt(k)), rating: 1600 + k, label: 'Platinum III (flex)*', icon: m.rankIcon(1600), roles: [R[k % 5]], linked: true }));
    const s = { draft: m.startDraft(ps, Object.fromEntries(ps.map((p) => [p.id, 'A very long display name'.repeat(2)]))) };
    const out = m.renderDraft(s);
    const e = out.embeds[0].toJSON();
    for (const f of e.fields) assert.ok(f.value.length <= 1024, `${f.name}: ${f.value.length}`);
    out.components.forEach((r) => r.toJSON());
  } finally { for (const t of Object.keys(m.crests)) delete m.crests[t]; }
});

test('queue host tools: host-only, remove a player (public message updates), close', async () => {
  const { w, q, qpress, list } = await openQ();
  q.ids = list.slice(0, 3);
  const edits = [];
  const ch = { ...w.channel, messages: { fetch: async (id) => ({ id, edit: async (p) => { edits.push(p); } }) } };
  const notHost = qpress('q:host', list[1]); await m.handle(notHost);
  assert.match(last(notHost, 'reply').content, /Only the host/);
  const open = qpress('q:host', U(1), { channel: ch }); await m.handle(open);
  const menu = last(open, 'editReply');
  assert.match(menu.content, /Host tools\*\* · 3\/10/);
  const opts = menu.components[0].toJSON().components[0].options;
  assert.deepEqual(opts.map((o) => o.value), list.slice(0, 3));
  assert.equal(opts[0].label, 'Player 1'); // nobody in this fake guild, so the fallback label
  const kick = mk('comp', { customId: 'qh:kick:qmsg', user: U(1), values: [list[1]], guild: w.guild, channel: ch });
  await m.handle(kick);
  assert.deepEqual(q.ids, [list[0], list[2]]);
  assert.equal(edits.length, 1);
  assert.doesNotMatch(body(edits[0]), new RegExp(`<@${list[1]}>`));
  assert.match(last(kick, 'editReply').content, /Removed/);
  const sneaky = mk('comp', { customId: 'qh:kick:qmsg', user: list[2], values: [list[0]], guild: w.guild, channel: ch });
  await m.handle(sneaky);
  assert.equal(q.ids.length, 2, 'non-host cannot remove');
  const close = mk('comp', { customId: 'qh:close:qmsg', user: U(1), guild: w.guild, channel: ch });
  await m.handle(close);
  assert.equal(m.queues.size, 0);
  assert.match(body(edits[1]), /Closed by/);
  assert.equal(edits[1].components.length, 0);
});

test('recent form: history recorded, undo removes it, streak shown on panel and leaderboard', () => {
  reset();
  const team = (a) => a.map((id) => ({ id }));
  const res = { teams: [team([U(1), U(2)]), team([U(3), U(4)])], avg: [1000, 1000] };
  for (let k = 0; k < 3; k++) m.applyResult(res, 0);
  const rep = m.applyResult(res, 0);
  assert.deepEqual(db.users[U(1)].hist, ['W', 'W', 'W', 'W']);
  assert.deepEqual(db.users[U(3)].hist, ['L', 'L', 'L', 'L']);
  m.undoResult(rep);
  assert.deepEqual(db.users[U(1)].hist, ['W', 'W', 'W']);
  assert.match(body(m.panel(U(1))), /🟩🟩🟩 🔥3/);
  assert.match(body(m.panel(U(3))), /🟥🟥🟥/);
  assert.match(m.boardEmbed().toJSON().description, /🔥3/);
  for (let k = 0; k < 12; k++) m.applyResult(res, 1);
  assert.equal(db.users[U(1)].hist.length, 10, 'only the last 10 are kept');
});

test('queue host tools: move to bottom re-posts the queue and deletes the old message', async () => {
  const { w, q } = await openQ();
  q.ids = [U(2)];
  const deleted = [];
  const ch = { ...w.channel, messages: { fetch: async (id) => ({ id, edit: async () => {} }), delete: async (id) => { deleted.push(id); } } };
  const bump = mk('comp', { customId: 'qh:bump:qmsg', user: U(1), guild: w.guild, channel: ch });
  await m.handle(bump);
  assert.deepEqual(deleted, ['qmsg']);
  assert.equal(m.queues.get('msg1'), q);
  assert.ok(!m.queues.has('qmsg'));
  assert.match(body(w.posted[0]), new RegExp(`<@${U(2)}>`));
  assert.match(last(bump, 'editReply').content, /moved to the bottom/);
});
