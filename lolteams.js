#!/usr/bin/env node
// lolteams.js — Discord bot for League of Legends custom games: link Riot accounts, rank-balanced teams,
// captain drafts, duo partners, win/loss tracking with an in-house leaderboard.
// One slash command (/lol) opens a personal (ephemeral) panel; teams are posted in the channel with buttons.
// Setup: npm i discord.js   (Node 20.12+)
// Run:   DISCORD_TOKEN=... RIOT_KEY=... [GUILD_ID=...]  (or put them in a .env file) [DEFAULT_REGION=euw] [TEAM1_VC=...] [TEAM2_VC=...] node lolteams.js
// Bot invite scopes: bot + applications.commands. Permissions: View Channel, Send Messages, Embed Links, Connect, Move Members.
// "Move to team channels" works out of the box if the server has voice channels with "blue" and "red" in their names
// (or set TEAM1_VC / TEAM2_VC channel IDs).
'use strict';
try { process.loadEnvFile(); } catch {} // optional .env file (Node 20.12+)
const fs = require('fs');
const {
  Client, Events, GatewayIntentBits, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, UserSelectMenuBuilder, PermissionFlagsBits, SlashCommandBuilder,
} = require('discord.js');

// ── config ───────────────────────────────────────────────────────────────
const { DISCORD_TOKEN, RIOT_KEY, GUILD_ID, TEAM1_VC, TEAM2_VC } = process.env;
const DB_FILE = process.env.DB_FILE || 'data.json';
const RANK_TTL = (+process.env.RANK_TTL_HOURS || 24) * 3600e3; // rank cache lifetime (teams use this)
const FRESH = 30 * 60e3;                                       // opening /lol refreshes your own rank if older than this
const DEFAULT_RATING = +process.env.DEFAULT_RATING || 1000;    // unranked / unlinked (= Silver II)
const TOLERANCE = +process.env.TOLERANCE || 20;                // avg-rating slack for random split choice
const ELO_K = 24;                                              // in-house rating swing per reported game
const ADJ_MAX = 300;                                           // in-house adjustment is clamped to ±this
const SESSION_TTL = 12 * 3600e3;                               // teams message stays interactive this long (memory only)
const EPH = MessageFlags.Ephemeral;

// region -> [platform host, regional host]
const REGIONS = {
  euw: ['euw1', 'europe'], eune: ['eun1', 'europe'], tr: ['tr1', 'europe'], ru: ['ru', 'europe'],
  na: ['na1', 'americas'], br: ['br1', 'americas'], lan: ['la1', 'americas'], las: ['la2', 'americas'],
  oce: ['oc1', 'americas'], kr: ['kr', 'asia'], jp: ['jp1', 'asia'],
};
const DEFAULT_REGION = REGIONS[process.env.DEFAULT_REGION] ? process.env.DEFAULT_REGION : 'euw';
const ROLES = ['top', 'jungle', 'mid', 'bot', 'support'];
const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND'];
const APEX = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const DIVS = ['IV', 'III', 'II', 'I'];
const cap = (s) => s[0].toUpperCase() + s.slice(1).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signed = (n) => `${n < 0 ? '−' : '+'}${Math.abs(n)}`;

