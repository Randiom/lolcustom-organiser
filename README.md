# lol-team-bot

Discord bot for League of Legends custom games. Members link their Riot account, then the bot makes rank- and role-balanced teams, from a voice channel or from a standing queue, with captain drafts, duo partners and an in-house leaderboard.

## Commands
| Command | |
|---|---|
| `/queue` | Post a queue in this channel that anyone can join |
| `/lol` | Your private profile panel: link account, roles, duo, manual rank, **Make teams** from your voice channel |
| `/leaderboard` | Post the in-house leaderboard in the channel |
| `/lol test:8` | Practice lobby with fake players (Manage Server) |
| `/leaderboard reset:true` | New season: archive the standings, then clear in-house results (Manage Server, asks to confirm). Links, roles and duos stay. |

## Queue
`/queue` posts a sign-up message that stays up. People press **Join queue** or **Leave** whenever they like. The message shows each player's rank and main role, the role mix and the average rank.

- At 10 players it pops by itself: teams are posted with a ping to everyone, and the queue empties and re-posts itself below the teams, so the next sign-up is always at the bottom of the channel.
- Anyone in the queue can press **Start now** to play with fewer.
- **My profile** opens your private panel (link account, set roles) straight from the queue.
- **Host** (the person who opened it, or Manage Server) opens private host tools: remove a player who wandered off, move the queue to the bottom of a busy channel, or close it.
- One queue per channel. If the message gets deleted, `/queue` makes a new one.

## Teams
- **Balanced by rank** (solo queue, flex fallback, manual rank for smurfs) plus the in-house rating. Among near-equal splits, the bot prefers the one where everyone gets a role they're happy with, then picks randomly so **Reroll** gives variety.
- **Win chance bar** (🔵 52% … 48% 🔴) shows how even the match is.
- **Roles:** main role plus "also OK with", or Fill. Each team gets one player per role. ↻ marks a player who got a role they didn't pick.
- **Duo partner:** you're always on the same team when you're both playing.
- **Captain draft:** the two highest-rated players captain, the lower-rated one picks first, snake order. Shows who is still available with rank and role.
- **Results:** press 🔵 Blue won or 🔴 Red won. Everyone's in-house rating change is shown per player (Elo style, capped at ±300) and feeds back into balancing. **Undo** if someone misclicked. **Play again** posts fresh teams for the same players.
- **Move to team channels** (and back to wherever each player came from) if the server has voice channels named "Blue" and "Red".

## Profile and leaderboard
`/lol` shows your account, rank crest, roles, in-house record and duo. The leaderboard ranks everyone with at least one game by rank + in-house rating, with W/L and winrate. When you open it from your panel and you're outside the top 10, your own position is shown at the bottom.

## Practice lobby (test alone)
`/lol test:8` (Manage Server) fills a lobby with you plus 7 fake players. **Make teams**, Reroll, Captain draft and the result buttons then work with nobody in voice. Only you can press its buttons, you pick for both captains, and results aren't saved. If you have a duo partner set, "Test 1 🤝" stands in for them. Run plain `/lol` to leave.

## Setup
1. Discord Developer Portal → New Application → Bot → copy the token. Invite with scopes `bot` + `applications.commands` and permissions View Channel, Send Messages, Embed Links, Attach Files, Connect and Move Members.
2. Get a Riot API key at developer.riotgames.com (dev keys expire every 24h; register a personal app for a permanent one).
3. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `RIOT_KEY` (or set them as environment variables on your host).
4. `npm install && npm start`

## Config (env vars)
| Var | Default | |
|---|---|---|
| `DISCORD_TOKEN`, `RIOT_KEY` | | required |
| `GUILD_ID` | | register commands on one server (instant) |
| `DEFAULT_REGION` | `euw` | region for plain `Name#TAG` (op.gg links set their own) |
| `RANK_TTL_HOURS` | `24` | rank cache lifetime |
| `DB_FILE` | `data.json` | links, ranks, results, open queues and teams messages. Keep it on persistent storage. |
| `ICON_URL` | Community Dragon | crest URL template with `{tier}`, used only if `icons/<tier>.png` is missing |
| `TEAM1_VC` / `TEAM2_VC` | | channel IDs for team voice channels |
| `DEFAULT_RATING`, `TOLERANCE` | `1000`, `20` | unranked fallback, balancing randomness |

## Images
`icons/` holds the rank crests and role icons (from the game) and the banners: `match.png` (teams), `results.png` (after a result), `draft.png` (captain draft), `leaderboard.png` and `banner.png` (queue, and the fallback for any missing one). Replace any of them with a ~1200×300 image of the same name. On startup the bot uploads the crests and role icons once as application emojis. The console should say `Rank crests loaded: 14/14`; any that fail fall back to plain emoji.

Queues and teams messages survive bot restarts. Teams messages stay interactive for 12 hours after their last use, queues for a week.

## Tests
`npm test` runs a suite with a mocked Riot API and fake Discord interactions. It needs no tokens.

Never commit `.env` or `data.json`.
