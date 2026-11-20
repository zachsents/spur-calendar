// One calendar from many: each source synced into the store, what changed told to the brain, and
// writes sent to the provider that holds the event, logged so each can be undone. Other people's
// invites live in the providers, so they stay the source of truth: a write lands there first.
import { Context, Effect, Layer, Schedule, Schema } from "effect"

import { AppEvents } from "spur-kit"
import { apple } from "./apple.ts"
import type { Apple } from "./apple.ts"
import * as core from "./core.ts"
import {
  Conflict,
  EventCancelled,
  EventChanged,
  EventCreated,
  InviteReceived,
  Next,
  StartingSoon,
} from "./events.ts"
import * as google from "./google.ts"
import { awaiting, event, holds, others } from "./model.ts"
import type { Calendar, Delta, Event, Response } from "./model.ts"
import type { Settings } from "./settings.ts"
import { openStore } from "./store.ts"
import type { Store, Write } from "./store.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** What the brain is told about: a day back to two months ahead. */
const TOLD_BACK = DAY
const TOLD_AHEAD = 60 * DAY
/** A read reaches this far back; anything older is kept as it was. */
const READ_BACK = 29 * DAY
const SOON_MS = 10 * MINUTE
const LEAVE_PAD_MIN = 5

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

/** A place to drive to, not a link or a room code. */
const isPlace = (s: string | null): s is string =>
  s !== null && s.trim().length > 3 && !/^https?:|zoom\.us|meet\.google/iu.test(s.trim())

/** Fields whose change is worth saying. */
const watched = [
  "title",
  "start",
  "end",
  "location",
  "status",
  "response",
  "attendees",
  "notes",
  "call",
] as const

const changesOf = (a: Event, b: Event) =>
  watched.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))

/** The same meeting on two calendars (an invite to both accounts, a Google calendar on the Mac). */
const sameKey = (e: Event) => `${e.ical ?? e.title.toLowerCase()}@${e.start}`

const parseEvent: (json: string) => Event = Schema.decodeUnknownSync(Schema.fromJsonString(event))

