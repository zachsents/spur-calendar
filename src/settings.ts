// Calendar's settings: ~/.switch/calendar.json (or $CALENDAR_CONFIG). Every key is optional.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Schema } from "effect"

const file = Schema.Struct({
  /** EventKit's calendars too. Default: on, on a Mac. */
  apple: Schema.optionalKey(Schema.Boolean),
  /** Where the user starts from when nothing earlier that day says, for travel time. */
  home: Schema.optionalKey(Schema.String),
  /** Where new events go: a calendar's id or name. Default: the first Google account's own. */
  calendar: Schema.optionalKey(Schema.String),
  /** How the user gets around: driving, walking or transit. */
  travel: Schema.optionalKey(Schema.Literals(["driving", "walking", "transit"])),
})

export interface Settings {
  readonly dir: string
  /** Where the EventKit helper app is built: one place, so its permission holds. */
  readonly helper: string
  readonly db: string
  readonly apple: boolean
  readonly home: string | null
  readonly calendar: string | null
  readonly travel: "driving" | "walking" | "transit"
}

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(file))

export const loadSettings = (): Settings => {
  // Beside the brain it tells: what's been told is per brain.
  const dir =
    process.env.CALENDAR_DIR ??
    path.join(process.env.SWITCH_DIR ?? path.join(homedir(), ".switch"), "calendar")
  const at = process.env.CALENDAR_CONFIG ?? path.join(homedir(), ".switch", "calendar.json")
  const f = existsSync(at) ? decode(readFileSync(at, "utf-8")) : {}
  return {
    dir,
    helper: path.join(homedir(), ".switch", "calendar"),
    db: process.env.CALENDAR_DB ?? path.join(dir, "calendar.db"),
    apple: f.apple ?? process.platform === "darwin",
    home: f.home ?? null,
    calendar: f.calendar ?? null,
    travel: f.travel ?? "driving",
  }
}

export const settingsPath = () =>
  process.env.CALENDAR_CONFIG ?? path.join(homedir(), ".switch", "calendar.json")
