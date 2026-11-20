// Apple's calendars (iCloud, On My Mac, subscribed) through EventKit, and MapKit's routing, by a
// small Swift helper built into an app bundle on first use, so Calendar access is its own and asked
// for once. EventKit keeps no change tokens, so each read is the whole window, diffed by the caller.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Data, Effect } from "effect"

import { plist, source } from "./apple/helper.ts"
import { toResponse } from "./model.ts"
import type { Calendar, Delta, Event, Person, Response } from "./model.ts"

const BACK_MS = 30 * 86_400_000
const AHEAD_MS = 400 * 86_400_000

export class AppleError extends Data.TaggedError("AppleError")<{ readonly message: string }> {}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {})
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const num = (v: unknown): number => (typeof v === "number" ? v : 0)
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])

/** Builds the helper if it's missing or its source changed. Returns the bundle. */
const bundle = (dir: string) => {
  const app = path.join(dir, "Switch Calendar.app")
  const exe = path.join(app, "Contents", "MacOS", "calendar")
  const stamp = path.join(app, "Contents", "source.sha256")
  const hash = createHash("sha256").update(source).update(plist).digest("hex")
  if (existsSync(exe) && existsSync(stamp) && readFileSync(stamp, "utf-8") === hash) {
    return { app, exe }
  }
  rmSync(app, { recursive: true, force: true })
  mkdirSync(path.dirname(exe), { recursive: true })
  const src = path.join(dir, "helper.swift")
  writeFileSync(src, source)
  writeFileSync(path.join(app, "Contents", "Info.plist"), plist)
  const built = Bun.spawnSync(["swiftc", "-O", "-swift-version", "5", src, "-o", exe])
  if (built.exitCode !== 0) {
    throw new Error(`Can't build the calendar helper: ${built.stderr.toString().slice(0, 400)}`)
  }
  Bun.spawnSync(["codesign", "-s", "-", "--force", app])
  writeFileSync(stamp, hash)
  return { app, exe }
}

const parse = (text: string): unknown => {
  const out: unknown = JSON.parse(text.trim() || "null")
  if (isRecord(out) && typeof out.error === "string") {
    throw new AppleError({ message: out.error })
  }
  return out
}

const toEvent = (calendar: Calendar, raw: unknown): Event => {
  const e = rec(raw)
  const attendees: Person[] = list(e.attendees).map((x) => {
    const a = rec(x)
    return {
      email: str(a.email).toLowerCase(),
      name: str(a.name),
      status: toResponse(a.status),
      self: a.self === true,
    }
  })
  const organizer = isRecord(e.organizer)
    ? { email: str(e.organizer.email).toLowerCase(), self: e.organizer.self === true }
    : null
  const me = attendees.find((a) => a.self)
  let response: Response | null = null
  if (me !== undefined) {
    response = me.status
  } else if (organizer?.self === true) {
    response = "accepted"
  }
  const url = str(e.url)
  return {
    id: `${calendar.id}/${str(e.id)}`,
    calendar: calendar.id,
    calendarName: calendar.name,
    ical: null,
    title: str(e.title) || "(No title)",
    start: num(e.start),
    end: num(e.end),
    allDay: e.allDay === true,
    location: str(e.location) || null,
    notes: str(e.notes) || null,
    call: /zoom\.us|meet\.google|teams\.microsoft|facetime/u.test(url) ? url : null,
    status: e.cancelled === true ? "cancelled" : "confirmed",
    busy: e.busy !== false,
    response,
    organizer,
    attendees,
    recurring: e.recurring === true,
  }
}

/** `<item>@<occurrence>` back to what the helper finds an event by. */
const target = (calendar: Calendar, id: string) => {
  const local = id.slice(calendar.id.length + 1)
  const at = local.lastIndexOf("@")
  return { item: local.slice(0, at), occurrence: Number(local.slice(at + 1)) }
}

export interface Fields {
  readonly title?: string
  readonly start?: number
  readonly end?: number
  readonly allDay?: boolean
  readonly location?: string | null
  readonly notes?: string | null
  readonly busy?: boolean
}