export interface Sync {
  readonly calendar: string
  readonly name: string
  readonly provider: string
  readonly account: string
  readonly events: number
  readonly error?: string
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

export interface Held {
  readonly held: string
  readonly item: string | null
  readonly why: string
}

const heldId = () => `h-${crypto.randomUUID().slice(0, 8)}`
const writeId = () => `w-${crypto.randomUUID().slice(0, 8)}`

const make = (settings: Settings) =>
  Effect.gen(function* making() {
    const events = yield* AppEvents
    const store: Store = openStore(settings.db)
    /** Connected Google accounts with Calendar's scope, as the core last said. */
    let googles: readonly string[] = []
    /** Asked the user to connect one already, this run. */
    let asked = false
    const mac: Apple | null = settings.apple ? apple(settings.helper) : null
    let appleAccess = "unknown"
    let appleCheckedAt = 0
    /** Writes waiting to be told, by event id. */
    const writeOf = new Map<string, string>()
    let lastNext = ""

    const emit = (draft: { readonly type: string; readonly payload: unknown }) =>
      Effect.ignore(events.emit(draft), { log: "Warn" })

    const calendarOf = (id: string) => store.calendars().find((c) => c.id === id) ?? null

    // Applying what a source says

    const apply = (calendar: Calendar, delta: Delta) => {
      const seen = new Set<string>()
      for (const e of delta.events) {
        seen.add(e.id)
        store.put(e)
      }
      const gone = [...delta.gone]
      if (delta.full) {
        const since = Date.now() - READ_BACK
        for (const id of store.idsOf(calendar.id)) {
          const s = store.get(id)
          if (!seen.has(id) && s !== null && s.event.end > since) {
            gone.push(id)
          }
        }
      }
      for (const id of gone) {
        const s = store.get(id)
        if (s !== null && s.event.status !== "cancelled") {
          store.put({ ...s.event, status: "cancelled" })
        }
      }
      if (delta.cursor !== null || delta.full) {
        store.setCursor(calendar.id, delta.cursor)
      }
    }

    const syncGoogle = (account: string) =>
      Effect.gen(function* syncing() {
        const out: Sync[] = []
        const cals = yield* google.calendarsOf(account)
        for (const c of cals) {
          store.putCalendar(c)
        }
        for (const id of store.dropCalendars(
          "google",
          account,
          cals.map((c) => c.id),
        )) {
          store.markGone(id)
        }
        const cursors = new Map(store.calendars().map((c) => [c.id, c.cursor]))
        for (const c of cals) {
          const first = (cursors.get(c.id) ?? null) === null
          const result = yield* Effect.result(google.read(c, cursors.get(c.id) ?? null))
          if (result._tag === "Failure") {
            out.push({ ...summary(c), error: result.failure.message })
            continue
          }
          apply(c, result.success)
          if (first) {
            initial.add(c.id)
          }
          out.push(summary(c))
        }
        return out
      })

    const syncApple = (m: Apple) =>
      Effect.gen(function* syncing() {
        if (appleAccess !== "full" && Date.now() - appleCheckedAt > 10 * MINUTE) {
          appleCheckedAt = Date.now()
          appleAccess = yield* Effect.orElseSucceed(m.access, () => "unknown")
        }
        if (appleAccess !== "full") {
          return [
            {
              calendar: "apple",
              name: "Apple",
              provider: "apple",
              account: "",
              events: 0,
              error: `Calendar access ${appleAccess}`,
            },
          ]
        }
        const all = yield* m.calendars
        // A Google account added to the Mac's Calendar is synced from Google already.
        const connected = new Set(googles.map((a) => a.toLowerCase()))
        const cals = all.filter((c) => !connected.has(c.account.toLowerCase()))
        for (const c of cals) {
          store.putCalendar(c)
        }
        for (const id of store
          .calendars()
          .filter((c) => c.provider === "apple" && !cals.some((x) => x.id === c.id))
          .map((c) => c.id)) {
          store.markGone(id)
        }
        const read = yield* m.read(cals)
        for (const c of cals) {
          const first = store.idsOf(c.id).length === 0
          const delta = read.get(c.id)
          if (delta !== undefined) {
            apply(c, delta)
          }
          if (first) {
            initial.add(c.id)
          }
        }
        return cals.map(summary)
      })

    const summary = (c: Calendar): Sync => ({
      calendar: c.id,
      name: c.name,
      provider: c.provider,
      account: c.account,
      events: store.counts().find((x) => x.calendar === c.id)?.n ?? 0,
    })

    /** Calendars whose first read this is: what they hold isn't news. */
    const initial = new Set<string>()

    // Telling the brain

    const tell = Effect.gen(function* telling() {
      const now = Date.now()
      const span = store.between(now - TOLD_BACK, now + TOLD_AHEAD, true)
      const emails = new Set<string>()
      for (const s of span) {
        for (const p of others(s.event)) {
          emails.add(p.email)
        }
      }
      const known = yield* core.people([...emails])
      const withPeople = (e: Event): Event => {
        const people: Record<string, string> = {}
        for (const p of others(e)) {
          const id = known[p.email]
          if (id !== undefined) {
            people[p.email] = id
          }
        }
        return Object.keys(people).length === 0 ? e : { ...e, people }
      }
      for (const s of span) {
        const e = withPeople(s.event)
        const json = JSON.stringify(e)
        const write = writeOf.get(e.id)
        writeOf.delete(e.id)
        const by = write === undefined ? {} : { write }
        if (s.told === null) {
          if (e.status !== "cancelled") {
            const first = initial.has(e.calendar)
            yield* emit(EventCreated.make({ event: e, ...(first ? { initial: true } : {}), ...by }))
            store.setTold(e.id, json)
          }
        } else if (e.status === "cancelled") {
          yield* emit(EventCancelled.make({ event: e, ...by }))
          store.setTold(e.id, null)
        } else if (s.told !== json) {
          const changes = changesOf(parseEvent(s.told), e)
          if (changes.length > 0 || write !== undefined) {
            yield* emit(EventChanged.make({ event: e, changes, ...by }))
          }
          store.setTold(e.id, json)
        }
        if (!s.inviteTold && awaiting(e, now) && !initial.has(e.calendar)) {
          yield* emit(InviteReceived.make({ event: e }))
          store.setInviteTold(e.id)
        } else if (!s.inviteTold && initial.has(e.calendar)) {
          store.setInviteTold(e.id)
        }
      }
      initial.clear()
      yield* conflicts
      yield* expectations
    })

    // What's on: merged across calendars, the same meeting once

    const merged = (from: number, to: number) => {
      const out = new Map<string, Event & { readonly also: readonly string[] }>()
      for (const s of store.between(from, to)) {
        const key = sameKey(s.event)
        const had = out.get(key)
        if (had === undefined) {
          out.set(key, { ...s.event, also: [] })
        } else {
          out.set(key, { ...had, also: [...had.also, s.event.calendar] })
        }
      }
      return [...out.values()]
    }

    const conflictsIn = (from: number, to: number) => {
      const busy = merged(from, to).filter(holds)
      const pairs: (readonly [Event, Event])[] = []
      for (let i = 0; i < busy.length; i += 1) {
        const a = busy[i]
        if (a === undefined) {
          continue
        }
        for (let j = i + 1; j < busy.length; j += 1) {
          const b = busy[j]
          if (b === undefined || b.start >= a.end) {
            break
          }
          if (b.start < a.end && a.start < b.end) {
            pairs.push([a, b])
          }
        }
      }
      return pairs
    }

    const conflicts = Effect.gen(function* conflicting() {
      const now = Date.now()
      for (const [a, b] of conflictsIn(now, now + 14 * DAY)) {
        const pair = [a, b]
          .map((e) => `${e.id}@${e.start}-${e.end}`)
          .toSorted()
          .join("|")
        if (!store.conflictSeen(pair)) {
          store.addConflict(pair)
          yield* emit(Conflict.make({ events: [a, b] }))
        }
      }
    })

    // Travel

    const routes = new Map<string, { readonly minutes: number; readonly at: number } | null>()

    const travel = (from: string, to: string, arrive: number | null) =>
      Effect.gen(function* routing() {
        if (mac === null) {
          return null
        }
        const key = `${from}|${to}|${arrive === null ? "" : Math.floor(arrive / HOUR)}`
        const had = routes.get(key)
        if (had !== undefined && (had === null || Date.now() - had.at < 30 * MINUTE)) {
          return had?.minutes ?? null
        }
        const r = yield* Effect.result(mac.route(from, to, arrive, settings.travel))
        const minutes = r._tag === "Success" ? r.success.minutes : null
        routes.set(key, minutes === null ? null : { minutes, at: Date.now() })
        return minutes
      })

    /** Where the user will be coming from: the last place before it that day, else home. */
    const originFor = (e: Event) => {
      const before = merged(e.start - 4 * HOUR, e.start).findLast(
        (x) => holds(x) && x.end <= e.start && sameDay(x.start, e.start) && isPlace(x.location),
      )
      return before?.location ?? settings.home
    }

    const leaving = (e: Event) =>
      Effect.gen(function* leavingFor() {
        if (!isPlace(e.location)) {
          return { leaveAt: null, travelMinutes: null }
        }
        const from = originFor(e)
        if (from === null || from === e.location) {
          return { leaveAt: null, travelMinutes: null }
        }
        const minutes = yield* travel(from, e.location, e.start)
        return minutes === null
          ? { leaveAt: null, travelMinutes: null }
          : { leaveAt: e.start - (minutes + LEAVE_PAD_MIN) * MINUTE, travelMinutes: minutes }
      })

    // Expectations: "leave by 2:40", "the meeting starts"

    const expectations = Effect.gen(function* expecting() {
      const now = Date.now()
      const want = new Map<string, { what: string; by: number; otherwise: string; event: string }>()
      for (const e of merged(now, now + DAY).filter((x) => holds(x) && x.start > now)) {
        if (others(e).length > 0) {
          want.set(`${e.id}:start`, {
            event: e.id,
            what: `${e.title} starts at ${hhmm(e.start)}`,
            by: e.start,
            otherwise: `It's starting now${e.call === null ? "" : `: ${e.call}`}.`,
          })
        }
        const l = yield* leaving(e)
        if (l.leaveAt !== null && l.leaveAt > now) {
          want.set(`${e.id}:leave`, {
            event: e.id,
            what: `Leave for ${e.title} by ${hhmm(l.leaveAt)}`,
            by: l.leaveAt,
            otherwise: `Tell the user to leave now: ${l.travelMinutes} min to ${e.location ?? "it"}.`,
          })
        }
      }
      for (const [key, w] of want) {
        const had = store.expectedOf(key)
        if (had !== null && had.what === w.what && had.by === w.by) {
          continue
        }
        if (had !== null && had.what !== w.what) {
          yield* core.dropExpectation(had.what)
        }
        const r = yield* core.expect(w.what, w.by, w.otherwise)
        if (r !== null) {
          store.setExpected(key, w.event, w.what, w.by)
        }
      }
      // Ones whose event was cancelled, declined or moved away.
      const open = store.db
        .query<{ key: string; what: string; by: number }, []>("SELECT key, what, by FROM expected")
        .all()
      for (const x of open) {
        if (!want.has(x.key) && x.by > now) {
          yield* core.dropExpectation(x.what)
          store.dropExpected(x.key)
        } else if (x.by <= now) {
          store.dropExpected(x.key)
        }
      }
    })

    // The clock: starting soon, and the next meeting for the iPhone

    const tick = Effect.gen(function* ticking() {
      const now = Date.now()
      const upcoming = merged(now, now + DAY).filter((e) => holds(e) && e.start > now)
      for (const e of upcoming.filter((x) => x.start - now <= SOON_MS)) {
        const s = store.get(e.id)
        if (s !== null && s.soonTold !== e.start) {
          const l = yield* leaving(e)
          yield* emit(
            StartingSoon.make({ event: e, minutes: Math.round((e.start - now) / MINUTE), ...l }),
          )
          store.setSoonTold(e.id, e.start)
        }
      }
      const first = upcoming.find((e) => sameDay(e.start, now))
      const l = first === undefined ? null : yield* leaving(first)
      const next =
        first === undefined || l === null
          ? null
          : {
              event: first.id,
              title: first.title,
              start: first.start,
              end: first.end,
              location: first.location,
              ...l,
            }
      const key = JSON.stringify(next)
      if (key !== lastNext) {
        lastNext = key
        yield* emit(Next.make({ next }))
        yield* core.liveActivity(next)
      }
    })

    // Syncing

    /** Reads every source into the store, telling no one. */
    const pull = Effect.gen(function* pulling() {
      const out: Sync[] = []
      const known = yield* core.googleAccounts(google.SCOPE)
      if (known !== null) {
        googles = known
        if (known.length === 0 && !asked) {
          asked = true
          yield* core.askForGoogle
        }
      }
      for (const account of googles) {
        const r = yield* Effect.result(syncGoogle(account))
        if (r._tag === "Success") {
          out.push(...r.success)
        } else {
          out.push({
            calendar: `google:${account}`,
            name: account,
            provider: "google",
            account,
            events: 0,
            error: r.failure.message,
          })
        }
      }
      if (mac !== null) {
        const r = yield* Effect.result(syncApple(mac))
        if (r._tag === "Success") {
          out.push(...r.success)
        } else {
          out.push({
            calendar: "apple",
            name: "Apple",
            provider: "apple",
            account: "",
            events: 0,
            error: r.failure.message,
          })
        }
      }
      return out
    })

    const sync = Effect.tap(pull, () => tell)

    // Writing

    const resolveCalendar = (given: string | undefined) => {
      const all = store.calendars().filter((c) => c.writable)
      const want = (given ?? settings.calendar ?? "").toLowerCase()
      const found =
        all.find((c) => c.id.toLowerCase() === want) ??
        all.find((c) => c.name.toLowerCase() === want) ??
        (want === ""
          ? all.find((c) => c.provider === "google" && c.primary && c.account === googles[0])
          : undefined)
      return found ?? null
    }

    const find = (id: string) => {
      const s = store.get(id)
      return s === null ? Effect.fail(new Error(`No event ${id}`)) : Effect.succeed(s.event)
    }

    const logged = (
      kind: Write["kind"],
      calendar: Calendar,
      before: Event | null,
      after: Event | null,
      undoes: string | null,
    ) =>
      Effect.gen(function* logging() {
        const id = writeId()
        const eventId = after?.id ?? before?.id ?? ""
        store.logWrite({
          id,
          at: Date.now(),
          kind,
          calendar: calendar.id,
          event: eventId,
          before,
          after,
          undoes,
          undoneBy: null,
        })
        if (after !== null) {
          store.put(after)
        } else if (before !== null) {
          store.put({ ...before, status: "cancelled" })
        }
        writeOf.set(eventId, id)
        yield* tell
        return id
      })

    /** Held for the user: the write would email others, so an action item asks first. */
    const hold = (tool: string, args: unknown, what: string, who: readonly string[]) =>
      Effect.gen(function* holding() {
        const id = heldId()
        const r = yield* core.actionItem(
          `Send: ${what}`,
          `${what}. Google emails ${who.join(", ")}. Approve, and I send it (${id}).`,
        )
        const item = r !== null && typeof r.id === "string" ? r.id : null
        store.hold({ id, tool, args, item, summary: what })
        const held: Held = {
          held: id,
          item,
          why: `Emails ${who.join(", ")}: held until the user approves the action item`,
        }
        return held
      })

    /** A held write may go once the user closed its item as done. */
    const approvedArgs = (held: string, tool: string) =>
      Effect.gen(function* approving() {
        const h = store.held(held)
        if (h === null || h.tool !== tool) {
          return yield* Effect.fail(new Error(`Nothing held as ${held}`))
        }
        if (h.done_at !== null) {
          return yield* Effect.fail(new Error(`${held} was sent already`))
        }
        const ok = h.item !== null && (yield* core.itemDone(h.item))
        if (!ok) {
          return yield* Effect.fail(new Error("Not approved yet"))
        }
        store.heldDone(held)
        const args: unknown = JSON.parse(h.args)
        return args
      })

    const create = (input: {
      readonly calendar?: string
      readonly fields: Fields & {
        readonly title: string
        readonly start: number
        readonly end: number
      }
      readonly attendees?: readonly string[]
      readonly call?: boolean
      readonly approved?: boolean
      readonly undoes?: string
    }) =>
      Effect.gen(function* creating() {
        const calendar = resolveCalendar(input.calendar)
        if (calendar === null) {
          return yield* Effect.fail(new Error(`No calendar ${input.calendar ?? ""} to write to`))
        }
        const guests = input.attendees ?? []
        if (guests.length > 0 && input.approved !== true) {
          return yield* hold(
            "create",
            input,
            `Invite to ${input.fields.title}, ${hhmm(input.fields.start)}`,
            guests,
          )
        }
        let made: Event
        if (calendar.provider === "google") {
          made = yield* google.insert(
            calendar,
            { ...input.fields, attendees: guests, call: input.call === true },
            guests.length > 0,
          )
        } else if (mac !== null && guests.length === 0) {
          made = yield* mac.create(calendar, input.fields)
        } else {
          return yield* Effect.fail(new Error("Apple's calendars can't send invites from here"))
        }
        const write = yield* logged(
          input.undoes === undefined ? "create" : "undo",
          calendar,
          null,
          made,
          input.undoes ?? null,
        )
        return { write, event: made }
      })

    /** An event from a line of text, read by Google, so only on a Google calendar; undone like create. */
    const quickAdd = (input: { readonly text: string; readonly calendar?: string }) =>
      Effect.gen(function* adding() {
        const calendar = resolveCalendar(input.calendar)
        if (calendar === null) {
          return yield* Effect.fail(new Error(`No calendar ${input.calendar ?? ""} to write to`))
        }
        if (calendar.provider !== "google") {
          return yield* Effect.fail(
            new Error(
              `${calendar.name} isn't a Google calendar: quick add needs one, create works anywhere`,
            ),
          )
        }
        let made = yield* google.quickAdd(calendar, input.text)
        // Guests are create's, held for approval: any Google read from the text come off again, unemailed.
        if (others(made).length > 0) {
          made = yield* google.patch(calendar, made.id, { attendees: [] }, false)
        }
        const write = yield* logged("create", calendar, null, made, null)
        return { write, event: made }
      })

    const update = (input: {
      readonly id: string
      readonly fields: Fields
      readonly approved?: boolean
      readonly undoes?: string
    }) =>
      Effect.gen(function* updating() {
        const before = yield* find(input.id)
        const calendar = calendarOf(before.calendar)
        if (calendar === null || !calendar.writable) {
          return yield* Effect.fail(new Error(`${before.calendarName} is read-only`))
        }
        const guests = others(before).map((p) => p.email)
        if (before.organizer !== null && !before.organizer.self && guests.length > 0) {
          return yield* Effect.fail(
            new Error(`It's ${before.organizer.email}'s to change; answer it with rsvp`),
          )
        }
        let f = input.fields
        if (f.start !== undefined && f.end === undefined) {
          f = { ...f, end: f.start + (before.end - before.start) }
        }
        if (f.allDay === undefined && (f.start !== undefined || f.end !== undefined)) {
          f = { ...f, allDay: before.allDay }
        }
        if (guests.length > 0 && input.approved !== true) {
          return yield* hold("update", input, `Change ${before.title}`, guests)
        }
        const after =
          calendar.provider === "google"
            ? yield* google.patch(calendar, before.id, f, guests.length > 0)
            : yield* mac === null
                ? Effect.fail(new Error("No Apple calendars here"))
                : mac.update(calendar, before.id, f)
        if (after.id !== before.id) {
          store.put({ ...before, status: "cancelled" })
        }
        const write = yield* logged(
          input.undoes === undefined ? "update" : "undo",
          calendar,
          before,
          after,
          input.undoes ?? null,
        )
        return { write, event: after }
      })

    const cancel = (input: {
      readonly id: string
      readonly approved?: boolean
      readonly undoes?: string
    }) =>
      Effect.gen(function* cancelling() {
        const before = yield* find(input.id)
        const calendar = calendarOf(before.calendar)
        if (calendar === null || !calendar.writable) {
          return yield* Effect.fail(new Error(`${before.calendarName} is read-only`))
        }
        const guests = others(before).map((p) => p.email)
        if (before.organizer !== null && !before.organizer.self && guests.length > 0) {
          return yield* Effect.fail(
            new Error(`It's ${before.organizer.email}'s; decline it with rsvp`),
          )
        }
        if (guests.length > 0 && input.approved !== true) {
          return yield* hold("cancel", input, `Cancel ${before.title}`, guests)
        }
        if (calendar.provider === "google") {
          yield* google.remove(calendar, before.id, guests.length > 0)
        } else if (mac === null) {
          return yield* Effect.fail(new Error("No Apple calendars here"))
        } else {
          yield* mac.remove(calendar, before.id)
        }
        const write = yield* logged(
          input.undoes === undefined ? "cancel" : "undo",
          calendar,
          before,
          null,
          input.undoes ?? null,
        )
        return { write, cancelled: before.id }
      })

    const rsvp = (input: {
      readonly id: string
      readonly response: Response
      readonly notify?: boolean
      readonly approved?: boolean
      readonly undoes?: string
    }) =>
      Effect.gen(function* responding() {
        const before = yield* find(input.id)
        const calendar = calendarOf(before.calendar)
        if (calendar === null || calendar.provider !== "google") {
          return yield* Effect.fail(new Error("Only Google invites can be answered from here"))
        }
        if (before.response === null) {
          return yield* Effect.fail(new Error("He isn't invited to it"))
        }
        const notify = input.notify === true
        if (notify && input.approved !== true) {
          const organizer = before.organizer?.email ?? "the organizer"
          return yield* hold("rsvp", input, `Answer ${before.title}: ${input.response}`, [
            organizer,
          ])
        }
        const after = yield* google.respond(calendar, before.id, input.response, notify)
        const write = yield* logged(
          input.undoes === undefined ? "rsvp" : "undo",
          calendar,
          before,
          after,
          input.undoes ?? null,
        )
        return { write, event: after }
      })

    /** Undoes a write (the latest not yet undone, if none is named) through the same paths. */
    const undo = (id: string | undefined) =>
      Effect.gen(function* undoing() {
        const w =
          id === undefined
            ? store.writes(200).find((x) => x.undoneBy === null && x.kind !== "undo")
            : store.write(id)
        if (w === undefined || w === null) {
          return yield* Effect.fail(new Error("Nothing to undo"))
        }
        if (w.undoneBy !== null) {
          return yield* Effect.fail(new Error(`${w.id} was undone already`))
        }
        const calendar = calendarOf(w.calendar)
        if (calendar === null) {
          return yield* Effect.fail(new Error("Its calendar is gone"))
        }
        if (w.before === null && w.after !== null) {
          return yield* cancel({ id: w.after.id, undoes: w.id })
        }
        if (w.before !== null && w.after === null) {
          const b = w.before
          if (calendar.provider === "google") {
            // Google keeps a cancelled event: confirming it brings it back as it was.
            const after = yield* google.patch(
              calendar,
              b.id,
              { status: "confirmed" },
              others(b).length > 0,
            )
            const write = yield* logged("undo", calendar, b, after, w.id)
            return { write, event: after }
          }
          return yield* create({
            calendar: calendar.id,
            fields: {
              title: b.title,
              start: b.start,
              end: b.end,
              allDay: b.allDay,
              location: b.location,
              notes: b.notes,
              busy: b.busy,
            },
            undoes: w.id,
          })
        }
        if (w.before !== null && w.after !== null) {
          const b = w.before
          if (w.kind === "rsvp" && b.response !== null) {
            return yield* rsvp({ id: w.after.id, response: b.response, undoes: w.id })
          }
          return yield* update({
            id: w.after.id,
            fields: {
              title: b.title,
              start: b.start,
              end: b.end,
              allDay: b.allDay,
              location: b.location,
              notes: b.notes,
              busy: b.busy,
            },
            undoes: w.id,
          })
        }
        return yield* Effect.fail(new Error("Nothing to undo"))
      })

    // Finding time

    const free = (input: {
      readonly from: number
      readonly to: number
      readonly minutes: number
      readonly dayStart: number
      readonly dayEnd: number
      readonly weekends: boolean
      readonly buffer: number
      readonly count: number
    }) => {
      const busy = merged(input.from, input.to)
        .filter(holds)
        .map((e) => [e.start - input.buffer * MINUTE, e.end + input.buffer * MINUTE] as const)
      const slots: { start: number; end: number }[] = []
      const day = new Date(input.from)
      day.setHours(0, 0, 0, 0)
      for (let d = day.getTime(); d < input.to && slots.length < input.count; d += DAY) {
        const date = new Date(d)
        const weekday = date.getDay()
        if (!input.weekends && (weekday === 0 || weekday === 6)) {
          continue
        }
        const open = new Date(d)
        open.setHours(Math.floor(input.dayStart), (input.dayStart % 1) * 60, 0, 0)
        const close = new Date(d)
        close.setHours(Math.floor(input.dayEnd), (input.dayEnd % 1) * 60, 0, 0)
        let at = Math.max(open.getTime(), input.from)
        // Start on a quarter hour.
        at = Math.ceil(at / (15 * MINUTE)) * 15 * MINUTE
        const end = Math.min(close.getTime(), input.to)
        const today = busy.filter(([s, e]) => s < end && e > at).toSorted((a, b) => a[0] - b[0])
        for (const [s, e] of today) {
          if (s - at >= input.minutes * MINUTE) {
            slots.push({ start: at, end: s })
          }
          at = Math.max(at, Math.ceil(e / (5 * MINUTE)) * 5 * MINUTE)
        }
        if (end - at >= input.minutes * MINUTE) {
          slots.push({ start: at, end })
        }
      }
      return slots.slice(0, input.count)
    }

    /** A prep block before a meeting: the latest free stretch in the hours before it. */
    const prep = (input: {
      readonly id: string
      readonly minutes: number
      readonly calendar?: string
    }) =>
      Effect.gen(function* prepping() {
        const e = yield* find(input.id)
        const from = Math.max(Date.now(), e.start - 6 * HOUR)
        const slots = free({
          from,
          to: e.start,
          minutes: input.minutes,
          dayStart: 7,
          dayEnd: 22,
          weekends: true,
          buffer: 0,
          count: 50,
        })
        const slot = slots.at(-1)
        if (slot === undefined) {
          return yield* Effect.fail(new Error(`No ${input.minutes} free minutes before ${e.title}`))
        }
        const end = Math.min(slot.end, e.start)
        return yield* create({
          ...(input.calendar === undefined ? {} : { calendar: input.calendar }),
          fields: {
            title: `Prep: ${e.title}`,
            start: end - input.minutes * MINUTE,
            end,
            notes: e.notes,
          },
        })
      })

    const status = () => ({
      calendars: store.calendars().map((c) => ({
        id: c.id,
        name: c.name,
        provider: c.provider,
        account: c.account,
        writable: c.writable,
        events: store.counts().find((x) => x.calendar === c.id)?.n ?? 0,
        synced: c.cursor !== null || c.provider === "apple",
      })),
      apple: appleAccess,
    })

    return {
      store,
      pull,
      sync,
      tick,
      merged,
      conflictsIn,
      leaving,
      travel,
      create,
      quickAdd,
      update,
      cancel,
      rsvp,
      undo,
      free,
      prep,
      status,
      approvedArgs,
      find,
    }
  })

export class Calendars extends Context.Service<
  Calendars,
  Effect.Success<ReturnType<typeof make>>
>()("switch/calendar/Calendars") {
  static readonly layer = (settings: Settings) => Layer.effect(Calendars, make(settings))

  /** Keeps every source in sync and the brain told, until the scope closes. */
  static readonly workers = Layer.effectDiscard(
    Effect.gen(function* working() {
      const c = yield* Calendars
      yield* Effect.forkScoped(
        Effect.repeat(Effect.ignore(c.sync, { log: "Warn" }), Schedule.spaced("1 minute")),
      )
      yield* Effect.forkScoped(
        Effect.repeat(Effect.ignore(c.tick, { log: "Warn" }), Schedule.spaced("30 seconds")),
      )
    }),
  )
}
