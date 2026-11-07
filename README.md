# lol-team-bot

Discord bot for League of Legends custom games. Members link their Riot account, and the bot splits a voice channel into two rank-balanced teams, with optional captain drafts, duo partners and an in-house leaderboard.

`/lol` opens a private panel: link account (Riot ID or op.gg link), set roles, duo partner, manual rank, leaderboard, **Make teams**.

## Features
- **Rank-balanced teams** from solo queue rank (flex fallback), with random variety between near-equal splits and a **Reroll** button.
- **Roles:** a main role plus "also OK with", or Fill. Each team gets one player per role where possible.
- **Duo partner:** set one on your panel and you are always on the same team when you are both in the channel.
- **Captain draft:** the two highest-rated players captain, the lower-rated one picks first, snake order.
- **Results and leaderboard:** press 🔵 Blue won or 🔴 Red won after a game. Players gain or lose an in-house rating adjustment (Elo style, capped at ±300) that feeds back into balancing. Undo is available. The Leaderboard button shows the top 10.
- **Move to team channels** (and back) if the server has voice channels named "Blue" and "Red".
- Manual rank for unranked players and smurfs. Rank is cached for 24h and refreshed when you open `/lol`.

## Practice lobby (test alone)
Run `/lol test:8` (needs Manage Server) to fill a lobby with you plus 7 fake players. **Make teams**, Reroll, Captain draft and the result buttons then work with nobody in voice. Fake players have random ranks and roles, and only you can press the buttons. In a practice lobby you pick for both captains. Results are not saved and nothing lands in the leaderboard. If you have a duo partner set, "Test 1 🤝" stands in as your duo. Run plain `/lol` to leave.

## Setup
1. Discord Developer Portal → New Application → Bot → copy the token. Invite with scopes `bot` + `applications.commands` and permissions View Channel, Send Messages, Embed Links, Connect and Move Members.
2. Get a Riot API key at developer.riotgames.com (dev keys expire every 24h; register a personal app for a permanent one).
3. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `RIOT_KEY` (or set them as environment variables on your host).
4. `npm install && npm start`

## Config (env vars)
| Var | Default | |
|---|---|---|
| `DISCORD_TOKEN`, `RIOT_KEY` | | required |
| `GUILD_ID` | | register `/lol` on one server (instant) |
| `DEFAULT_REGION` | `euw` | region for plain `Name#TAG` (op.gg links set their own) |
| `RANK_TTL_HOURS` | `24` | rank cache lifetime |
| `DB_FILE` | `data.json` | links, ranks, duo partners and results. Keep it on persistent storage. |
| `ICON_URL` | Community Dragon | crest URL template with `{tier}` (iron, bronze, … master) |
| `TEAM1_VC` / `TEAM2_VC` | | channel IDs for team voice channels |
| `DEFAULT_RATING`, `TOLERANCE` | `1000`, `20` | unranked fallback, balancing randomness |

## Rank icons
The real crests ship in `icons/` (128px, from the wiki). On startup the bot uploads the rank crests (Iron … Diamond, Master+, Unranked) and the five role icons as application emojis and uses them next to every rank. Source per tier: `icons/<tier>.png`, otherwise the URL in `ICON_URL`. Emojis are only uploaded once. If a crest can't be loaded, that tier falls back to a coloured emoji. Check the console for `Rank crests loaded: 14/14`.

Teams messages stay interactive for 12 hours (or until the bot restarts).

## Tests
`npm test` runs a suite with a mocked Riot API and fake Discord interactions. It needs no tokens.

Never commit `.env` or `data.json`.
