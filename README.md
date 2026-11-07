# lol-team-bot

Discord bot that links members to their League of Legends accounts and splits a voice channel into two rank-balanced teams.

`/lol` opens a private panel: link account (Riot ID or op.gg link), pick roles, set a manual rank, make teams.

## Setup
1. Discord Developer Portal → New Application → Bot → copy the token. Invite with scopes `bot` + `applications.commands` and permissions View Channel, Send Messages, Move Members.
2. Get a Riot API key at developer.riotgames.com (dev keys expire every 24h; register a personal app for a permanent one).
3. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `RIOT_KEY` (or set them as environment variables on your host).
4. `npm install && npm start`

Optional: create voice channels with "Blue" and "Red" in their names to enable **Move to team channels**.

## Config (env vars)
| Var | Default | |
|---|---|---|
| `DISCORD_TOKEN`, `RIOT_KEY` | | required |
| `GUILD_ID` | | register `/lol` on one server (instant) |
| `DEFAULT_REGION` | `euw` | region for plain `Name#TAG` |
| `RANK_TTL_HOURS` | `24` | rank cache lifetime |
| `DB_FILE` | `data.json` | where links and ranks are stored |
| `TEAM1_VC` / `TEAM2_VC` | | channel IDs for team voice channels |
| `DEFAULT_RATING`, `TOLERANCE` | `1000`, `20` | unranked fallback, balancing randomness |

Never commit `.env` or `data.json`.
