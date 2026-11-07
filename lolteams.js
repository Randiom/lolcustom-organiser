#!/usr/bin/env node
// lolteams.js — Discord bot: link Riot accounts, split a voice channel into two rank-balanced teams.
// One slash command (/lol) opens a personal (ephemeral) panel: link account, roles, rank override, make teams.
// Setup: npm i discord.js   (Node 18+)
// Run:   DISCORD_TOKEN=... RIOT_KEY=... [GUILD_ID=...]  (or put them in a .env file) [DEFAULT_REGION=euw] [TEAM1_VC=...] [TEAM2_VC=...] node lolteams.js
// Bot invite scopes: bot + applications.commands. Permissions: View Channel, Send Messages, Move Members.
// "Move to team channels" works out of the box if the server has voice channels with "blue" and "red" in their names
// (or set TEAM1_VC / TEAM2_VC channel IDs).
'use strict';
try { process.loadEnvFile(); } catch {} // optional .env file (Node 20.12+)
const fs = require('fs');
const {
  Client, Events, GatewayIntentBits, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, PermissionFlagsBits, SlashCommandBuilder,
} = require('discord.js');

// ── config ───────────────────────────────────────────────────────────────
const { DISCORD_TOKEN, RIOT_KEY, GUILD_ID, TEAM1_VC, TEAM2_VC } = process.env;
const DB_FILE = process.env.DB_FILE || 'data.json';
const RANK_TTL = (+process.env.RANK_TTL_HOURS || 24) * 3600e3; // rank cache lifetime (teams use this)
const FRESH = 30 * 60e3;                                       // opening /lol refreshes your own rank if older than this
const DEFAULT_RATING = +process.env.DEFAULT_RATING || 1000;    // unranked / unlinked (= Silver II)
const TOLERANCE = +process.env.TOLERANCE || 20;                // avg-rating slack for random split choice
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

