# spur-calendar

Every Google and Apple (EventKit) calendar in one, synced both ways: the providers stay the source of truth, every write can be undone, and anything that would email someone else waits for the user. Agenda, free time, conflicts, travel time and invites; an agenda widget in Home.

A [Switch](https://switch.ax) spur, built on [spur-kit](https://github.com/zachsents/spur-kit).

## Install

Ask Switch's agent to install `github:zachsents/spur-calendar`, or add it in the desktop's Spurs view
(⌘K, Spurs). Switch runs it on the first machine with what it needs.

## Setup

Connect Google accounts in Switch (Connections). On a Mac it reads EventKit too, through a small
Swift helper it builds on first use (needs `swiftc`). Settings, all optional, in
`~/.switch/calendar.json`: `apple`, `home` (where travel starts), `calendar` (where new events go),
`travel` (driving, walking or transit).

## Develop

```sh
bun install
bun run check
bun start   # serves MCP on stdio
```

## iPhone

`ios/` is Calendar for iPhone (SwiftUI, XcodeGen). It reaches this spur through Switch's core, calling the
same tools an agent does. `sh ios/build.sh` installs it on a paired iPhone; `--simulator` builds it
for the simulator. Team, bundle id prefix and the core's address come from the environment or a
`deploy.local` (`ios_team`, `ios_bundle_prefix`, `ios_core`), never the source.