// ── storage (one JSON file, atomic write) ────────────────────────────────
// users[discordId] = { puuid, region, name, tag, override?, roles?, duo?, w?, l?, adj? }   ranks[puuid] = { at, rating, label }
// roles = [main, ...alsoOk]; [] = fill; undefined = never set.  adj = in-house rating adjustment from reported results.
let db = { users: {}, ranks: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
function save() {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}

// ── Riot API (serialized, ~16 req/s, honours Retry-After) ────────────────
class RiotError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
let queue = Promise.resolve();
function riot(host, path) {
  const job = async () => {
    for (let tries = 0; tries < 4; tries++) {
      const r = await fetch(`https://${host}.api.riotgames.com${path}`, { headers: { 'X-Riot-Token': RIOT_KEY } });
      if (r.status === 429) { await sleep((+r.headers.get('retry-after') || 1) * 1000 + 100); continue; }
      if (r.status === 404) return null;
      if (!r.ok) throw new RiotError(r.status, `Riot ${r.status}`);
      return r.json();
    }
    throw new RiotError(429, 'Riot rate limit');
  };
  const p = queue.then(job);
  queue = p.then(() => sleep(60), () => sleep(60));
  return p;
}
const accountByRiotId = (region, name, tag) =>
  riot(REGIONS[region][1], `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);

// ── ranks ────────────────────────────────────────────────────────────────
function toRating(e) {
  if (APEX.has(e.tier)) return 2800 + e.leaguePoints;
  return TIERS.indexOf(e.tier) * 400 + DIVS.indexOf(e.rank) * 100 + e.leaguePoints;
}
function ratingLabel(r) {
  r = Math.max(0, r);
  if (r >= 2800) return `Master+ ${Math.round(r - 2800)}LP`;
  return `${cap(TIERS[Math.floor(r / 400)])} ${DIVS[Math.floor((r % 400) / 100)]}`;
}
function entryLabel(e) {
  return APEX.has(e.tier) ? `${cap(e.tier)} ${e.leaguePoints}LP` : `${cap(e.tier)} ${e.rank} ${e.leaguePoints}LP`;
}

// cached; stale cache is used if Riot errors. Re-resolves puuid from Riot ID if the key/app changed.
async function getRank(u, force = false) {
  const none = { at: 0, rating: null, label: 'Unranked' };
  if (!u.puuid) return none;
  const c = db.ranks[u.puuid];
  if (c && !force && Date.now() - c.at < RANK_TTL) return c;
  try {
    const host = REGIONS[u.region][0];
    let entries;
    try {
      entries = await riot(host, `/lol/league/v4/entries/by-puuid/${u.puuid}`);
    } catch (e) {
      if (e.status !== 400) throw e; // 400 = puuid from a different API key
      const acc = await accountByRiotId(u.region, u.name, u.tag);
      if (!acc) throw e;
      u.puuid = acc.puuid; save();
      entries = await riot(host, `/lol/league/v4/entries/by-puuid/${u.puuid}`);
    }
    entries = entries || [];
    const solo = entries.find((x) => x.queueType === 'RANKED_SOLO_5x5');
    const flex = entries.find((x) => x.queueType === 'RANKED_FLEX_SR');
    const e = solo || flex;
    const val = e
      ? { at: Date.now(), rating: toRating(e), label: entryLabel(e) + (solo ? '' : ' (flex)') }
      : { at: Date.now(), rating: null, label: 'Unranked' };
    db.ranks[u.puuid] = val; save();
    return val;
  } catch (err) {
    console.error('rank fetch failed:', err.message);
    return c || none;
  }
}

// ── parsing ──────────────────────────────────────────────────────────────
// "name#TAG" or https://op.gg/lol/summoners/euw/skapligt%20snabb-SPEED
function parseRiotId(s) {
  s = s.trim();
  const m = s.match(/op\.gg\/(?:lol\/)?summoners\/([a-z]+)\/([^/?#]+)/i);
  if (m) {
    const full = decodeURIComponent(m[2]);
    const i = full.lastIndexOf('-');
    if (i < 1) return null;
    return { region: m[1].toLowerCase(), name: full.slice(0, i), tag: full.slice(i + 1) };
  }
  const i = s.lastIndexOf('#');
  if (i < 1 || i === s.length - 1) return null;
  return { name: s.slice(0, i).trim(), tag: s.slice(i + 1).trim() };
}

// "gold 2", "g2", "d3 45lp", "emerald iv", "master 120", "clear" -> rating | 'clear' | null
const TIER_ALIAS = {
  iron: 'IRON', bronze: 'BRONZE', brz: 'BRONZE', b: 'BRONZE', silver: 'SILVER', slv: 'SILVER', s: 'SILVER',
  gold: 'GOLD', gld: 'GOLD', g: 'GOLD', plat: 'PLATINUM', platinum: 'PLATINUM', pt: 'PLATINUM', p: 'PLATINUM',
  emerald: 'EMERALD', em: 'EMERALD', eme: 'EMERALD', e: 'EMERALD', diamond: 'DIAMOND', dia: 'DIAMOND', d: 'DIAMOND',
  master: 'MASTER', masters: 'MASTER', m: 'MASTER', gm: 'MASTER', grandmaster: 'MASTER', chall: 'MASTER', challenger: 'MASTER',
};
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4 };
function parseRank(s) {
  const toks = s.toLowerCase().match(/[a-z]+|\d+/g) || [];
  if (!toks.length) return null;
  if (['clear', 'none', 'reset'].includes(toks[0])) return 'clear';
  const tier = TIER_ALIAS[toks[0]];
  if (!tier) return null;
  const apex = APEX.has(tier);
  let div = null, lp = 0, lpSet = false;
  for (const t of toks.slice(1)) {
    if (t === 'lp') continue;
    if (/^\d+$/.test(t)) {
      const v = +t;
      if (!apex && div === null && v >= 1 && v <= 4) div = v;
      else if (!lpSet) { lp = v; lpSet = true; }
    } else if (ROMAN[t] && !apex && div === null) div = ROMAN[t];
    else return null;
  }
  if (apex) return 2800 + lp;
  return TIERS.indexOf(tier) * 400 + (4 - (div ?? 4)) * 100 + Math.min(lp, 99);
}

// ── balancing ────────────────────────────────────────────────────────────
// Duo partners form one unit that is never split. A duo only counts when both are present.
function toUnits(ps) {
  const by = new Map(ps.map((p) => [p.id, p]));
  const used = new Set(), units = [];
  for (const p of ps) {
    if (used.has(p.id)) continue;
    used.add(p.id);
    const mate = [p.duo, ...ps.filter((x) => x.duo === p.id).map((x) => x.id)]
      .map((id) => by.get(id)).find((x) => x && !used.has(x.id));
    if (mate) { used.add(mate.id); units.push([p, mate]); } else units.push([p]);
  }
  return units;
}
function enumerate(units, n, total) { // every way to give team A exactly n>>1 players, whole units only
  const k = n >> 1, out = [];
  for (let mask = 1; mask < 1 << units.length; mask++) {
    if (n % 2 === 0 && !(mask & 1)) continue; // skip mirrored duplicates: A holds the first unit
    const a = [];
    units.forEach((u, b) => { if (mask >> b & 1) a.push(...u); });
    if (a.length !== k) continue;
    const sa = a.reduce((s, p) => s + p.rating, 0);
    out.push({ a, key: a.map((p) => p.id).sort().join(','), diff: Math.abs(sa / k - (total - sa) / (n - k)) });
  }
  return out;
}
// Pick randomly among the splits within TOLERANCE of the best one (never `avoid` if another exists).
function pickSplit(ps, avoid) {
  const n = ps.length, total = ps.reduce((s, p) => s + p.rating, 0);
  let units = toUnits(ps), duoIgnored = false;
  let all = enumerate(units, n, total);
  if (!all.length) { // duos made an exact split impossible, so ignore them
    duoIgnored = units.some((u) => u.length > 1);
    all = enumerate(ps.map((p) => [p]), n, total);
  }
  all.sort((x, y) => x.diff - y.diff);
  const lim = all[0].diff + TOLERANCE;
  let pool = all.filter((x) => x.diff <= lim && x.key !== avoid);
  if (!pool.length) { const fresh = all.filter((x) => x.key !== avoid); pool = fresh.length ? [fresh[0]] : [all[0]]; }
  const pick = pool[(Math.random() * pool.length) | 0];
  return { A: pick.a, B: ps.filter((p) => !pick.a.includes(p)), key: pick.key, diff: pick.diff, duoIgnored };
}

// roles = [main, ...alsoOk]: main 0, also-ok 1, other 5, fill 1.5
const roleCost = (prefs, role) => (!prefs.length ? 1.5 : prefs[0] === role ? 0 : prefs.includes(role) ? 1 : 5);
const permCache = {};
function rolePerms(k) {
  if (permCache[k]) return permCache[k];
  const out = [], cur = [], used = new Set();
  (function rec() {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (const r of ROLES) { if (used.has(r)) continue; used.add(r); cur.push(r); rec(); cur.pop(); used.delete(r); }
  })();
  return (permCache[k] = out);
}
// lowest total cost; ties broken randomly. Returns team with .role, ordered top→support.
function assignRoles(team) {
  const t = team.slice().sort(() => Math.random() - 0.5);
  let best = [], cost = Infinity;
  for (const p of rolePerms(t.length)) {
    const c = t.reduce((sum, pl, i) => sum + roleCost(pl.roles, p[i]), 0);
    if (c < cost || (c === cost && Math.random() < 0.3)) { best = p; cost = c; }
  }
  return t.map((p, i) => ({ ...p, role: best[i] })).sort((x, y) => ROLES.indexOf(x.role) - ROLES.indexOf(y.role));
}

// everything the balancer and draft need to know about each player (rating = rank + in-house adjustment)
async function buildPlayers(ids) {
  const ps = [];
  for (const id of ids.slice().sort()) {
    const u = db.users[id];
    let base = DEFAULT_RATING, label = 'not linked*', icon = '⚠️', linked = false;
    if (u?.override != null) { base = u.override; label = `${ratingLabel(u.override)} (set)`; icon = rankIcon(base); linked = true; }
    else if (u?.puuid) {
      linked = true;
      const r = await getRank(u);
      if (r.rating != null) { base = r.rating; label = r.label; icon = rankIcon(base); } else { label = 'Unranked*'; icon = '❔'; }
    }
    ps.push({ id, rating: base + (u?.adj || 0), label, icon, linked, roles: u?.roles || [], duo: u?.duo });
  }
  return ps;
}
function compose(ps, A, B, key) {
  const teams = [assignRoles(A), assignRoles(B)];
  const avg = teams.map((t) => t.reduce((s, p) => s + p.rating, 0) / t.length);
  return {
    teams, avg, diff: Math.abs(avg[0] - avg[1]), key, duoIgnored: false,
    flagged: ps.some((p) => p.label.endsWith('*')),
    unlinked: ps.filter((p) => !p.linked).map((p) => p.id),
  };
}
function balance(ps, avoid) {
  let { A, B, key, duoIgnored } = pickSplit(ps, avoid);
  if (Math.random() < 0.5) [A, B] = [B, A]; // random side
  const res = compose(ps, A, B, key);
  res.duoIgnored = duoIgnored;
  return res;
}
const makeTeams = async (ids, avoid) => balance(await buildPlayers(ids), avoid);

// ── practice lobby: fake players so everything can be tested alone ───────
const testLobbies = new Map(); // user id -> lobby size (in memory; /lol without `test` leaves it)
const who = (p) => (p.name ? `**${p.name}**` : `<@${p.id}>`);
function fakePlayers(count, ownerId, withDuo) {
  return Array.from({ length: count }, (_, i) => {
    const rating = Math.round(300 + Math.random() * 2000); // roughly Iron to Diamond
    const main = ROLES[(Math.random() * ROLES.length) | 0];
    const alts = ROLES.filter((r) => r !== main && Math.random() < 0.4);
    const duo = withDuo && i === 0; // your duo setting makes "Test 1" your partner
    return {
      id: `test:${i + 1}`, name: `Test ${i + 1}${duo ? ' 🤝' : ''}`, // 🤝 = your duo partner rating, label: `${ratingLabel(rating)} (test)`, icon: rankIcon(rating), linked: true,
      roles: Math.random() < 0.2 ? [] : [main, ...alts], duo: duo ? ownerId : undefined,
    };
  });
}

// ── captain draft: two highest-rated players captain, the lower-rated one picks first, snake order ──
const pickTeam = (j) => ((j + 1) >> 1) % 2; // pick j goes to team 0,1,1,0,0,1,1,0…
function startDraft(ps, names) {
  const sorted = ps.slice().sort(() => Math.random() - 0.5).sort((a, b) => b.rating - a.rating); // random tiebreak
  return { all: ps, names, pool: sorted.slice(2), teams: [[sorted[1]], [sorted[0]]], j: 0 };
}
const draftCaptain = (d) => d.teams[pickTeam(d.j)][0];
function draftPick(d, id) {
  const idx = d.pool.findIndex((p) => p.id === id);
  if (idx < 0) return false;
  d.teams[pickTeam(d.j)].push(d.pool.splice(idx, 1)[0]); d.j++;
  if (d.pool.length === 1) { d.teams[pickTeam(d.j)].push(d.pool.pop()); d.j++; } // last player is forced
  return true;
}

// ── results: Elo-style in-house adjustment on top of rank ────────────────
function applyResult(res, winner, dry = false) { // dry = practice lobby: compute the report, store nothing
  const E = 1 / (1 + 10 ** ((res.avg[1 - winner] - res.avg[winner]) / 400)); // winner's expected score
  const d = Math.max(1, Math.round(ELO_K * (1 - E)));
  const report = { winner, d, dry, deltas: {}, won: res.teams[winner].map((p) => p.id), lost: res.teams[1 - winner].map((p) => p.id) };
  const bump = (id, won) => {
    if (dry) { report.deltas[id] = won ? d : -d; return; }
    const u = (db.users[id] ||= {}), before = u.adj || 0;
    u.adj = Math.max(-ADJ_MAX, Math.min(ADJ_MAX, before + (won ? d : -d)));
    u[won ? 'w' : 'l'] = (u[won ? 'w' : 'l'] || 0) + 1;
    report.deltas[id] = u.adj - before;
  };
  report.won.forEach((id) => bump(id, true));
  report.lost.forEach((id) => bump(id, false));
  if (!dry) save();
  return report;
}
function undoResult(report) {
  if (report.dry) return;
  for (const id of [...report.won, ...report.lost]) {
    const u = db.users[id];
    if (!u) continue;
    u.adj = (u.adj || 0) - report.deltas[id];
    const k = report.won.includes(id) ? 'w' : 'l';
    u[k] = Math.max(0, (u[k] || 0) - 1);
  }
  save();
}

// ── team voice channels: env IDs, else channels named "...blue..." / "...red..." ──
function teamVcs(guild) {
  const find = (id, re) => (id ? guild.channels.cache.get(id) : guild.channels.cache.find((c) => c.isVoiceBased() && re.test(c.name)));
  const a = find(TEAM1_VC, /\bblue\b/i), b = find(TEAM2_VC, /\bred\b/i);
  return a && b ? [a.id, b.id] : null;
}

// ── rendering: public teams message ──────────────────────────────────────
const btn = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const rowOf = (...c) => new ActionRowBuilder().addComponents(...c);

// Layout: a slim header (title, balance, warnings) + one colour-coded card per team with a Role | Player | Rank table.
const ROLE_ICON = { top: '🛡️', jungle: '🌲', mid: '🔮', bot: '🏹', support: '🩹' };
const TIER_ICON = ['⚫', '🟤', '⚪', '🟡', '🔷', '🟢', '💎']; // iron … diamond
const rankIcon = (r) => (r >= 2800 ? '🟣' : TIER_ICON[Math.min(6, Math.floor(Math.max(0, r) / 400))]);
const BLUE = 0x3b82f6, RED = 0xef4444, BLURPLE = 0x5865f2;

function balanceLine(res) {
  const d = res.diff.toFixed(0), edge = res.avg[0] > res.avg[1] ? '🔵' : '🔴';
  return res.diff <= 30 ? `⚖️ **Even match** · Δ ${d} avg pts`
    : res.diff <= 100 ? `⚖️ **Close** · slight edge to ${edge} · Δ ${d} avg pts`
    : `⚖️ **Uneven** · ${edge} favoured · Δ ${d} avg pts`;
}

function teamEmbed(s, n) {
  const { res, report: rep } = s, t = res.teams[n];
  return new EmbedBuilder().setColor(n ? RED : BLUE)
    .setTitle(`${rep?.winner === n ? '🏆' : n ? '🔴' : '🔵'} ${n ? 'Red' : 'Blue'} Team · ${ratingLabel(res.avg[n])} avg`)
    .addFields(
      { name: 'Role', value: t.map((p) => `${ROLE_ICON[p.role]} **${cap(p.role)}**`).join('\n'), inline: true },
      { name: 'Player', value: t.map((p) => who(p)).join('\n'), inline: true },
      { name: 'Rank', value: t.map((p) => `${p.icon} ${p.label}`).join('\n'), inline: true });
}

function renderTeams(s, canMove) {
  const { res, report: rep } = s;
  const lines = [rep ? `🏆 **${rep.winner ? 'Red' : 'Blue'} won** · in-house rating: winners ${signed(rep.d)}, losers ${signed(-rep.d)}` : balanceLine(res)];
  if (res.unlinked.length) {
    const mentions = res.unlinked.map((id) => `<@${id}>`).join(' ');
    lines.push(`⚠️ ${mentions} ${res.unlinked.length > 1 ? "haven't" : "hasn't"} linked an account. Use /lol to link.`);
  }
  if (res.duoIgnored) lines.push('⚠️ Duo partners couldn\'t be kept together with this player count.');
  const head = new EmbedBuilder().setColor(BLURPLE).setDescription(lines.join('\n'))
    .setTitle((s.test ? '🧪 ' : '') + (rep ? `Teams · ${rep.winner ? '🔴 Red' : '🔵 Blue'} won` : s.drafted ? 'Teams · captain draft' : 'Teams'));
  const embeds = [head, teamEmbed(s, 0), teamEmbed(s, 1)];
  const foot = [res.flagged && `* counted as ${ratingLabel(DEFAULT_RATING)}`, s.test && 'practice lobby, not saved'].filter(Boolean);
  if (foot.length) embeds[2].setFooter({ text: foot.join(' · ') });

  if (rep) return { embeds, components: [rowOf(btn('undo', 'Undo result', ButtonStyle.Secondary))] };
  const top = s.moved ? rowOf(btn('back', 'Move everyone back', ButtonStyle.Primary))
    : rowOf(btn('reroll', 'Reroll', ButtonStyle.Primary), btn('draft', 'Captain draft', ButtonStyle.Secondary),
      ...(canMove ? [btn('move', 'Move to team channels', ButtonStyle.Secondary)] : []));
  return { embeds, components: [top, rowOf(btn('win0', '🔵 Blue won', ButtonStyle.Secondary), btn('win1', '🔴 Red won', ButtonStyle.Secondary))] };
}

function renderDraft(s) {
  const d = s.draft, c = draftCaptain(d), turn = pickTeam(d.j);
  const head = new EmbedBuilder().setColor(turn ? RED : BLUE).setTitle(`${s.test ? '🧪 ' : ''}Captain draft`)
    .setDescription(`${turn ? '🔴' : '🔵'} ${who(c)} **picks next** · ${d.pool.length} player${d.pool.length === 1 ? '' : 's'} left`);
  const card = (n) => new EmbedBuilder().setColor(n ? RED : BLUE).setTitle(`${n ? '🔴 Red' : '🔵 Blue'} Team`)
    .addFields(
      { name: 'Player', value: d.teams[n].map((p, i) => `${i ? '▫️' : '👑'} ${who(p)}`).join('\n'), inline: true },
      { name: 'Rank', value: d.teams[n].map((p) => `${p.icon} ${p.label}`).join('\n'), inline: true });
  const menu = new StringSelectMenuBuilder().setCustomId('pick').setPlaceholder(`${turn ? '🔴' : '🔵'} Pick a player`)
    .addOptions(d.pool.map((p) => new StringSelectMenuOptionBuilder()
      .setLabel((d.names[p.id] || p.id).slice(0, 100)).setDescription(p.label.replace('*', '')).setValue(p.id).setEmoji(p.icon)));
  return { embeds: [head, card(0), card(1)], components: [rowOf(menu), rowOf(btn('cancel', 'Cancel draft', ButtonStyle.Secondary))] };
}

// ── rendering: leaderboard + personal panel ──────────────────────────────
function boardEmbed() {
  const rows = Object.entries(db.users).map(([id, u]) => {
    const base = u.override ?? (u.puuid ? db.ranks[u.puuid]?.rating : null) ?? DEFAULT_RATING;
    return { id, w: u.w || 0, l: u.l || 0, adj: u.adj || 0, base, rating: base + (u.adj || 0) };
  }).filter((r) => r.w + r.l > 0).sort((a, b) => b.rating - a.rating || b.w - a.w).slice(0, 10);
  const medal = ['🥇', '🥈', '🥉'];
  return new EmbedBuilder().setColor(0xf1c40f).setTitle('🏆 In-house leaderboard')
    .setDescription(rows.length
      ? rows.map((r, i) => `${medal[i] ?? `**${i + 1}.**`} <@${r.id}> · ${rankIcon(r.base)} ${ratingLabel(r.rating)} (${signed(r.adj)}) · **${r.w}**W **${r.l}**L`).join('\n')
      : 'No results yet. Press 🔵 Blue won or 🔴 Red won on a teams message after a game.')
    .setFooter({ text: 'Rating = Riot rank + in-house adjustment' });
}

function panel(tid, notice) {
  const u = db.users[tid] || {};
  const rk = u.puuid ? db.ranks[u.puuid] : null;
  const roles = u.roles;
  const main = roles?.[0];
  const linked = !!u.puuid;

  const accountLine = linked
    ? `[**${u.name}#${u.tag}**](https://op.gg/lol/summoners/${u.region}/${encodeURIComponent(u.name)}-${encodeURIComponent(u.tag)})\n${u.region.toUpperCase()}`
    : 'Not linked';
  const record = u.w || u.l ? `\nIn-house ${u.w || 0}W ${u.l || 0}L (${signed(u.adj || 0)})` : '';
  const rankLine = (u.override != null ? `${ratingLabel(u.override)} (manual)`
    : rk ? `${rk.label}\n<t:${Math.floor(rk.at / 1000)}:R>` : '—') + record;
  const roleLine = !roles ? 'Not set (fill)' : !roles.length ? 'Fill'
    : cap(main) + (roles.length > 1 ? `\nalso ${roles.slice(1).map(cap).join(', ')}` : '');
  const testN = testLobbies.get(tid);
  const hint = testN ? 'Press Make teams. No voice channel needed.'
    : !linked && u.override == null ? 'Start with Link account.'
    : !roles ? 'Pick your main role so teams can place you.'
    : 'Join a voice channel, then press Make teams.';
  const testLine = testN && `🧪 Practice lobby: you + ${testN - 1} fake players. Results aren't saved. Run /lol again to leave.`;

  const e = new EmbedBuilder().setTitle('LoL profile').setColor(0x5865f2)
    .setDescription([`<@${tid}>`, testLine, notice].filter(Boolean).join('\n\n'))
    .addFields(
      { name: 'Account', value: accountLine, inline: true },
      { name: 'Rank', value: rankLine, inline: true },
      { name: 'Roles', value: roleLine, inline: true })
    .setFooter({ text: hint });

  // actions first (state-aware emphasis), pickers below
  const link = btn(`lol:link:${tid}`, linked ? 'Change account' : 'Link account', linked ? ButtonStyle.Secondary : ButtonStyle.Primary);
  const rank = btn(`lol:rank:${tid}`, 'Set rank', ButtonStyle.Secondary);
  const teams = btn(`lol:teams:${tid}`, 'Make teams', linked ? ButtonStyle.Success : ButtonStyle.Secondary);
  const unlink = btn(`lol:unlink:${tid}`, 'Unlink', ButtonStyle.Danger);
  const board = btn(`lol:board:${tid}`, 'Leaderboard', ButtonStyle.Secondary);
  const rows = [rowOf(...(linked ? [teams, link, rank, unlink, board] : [link, rank, teams, board]))];

  rows.push(rowOf(
    new StringSelectMenuBuilder().setCustomId(`lol:main:${tid}`).setPlaceholder('Main role')
      .addOptions([...ROLES, 'fill'].map((r) => new StringSelectMenuOptionBuilder()
        .setLabel(r === 'fill' ? 'Fill (any role)' : cap(r)).setValue(r)
        .setDefault(roles ? (r === 'fill' ? !roles.length : r === main) : false)))));
  if (main) {
    const opts = ROLES.filter((r) => r !== main);
    rows.push(rowOf(
      new StringSelectMenuBuilder().setCustomId(`lol:alt:${tid}`).setPlaceholder('Also OK with…')
        .setMinValues(0).setMaxValues(opts.length)
        .addOptions(opts.map((r) => new StringSelectMenuOptionBuilder()
          .setLabel(cap(r)).setValue(r).setDefault(roles.includes(r))))));
  }
  const duo = new UserSelectMenuBuilder().setCustomId(`lol:duo:${tid}`).setPlaceholder('Duo partner (optional)')
    .setMinValues(0).setMaxValues(1);
  if (u.duo) duo.setDefaultUsers(u.duo);
  rows.push(rowOf(duo));
  return { embeds: [e], components: rows };
}

function linkModal(tid) {
  const u = db.users[tid];
  const id = new TextInputBuilder().setCustomId('riot_id').setLabel('Riot ID or op.gg link')
    .setStyle(TextInputStyle.Short).setPlaceholder('Name#TAG, or paste your op.gg link').setRequired(true);
  if (u?.puuid) id.setValue(`${u.name}#${u.tag}`);
  return new ModalBuilder().setCustomId(`lol:linkm:${tid}`).setTitle('Link Riot account')
    .addComponents(new ActionRowBuilder().addComponents(id));
}
function rankModal(tid) {
  const rk = new TextInputBuilder().setCustomId('rank').setLabel('Manual rank (or "clear")')
    .setStyle(TextInputStyle.Short).setPlaceholder('gold 2 · d3 · emerald 1 45 · master 120 · clear').setRequired(true);
  return new ModalBuilder().setCustomId(`lol:rankm:${tid}`).setTitle('Set rank (unranked / smurf)')
    .addComponents(new ActionRowBuilder().addComponents(rk));
}

// ── handlers ─────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('lol').setDescription('Your LoL profile and team maker')
    .addUserOption((o) => o.setName('user').setDescription('Edit someone else (needs Manage Server)'))
    .addIntegerOption((o) => o.setName('test').setDescription('Practice lobby with fake players, no voice channel needed (needs Manage Server)')
      .setMinValue(2).setMaxValue(10)),
];
const isAdmin = (i) => !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
const canEdit = (i, tid) => i.user.id === tid || isAdmin(i);
const humans = (vc) => [...vc.members.values()].filter((m) => !m.user.bot).map((m) => m.id);
const riotErr = (e) => (e.status === 403 ? 'Riot API key is invalid or expired.' : `Riot error: ${e.message}`);
const NOPE = { content: 'You need Manage Server to edit someone else.', flags: EPH };
const sessions = new Map(); // public teams message id -> { vcId, res, moved, drafted, draft, report, t }

async function onCommand(i) {
  const tid = i.options.getUser('user')?.id ?? i.user.id;
  if (!canEdit(i, tid)) return i.reply(NOPE);
  const n = i.options.getInteger('test');
  if (n && !isAdmin(i)) return i.reply({ content: 'Practice lobbies need Manage Server.', flags: EPH });
  if (n) testLobbies.set(i.user.id, n); else testLobbies.delete(i.user.id); // plain /lol leaves the practice lobby
  await i.deferReply({ flags: EPH });
  const u = db.users[tid]; // keep your own rank current when you open the panel
  if (u?.puuid && Date.now() - (db.ranks[u.puuid]?.at || 0) > FRESH) await getRank(u, true);
  return i.editReply(panel(tid));
}

async function onPanel(i) { // buttons + selects on the ephemeral panel
  const [, act, tid] = i.customId.split(':');
  if (!canEdit(i, tid)) return i.reply(NOPE);

  if (act === 'main') {
    const v = i.values[0];
    const rec = (db.users[tid] ||= {});
    rec.roles = v === 'fill' ? [] : [v, ...(rec.roles || []).slice(1).filter((r) => r !== v)];
    save();
    return i.update(panel(tid));
  }
  if (act === 'alt') {
    const rec = (db.users[tid] ||= {});
    if (rec.roles?.[0]) { rec.roles = [rec.roles[0], ...i.values]; save(); }
    return i.update(panel(tid));
  }
  if (act === 'duo') {
    const v = i.values[0]; // undefined when cleared
    if (v && (v === tid || i.users?.get(v)?.bot)) return i.update(panel(tid, '⚠ Pick someone else.'));
    const rec = (db.users[tid] ||= {});
    if (v) rec.duo = v; else delete rec.duo;
    save();
    return i.update(panel(tid, v ? `✅ You'll be on the same team as <@${v}> when you're both in the channel.` : '✅ Duo cleared.'));
  }
  if (act === 'board') return i.reply({ embeds: [boardEmbed()], flags: EPH });
  if (act === 'link') return i.showModal(linkModal(tid));
  if (act === 'rank') return i.showModal(rankModal(tid));
  if (act === 'unlink') {
    const u = db.users[tid];
    if (u) { delete u.puuid; delete u.region; delete u.name; delete u.tag; save(); }
    return i.update(panel(tid, '✅ Account unlinked.'));
  }

  if (act === 'teams') {
    const testN = tid === i.user.id ? testLobbies.get(tid) : undefined;
    if (testN) return startTest(i, tid, testN);
    const vc = i.member?.voice?.channel;
    if (!vc) return i.update(panel(tid, '⚠ Join a voice channel first.'));
    const ids = humans(vc);
    if (ids.length < 2) return i.update(panel(tid, '⚠ Need at least 2 people in the channel.'));
    if (ids.length > 10) return i.update(panel(tid, '⚠ Max 10 players.'));
    await i.deferUpdate();
    return postTeams(i, tid, { vcId: vc.id, res: await makeTeams(ids), moved: false, t: Date.now() }, 'Teams');
  }
}

async function postTeams(i, tid, s, label) {
  try {
    const ch = i.channel ?? (await i.guild.channels.fetch(i.channelId));
    const msg = await ch.send(renderTeams(s, !s.test && !!teamVcs(i.guild)));
    sessions.set(msg.id, s);
    return i.editReply(panel(tid, `✅ [${label} posted](${msg.url}).`));
  } catch (e) {
    console.error(e);
    return i.editReply(panel(tid, '⚠ Couldn\'t post in this channel. The bot needs Send Messages and Embed Links here.'));
  }
}

async function startTest(i, tid, n) { // you + fake players; no voice channel, nothing saved, only you can press its buttons
  await i.deferUpdate();
  const [me] = await buildPlayers([tid]);
  const ps = [me, ...fakePlayers(n - 1, tid, !!me.duo)];
  const names = Object.fromEntries(ps.map((p) => [p.id, p.name || i.member?.displayName || i.user.username]));
  return postTeams(i, tid, { test: true, owner: tid, ps, names, res: balance(ps), moved: false, t: Date.now() }, 'Test teams');
}

async function onModal(i) {
  const [, act, tid] = i.customId.split(':');
  if (!canEdit(i, tid)) return i.reply(NOPE);
  await i.deferUpdate();
  let notice;
  try {
    if (act === 'linkm') {
      const p = parseRiotId(i.fields.getTextInputValue('riot_id'));
      const region = p?.region || DEFAULT_REGION;
      if (!p) notice = '⚠ Use `Name#TAG`, or paste your op.gg link.';
      else if (!REGIONS[region]) notice = `⚠ Unknown region \`${region}\`.`;
      else {
        const acc = await accountByRiotId(region, p.name, p.tag);
        const dupe = acc && Object.entries(db.users).find(([id, x]) => x.puuid === acc.puuid && id !== tid);
        if (!acc) notice = `⚠ Riot ID not found on ${region.toUpperCase()}.` + (p.region ? '' : ' Playing elsewhere? Paste your op.gg link.');
        else if (dupe) notice = `⚠ That account is already linked to <@${dupe[0]}>.`;
        else {
          // account lookup works for every region, so check the player really exists on this one (404 = no); other errors don't block
          const here = await riot(REGIONS[region][0], `/lol/summoner/v4/summoners/by-puuid/${acc.puuid}`).catch(() => ({}));
          if (here === null) {
            notice = `⚠ ${acc.gameName}#${acc.tagLine} has no League account on ${region.toUpperCase()}.` + (p.region ? '' : ' Playing elsewhere? Paste your op.gg link.');
          } else {
            const u = (db.users[tid] = { ...(db.users[tid] || {}), puuid: acc.puuid, region, name: acc.gameName, tag: acc.tagLine });
            save();
            const r = await getRank(u, true);
            notice = `✅ Linked **${acc.gameName}#${acc.tagLine}** · ${r.label}`;
          }
        }
      }
    } else if (act === 'rankm') {
      const r = parseRank(i.fields.getTextInputValue('rank'));
      const u = (db.users[tid] ||= {});
      if (r === null) notice = '⚠ Couldn\'t read that. Try `gold 2`, `d3`, `master 120` or `clear`.';
      else if (r === 'clear') { delete u.override; save(); notice = '✅ Manual rank cleared.'; }
      else { u.override = r; save(); notice = `✅ Counted as ${ratingLabel(r)}.`; }
    }
  } catch (e) {
    console.error(e);
    notice = `⚠ ${riotErr(e)}`;
  }
  return i.editReply(panel(tid, notice));
}

async function onTeamButton(i) { // buttons + the draft menu on the public teams message
  const s = sessions.get(i.message.id);
  if (!s) return i.reply({ content: 'Expired. Run /lol and press Make teams again.', flags: EPH });
  s.t = Date.now();
  if (s.test && i.user.id !== s.owner) return i.reply({ content: 'This is someone else\'s practice lobby.', flags: EPH });
  const id = i.customId, vcs = teamVcs(i.guild), canMove = !s.test && !!vcs;
  const mayReport = s.res.teams.flat().some((p) => p.id === i.user.id) || isAdmin(i);
  const noReport = { content: 'Only players in this match (or Manage Server) can do that.', flags: EPH };

  if (id === 'win0' || id === 'win1') { // players may report after leaving voice
    if (!mayReport) return i.reply(noReport);
    if (s.report) return i.reply({ content: 'Result already reported.', flags: EPH });
    if (s.draft) return i.reply({ content: 'Finish or cancel the draft first.', flags: EPH });
    s.report = applyResult(s.res, id === 'win1' ? 1 : 0, !!s.test);
    return i.update(renderTeams(s, canMove));
  }
  if (id === 'undo') {
    if (!mayReport) return i.reply(noReport);
    if (!s.report) return i.reply({ content: 'Nothing to undo.', flags: EPH });
    undoResult(s.report); s.report = null;
    return i.update(renderTeams(s, canMove));
  }
  if (id === 'pick') {
    const d = s.draft;
    if (!d) return i.reply({ content: 'No draft running.', flags: EPH });
    const c = draftCaptain(d);
    if (!s.test && i.user.id !== c.id) return i.reply({ content: `Waiting for ${who(c)} to pick.`, flags: EPH }); // practice: you pick for everyone
    if (!draftPick(d, i.values[0])) return i.reply({ content: 'That player was already picked.', flags: EPH });
    if (d.pool.length) return i.update(renderDraft(s));
    s.res = compose(d.all, d.teams[0], d.teams[1], ''); s.drafted = true; s.draft = null;
    return i.update(renderTeams(s, canMove));
  }

  // everything below needs you to be in the lobby (or a team channel)
  if (!s.test && ![s.vcId, ...(vcs || [])].includes(i.member?.voice?.channelId))
    return i.reply({ content: 'Join the voice channel to use this.', flags: EPH });

  if (id === 'reroll') {
    await i.deferUpdate();
    if (s.test) s.res = balance(s.ps, s.res.key);
    else {
      const vc = i.guild.channels.cache.get(s.vcId);
      const ids = vc ? humans(vc) : s.res.teams.flat().map((p) => p.id);
      if (ids.length < 2) return i.followUp({ content: 'Not enough people in the channel.', flags: EPH });
      s.res = await makeTeams(ids, s.res.key);
    }
    s.drafted = false; s.draft = null;
    return i.editReply(renderTeams(s, canMove));
  }

  if (id === 'draft') {
    const vc = s.test ? null : i.guild.channels.cache.get(s.vcId);
    const ids = s.test ? s.ps.map((p) => p.id) : vc ? humans(vc) : [];
    if (ids.length < 4) return i.reply({ content: 'Need at least 4 players in the channel for a captain draft.', flags: EPH });
    if (ids.length > 10) return i.reply({ content: 'Max 10 players.', flags: EPH });
    await i.deferUpdate();
    if (s.test) s.draft = startDraft(s.ps, s.names);
    else s.draft = startDraft(await buildPlayers(ids), Object.fromEntries(ids.map((x) => [x, vc.members.get(x)?.displayName || x])));
    return i.editReply(renderDraft(s));
  }
  if (id === 'cancel') {
    s.draft = null;
    return i.update(renderTeams(s, canMove));
  }

  if (id === 'move' || id === 'back') {
    const back = id === 'back';
    if (!vcs) return i.reply({ content: 'Team voice channels not found.', flags: EPH });
    await i.deferReply({ flags: EPH });
    let n = 0, failed = 0;
    for (const [side, team] of s.res.teams.entries()) {
      for (const p of team) {
        const m = await i.guild.members.fetch(p.id).catch(() => null);
        if (!m?.voice.channelId) { failed++; continue; }
        try { await m.voice.setChannel(back ? s.vcId : vcs[side]); n++; } catch { failed++; }
      }
    }
    if (n) { s.moved = !back; await i.message.edit(renderTeams(s, true)); }
    return i.editReply(`Moved ${n}` + (failed ? `, ${failed} failed (not in voice / missing Move Members).` : '.'));
  }
}

// ── dispatch ─────────────────────────────────────────────────────────────
async function handle(i) {
  const age = Date.now() - i.createdTimestamp; // ms since the click; Discord allows 3000 for the first reply
  try {
    if (i.isChatInputCommand()) await onCommand(i);
    else if (i.isModalSubmit()) await onModal(i);
    else if (i.isMessageComponent()) await (i.customId.startsWith('lol:') ? onPanel(i) : onTeamButton(i));
  } catch (e) {
    if (e.code === 10062) { // reply window missed, or another running copy of the bot answered first
      console.warn(`Unknown interaction (age ${age}ms when received, gateway ping ${i.client?.ws?.ping}ms). ` +
        (age > 2000 ? 'Event arrived late: slow host or clock skew.' : 'Arrived in time: another copy of the bot is probably running.'));
      return;
    }
    console.error(e);
    const content = `Error: ${riotErr(e)}`;
    const send = i.deferred || i.replied ? i.followUp({ content, flags: EPH }) : i.reply({ content, flags: EPH });
    send.catch(() => {});
  }
}

// ── start ────────────────────────────────────────────────────────────────
function start() {
  if (!DISCORD_TOKEN || !RIOT_KEY) { console.error('Set DISCORD_TOKEN and RIOT_KEY'); process.exit(1); }
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    allowedMentions: { parse: [] }, // mentions render but never ping
  });

  client.once(Events.ClientReady, async () => {
    const body = commands.map((c) => c.toJSON());
    const g = GUILD_ID ? await client.guilds.fetch(GUILD_ID) : null; // guild commands update instantly
    await (g ? g.commands : client.application.commands).set(body);
    console.log(`Ready as ${client.user.tag}`);
  });

  client.on(Events.InteractionCreate, handle);

  setInterval(() => { for (const [id, s] of sessions) if (Date.now() - s.t > SESSION_TTL) sessions.delete(id); }, 600e3);
  client.login(DISCORD_TOKEN);
}

if (require.main === module) start();
module.exports = {
  parseRiotId, parseRank, ratingLabel, toRating, pickSplit, toUnits, assignRoles, makeTeams, buildPlayers, compose,
  startDraft, draftPick, draftCaptain, pickTeam, applyResult, undoResult, boardEmbed, getRank, balance, fakePlayers, testLobbies,
  teamVcs, panel, renderTeams, renderDraft, linkModal, rankModal, handle, db, sessions,
};