// ── storage (one JSON file, atomic write) ────────────────────────────────
// users[discordId] = { puuid, region, name, tag, override?, roles? }   ranks[puuid] = { at, rating, label }
// roles = [main, ...alsoOk]; [] = fill; undefined = never set
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
// Brute-force every split, pick randomly among those within TOLERANCE of the best (never `avoid` if possible).
function pickSplit(ps, avoid) {
  const n = ps.length, k = n >> 1;
  const total = ps.reduce((sum, p) => sum + p.rating, 0);
  const all = [], idx = [];
  (function rec(from) {
    if (idx.length === k) {
      if (n % 2 === 0 && idx[0] !== 0) return; // skip mirrored duplicates
      const sa = idx.reduce((sum, i) => sum + ps[i].rating, 0);
      all.push({ a: idx.slice(), diff: Math.abs(sa / k - (total - sa) / (n - k)) });
      return;
    }
    for (let i = from; i < n; i++) { idx.push(i); rec(i + 1); idx.pop(); }
  })(0);
  for (const x of all) x.key = x.a.map((i) => ps[i].id).join(',');
  all.sort((x, y) => x.diff - y.diff);
  const lim = all[0].diff + TOLERANCE;
  let pool = all.filter((x) => x.diff <= lim && x.key !== avoid);
  if (!pool.length) { const fresh = all.filter((x) => x.key !== avoid); pool = fresh.length ? [fresh[0]] : [all[0]]; }
  const pick = pool[(Math.random() * pool.length) | 0];
  return { A: pick.a.map((i) => ps[i]), B: ps.filter((_, i) => !pick.a.includes(i)), key: pick.key, diff: pick.diff };
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

async function makeTeams(ids, avoid) {
  ids = ids.slice().sort();
  const ps = [];
  for (const id of ids) {
    const u = db.users[id];
    let rating = DEFAULT_RATING, label = '⚠ not linked*', linked = false;
    if (u?.override != null) { rating = u.override; label = `${ratingLabel(u.override)} (set)`; linked = true; }
    else if (u?.puuid) {
      linked = true;
      const r = await getRank(u);
      if (r.rating != null) { rating = r.rating; label = r.label; } else label = 'Unranked*';
    }
    ps.push({ id, rating, label, linked, roles: u?.roles || [] });
  }
  let { A, B, key, diff } = pickSplit(ps, avoid);
  if (Math.random() < 0.5) [A, B] = [B, A]; // random side
  const teams = [assignRoles(A), assignRoles(B)];
  const avg = teams.map((t) => t.reduce((s, p) => s + p.rating, 0) / t.length);
  return {
    teams, avg, diff, key,
    flagged: ps.some((p) => p.label.endsWith('*')),
    unlinked: ps.filter((p) => !p.linked).map((p) => p.id),
  };
}

// ── team voice channels: env IDs, else channels named "...blue..." / "...red..." ──
function teamVcs(guild) {
  const find = (id, re) => (id ? guild.channels.cache.get(id) : guild.channels.cache.find((c) => c.isVoiceBased() && re.test(c.name)));
  const a = find(TEAM1_VC, /\bblue\b/i), b = find(TEAM2_VC, /\bred\b/i);
  return a && b ? [a.id, b.id] : null;
}

// ── rendering: public teams message ──────────────────────────────────────
const btn = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

function renderTeams(res, canMove, moved) {
  const e = new EmbedBuilder().setTitle('Teams').setColor(0x5865f2);
  if (res.unlinked.length) {
    const who = res.unlinked.map((id) => `<@${id}>`).join(' ');
    e.setDescription(`⚠ ${who} ${res.unlinked.length > 1 ? "haven't" : "hasn't"} linked an account. Use /lol to link.`);
  }
  ['🔵 Blue', '🔴 Red'].forEach((name, n) =>
    e.addFields({
      name: `${name} · avg ${ratingLabel(res.avg[n])}`,
      value: res.teams[n].map((p) => `**${cap(p.role)}** <@${p.id}> · ${p.label}`).join('\n'),
    }));
  e.setFooter({ text: `Δ ${res.diff.toFixed(0)} avg pts` + (res.flagged ? ` · * counted as ${ratingLabel(DEFAULT_RATING)}` : '') });
  const row = new ActionRowBuilder();
  if (moved) row.addComponents(btn('back', 'Move everyone back', ButtonStyle.Primary));
  else {
    row.addComponents(btn('reroll', 'Reroll', ButtonStyle.Primary));
    if (canMove) row.addComponents(btn('move', 'Move to team channels', ButtonStyle.Secondary));
  }
  return { embeds: [e], components: [row] };
}

// ── rendering: personal panel (ephemeral) ────────────────────────────────
function panel(tid, notice) {
  const u = db.users[tid] || {};
  const rk = u.puuid ? db.ranks[u.puuid] : null;
  const roles = u.roles;
  const main = roles?.[0];
  const linked = !!u.puuid;

  const accountLine = linked
    ? `[**${u.name}#${u.tag}**](https://op.gg/lol/summoners/${u.region}/${encodeURIComponent(u.name)}-${encodeURIComponent(u.tag)})\n${u.region.toUpperCase()}`
    : 'Not linked';
  const rankLine = u.override != null ? `${ratingLabel(u.override)} (manual)`
    : rk ? `${rk.label}\n<t:${Math.floor(rk.at / 1000)}:R>` : '—';
  const roleLine = !roles ? 'Not set (fill)' : !roles.length ? 'Fill'
    : cap(main) + (roles.length > 1 ? `\nalso ${roles.slice(1).map(cap).join(', ')}` : '');
  const hint = !linked && u.override == null ? 'Start with Link account.'
    : !roles ? 'Pick your main role so teams can place you.'
    : 'Join a voice channel, then press Make teams.';

  const e = new EmbedBuilder().setTitle('LoL profile').setColor(0x5865f2)
    .setDescription([`<@${tid}>`, notice].filter(Boolean).join('\n\n'))
    .addFields(
      { name: 'Account', value: accountLine, inline: true },
      { name: 'Rank', value: rankLine, inline: true },
      { name: 'Roles', value: roleLine, inline: true })
    .setFooter({ text: hint });

  // actions first (state-aware emphasis), role pickers below
  const link = btn(`lol:link:${tid}`, linked ? 'Change account' : 'Link account', linked ? ButtonStyle.Secondary : ButtonStyle.Primary);
  const rank = btn(`lol:rank:${tid}`, 'Set rank', ButtonStyle.Secondary);
  const teams = btn(`lol:teams:${tid}`, 'Make teams', linked ? ButtonStyle.Success : ButtonStyle.Secondary);
  const unlink = btn(`lol:unlink:${tid}`, 'Unlink', ButtonStyle.Danger);
  const rows = [new ActionRowBuilder().addComponents(...(linked ? [teams, link, rank, unlink] : [link, rank, teams]))];

  rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`lol:main:${tid}`).setPlaceholder('Main role')
      .addOptions([...ROLES, 'fill'].map((r) => new StringSelectMenuOptionBuilder()
        .setLabel(r === 'fill' ? 'Fill (any role)' : cap(r)).setValue(r)
        .setDefault(roles ? (r === 'fill' ? !roles.length : r === main) : false)))));
  if (main) {
    const opts = ROLES.filter((r) => r !== main);
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`lol:alt:${tid}`).setPlaceholder('Also OK with…')
        .setMinValues(0).setMaxValues(opts.length)
        .addOptions(opts.map((r) => new StringSelectMenuOptionBuilder()
          .setLabel(cap(r)).setValue(r).setDefault(roles.includes(r))))));
  }
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
    .addUserOption((o) => o.setName('user').setDescription('Edit someone else (needs Manage Server)')),
];
const canEdit = (i, tid) => i.user.id === tid || !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
const humans = (vc) => [...vc.members.values()].filter((m) => !m.user.bot).map((m) => m.id);
const riotErr = (e) => (e.status === 403 ? 'Riot API key is invalid or expired.' : `Riot error: ${e.message}`);
const NOPE = { content: 'You need Manage Server to edit someone else.', flags: EPH };
const sessions = new Map(); // public teams message id -> { vcId, res, moved, t }