/** Run by Switch Host, whose bundle id its children inherit. */
const underHost = process.env.__CFBundleIdentifier === "ax.switch.host"

export const apple = (dir: string) => {
  let built: { readonly app: string; readonly exe: string } | null = null
  const helper = () => {
    built ??= bundle(dir)
    return built
  }

  /** The helper as this process's child: routing, which needs no permission, and EventKit under the host. */
  const direct = (command: string, args: unknown) =>
    Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn([helper().exe, command, JSON.stringify(args)], {
          stdout: "pipe",
          stderr: "ignore",
        })
        const text = await new Response(proc.stdout).text()
        await proc.exited
        return parse(text)
      },
      catch: (e) => (e instanceof AppleError ? e : new AppleError({ message: String(e) })),
    })

  /**
   * EventKit's commands. Under Switch Host (signed, ax.switch.host) the helper runs as its child, so
   * the host's Calendar permission covers it; anywhere else it runs as its own app (via `open`).
   */
  const run = (command: string, args: unknown = {}) =>
    underHost
      ? direct(command, args)
      : Effect.tryPromise({
          try: async () => {
            const { app } = helper()
            const out = path.join(tmpdir(), `switch-calendar-${crypto.randomUUID()}.json`)
            const proc = Bun.spawn(
              [
                "open",
                "-W",
                "-n",
                "-g",
                "--stdout",
                out,
                app,
                "--args",
                command,
                JSON.stringify(args),
              ],
              { stdout: "ignore", stderr: "ignore" },
            )
            await proc.exited
            try {
              return parse(readFileSync(out, "utf-8"))
            } finally {
              rmSync(out, { force: true })
            }
          },
          catch: (e) => (e instanceof AppleError ? e : new AppleError({ message: String(e) })),
        })

  const access = Effect.map(run("access"), (r) => str(rec(r).status))

  const calendars = Effect.map(run("calendars"), (r): Calendar[] =>
    list(r).map((raw) => {
      const c = rec(raw)
      return {
        id: `apple:${str(c.id)}`,
        provider: "apple",
        account: str(c.source),
        remote: str(c.id),
        name: str(c.title),
        color: str(c.color) || null,
        writable: c.writable === true,
        primary: false,
      }
    }),
  )

  /** Every event of these calendars in the window: a full read. */
  const read = (cals: readonly Calendar[]) =>
    Effect.map(
      run("events", {
        from: Date.now() - BACK_MS,
        to: Date.now() + AHEAD_MS,
        calendars: cals.map((c) => c.remote),
      }),
      (r) => {
        const byRemote = new Map(cals.map((c) => [c.remote, c]))
        const out = new Map<string, Delta & { events: Event[] }>(
          cals.map((c) => [c.id, { events: [], gone: [], full: true, cursor: null }]),
        )
        for (const raw of list(r)) {
          const c = byRemote.get(str(rec(raw).calendar))
          if (c !== undefined) {
            out.get(c.id)?.events.push(toEvent(c, raw))
          }
        }
        return out
      },
    )

  return {
    access,
    calendars,
    read,
    create: (calendar: Calendar, f: Fields) =>
      Effect.map(run("create", { ...f, calendar: calendar.remote }), (r) => toEvent(calendar, r)),
    update: (calendar: Calendar, id: string, f: Fields) =>
      Effect.map(run("update", { ...f, ...target(calendar, id) }), (r) => toEvent(calendar, r)),
    remove: (calendar: Calendar, id: string) => Effect.asVoid(run("delete", target(calendar, id))),
    /** Minutes to get from one place to another, arriving by `arrive`. */
    route: (from: string, to: string, arrive: number | null, mode: string) =>
      Effect.map(
        direct("route", { from, to, mode, ...(arrive === null ? {} : { arrive }) }),
        (r) => {
          const x = rec(r)
          return {
            minutes: Math.round(num(x.seconds) / 60),
            km: Math.round(num(x.meters) / 100) / 10,
            from: str(x.from),
            to: str(x.to),
          }
        },
      ),
  }
}

export type Apple = ReturnType<typeof apple>
