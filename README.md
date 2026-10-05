# Discord Invite Tracker

Tracks the inviter for each new server member and provides a `-inv` command.

## Setup

1. Install [Node.js 20+](https://nodejs.org/).
2. In this folder run `npm install`.
3. Copy `.env.example` to `.env` and add your bot token.
4. In the Discord Developer Portal, enable **Server Members Intent** and **Message Content Intent** for the bot.
5. Invite the bot with the `bot` scope and permissions to **View Audit Log** (needed for vanity-invite joins) and **Send Messages**.
6. Start it with `npm start`.

## Commands

- `-inv` — shows your invite totals.
- `-inv @member` — shows that member's invite totals.
- `-resetinv @member` — resets that member's invite counter. Only user IDs listed in `INVITE_RESETTER_IDS` in `.env` may use it.

To allow resetters, add their Discord user IDs to your `.env`, separated by commas:

```env
INVITE_RESETTER_IDS=123456789012345678,987654321098765432
```

The first time the bot starts in a server, it snapshots that server's current invites. It can only reliably attribute joins that happen while it is online. A member who leaves and rejoins is never counted as an additional invite, including after their inviter's counter is reset.

"Fake" means the invited Discord account is younger than the configured number of days (seven by default). "Left" is an attributed invitee who has left the server.