async function onCommand(i) {
  const tid = i.options.getUser('user')?.id ?? i.user.id;
  if (!canEdit(i, tid)) return i.reply(NOPE);
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
  if (act === 'link') return i.showModal(linkModal(tid));
  if (act === 'rank') return i.showModal(rankModal(tid));
  if (act === 'unlink') {
    const u = db.users[tid];
    if (u) { delete u.puuid; delete u.region; delete u.name; delete u.tag; save(); }
    return i.update(panel(tid, '✅ Account unlinked.'));
  }

  if (act === 'teams') {
    const vc = i.member?.voice?.channel;
    if (!vc) return i.update(panel(tid, '⚠ Join a voice channel first.'));
    const ids = humans(vc);
    if (ids.length < 2) return i.update(panel(tid, '⚠ Need at least 2 people in the channel.'));
    if (ids.length > 10) return i.update(panel(tid, '⚠ Max 10 players.'));
    await i.deferUpdate();
    const res = await makeTeams(ids);
    try {
      const ch = i.channel ?? (await i.guild.channels.fetch(i.channelId));
      const msg = await ch.send(renderTeams(res, !!teamVcs(i.guild), false));
      sessions.set(msg.id, { vcId: vc.id, res, moved: false, t: Date.now() });
      return i.editReply(panel(tid, `✅ [Teams posted](${msg.url}).`));
    } catch (e) {
      console.error(e);
      return i.editReply(panel(tid, '⚠ Couldn\'t post in this channel. The bot needs Send Messages here.'));
    }
  }
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
          const u = (db.users[tid] = { ...(db.users[tid] || {}), puuid: acc.puuid, region, name: acc.gameName, tag: acc.tagLine });
          save();
          const r = await getRank(u, true);
          notice = `✅ Linked **${acc.gameName}#${acc.tagLine}** · ${r.label}`;
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

async function onTeamButton(i) { // buttons on the public teams message
  const s = sessions.get(i.message.id);
  if (!s) return i.reply({ content: 'Expired. Run /lol and press Make teams again.', flags: EPH });
  const vcs = teamVcs(i.guild);
  if (![s.vcId, ...(vcs || [])].includes(i.member?.voice?.channelId))
    return i.reply({ content: 'Join the voice channel to use this.', flags: EPH });
  s.t = Date.now();

  if (i.customId === 'reroll') {
    await i.deferUpdate();
    const vc = i.guild.channels.cache.get(s.vcId);
    const ids = vc ? humans(vc) : s.res.teams.flat().map((p) => p.id);
    if (ids.length < 2) return i.followUp({ content: 'Not enough people in the channel.', flags: EPH });
    s.res = await makeTeams(ids, s.res.key);
    return i.editReply(renderTeams(s.res, !!vcs, false));
  }

  if (i.customId === 'move' || i.customId === 'back') {
    const back = i.customId === 'back';
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
    if (n) { s.moved = !back; await i.message.edit(renderTeams(s.res, true, s.moved)); }
    return i.editReply(`Moved ${n}` + (failed ? `, ${failed} failed (not in voice / missing Move Members).` : '.'));
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

  client.on(Events.InteractionCreate, async (i) => {
    const age = Date.now() - i.createdTimestamp; // ms since the click; Discord allows 3000 for the first reply
    try {
      if (i.isChatInputCommand()) await onCommand(i);
      else if (i.isModalSubmit()) await onModal(i);
      else if (i.isStringSelectMenu()) await onPanel(i);
      else if (i.isButton()) await (i.customId.startsWith('lol:') ? onPanel(i) : onTeamButton(i));
    } catch (e) {
      if (e.code === 10062) { // reply window missed, or another running copy of the bot answered first
        console.warn(`Unknown interaction (age ${age}ms when received, gateway ping ${client.ws.ping}ms). ` +
          (age > 2000 ? 'Event arrived late: slow host or clock skew.' : 'Arrived in time: another copy of the bot is probably running.'));
        return;
      }
      console.error(e);
      const content = `Error: ${riotErr(e)}`;
      const send = i.deferred || i.replied ? i.followUp({ content, flags: EPH }) : i.reply({ content, flags: EPH });
      send.catch(() => {});
    }
  });

  setInterval(() => { for (const [id, s] of sessions) if (Date.now() - s.t > 2 * 3600e3) sessions.delete(id); }, 600e3);
  client.login(DISCORD_TOKEN);
}

if (require.main === module) start();
module.exports = { parseRiotId, parseRank, ratingLabel, toRating, pickSplit, assignRoles, makeTeams, teamVcs, panel, renderTeams, linkModal, rankModal };
