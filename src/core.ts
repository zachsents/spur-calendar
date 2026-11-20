// The rest of Switch, reached the way an agent reaches it: the core's apps over MCP (`/apps`). What
// Calendar asks of others: autonomy (expectations, action items), the brain (an item's answer),
// contacts (who an attendee is) and the iPhone (a Live Activity). Each is optional: a missing app
// or an unreachable core is null, and Calendar goes on without it.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { Effect } from "effect"

const url = () => `${process.env.SWITCH_URL ?? "http://127.0.0.1:4871"}/apps`

let connected: Promise<Client> | null = null

const connect = async () => {
  const client = new Client({ name: "calendar", version: "1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url())))
  return client
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Calls another app's tool (`<app>_<tool>`): its structured result, or null if it isn't there. */
export const callCore = (name: string, args: Record<string, unknown>) =>
  Effect.promise(async (): Promise<Record<string, unknown> | null> => {
    try {
      connected ??= connect()
      const client = await connected
      const r = await client.callTool({ name, arguments: args })
      if (r.isError === true) {
        return null
      }
      if (isRecord(r.structuredContent)) {
        return r.structuredContent
      }
      const first = Array.isArray(r.content) ? r.content[0] : undefined
      const text = first?.type === "text" ? first.text : "null"
      const parsed: unknown = JSON.parse(text)
      return isRecord(parsed) ? parsed : null
    } catch {
      connected = null
      return null
    }
  })

/** Connected Google accounts that granted `scope`; null when the core can't say. */
export const googleAccounts = (scope: string) =>
  Effect.map(callCore("connections_list", {}), (r) => {
    if (r === null || !Array.isArray(r.connections)) {
      return null
    }
    return r.connections.flatMap((c: unknown) =>
      isRecord(c) &&
      c.provider === "google" &&
      typeof c.account === "string" &&
      Array.isArray(c.scopes) &&
      c.scopes.includes(scope)
        ? [c.account]
        : [],
    )
  })

/** Asks the user to connect a Google account: an action item with a Connect button. */
export const askForGoogle = callCore("connections_request", { provider: "google" })

/** "X by T, else wake", in a space (Home unless told). */
export const expect = (what: string, by: number, otherwise: string, space = "Home") =>
  callCore("autonomy_expect", { space, what, by: new Date(by).toISOString(), otherwise })

export const dropExpectation = (what: string, space = "Home") =>
  callCore("autonomy_expect", { space, what, by: 0, drop: true })

/** An action item, through the gate. */
export const actionItem = (title: string, body: string, space = "Home") =>
  callCore("autonomy_action_item", { space, title, body })

/** Whether the user closed an action item as done. */
export const itemDone = (id: string) =>
  Effect.map(callCore("brain_query", { type: "item.closed", limit: 500 }), (r) => {
    const events = r !== null && Array.isArray(r.events) ? r.events : []
    return events.some(
      (e: unknown) =>
        isRecord(e) && isRecord(e.payload) && e.payload.id === id && e.payload.status === "done",
    )
  })

/**
 * Contacts' people for these emails: `{email: personId}`. Contacts owns people; until its spur
 * answers `contacts_match`, this is empty.
 */
export const people = (emails: readonly string[]) =>
  emails.length === 0
    ? Effect.succeed<Record<string, string>>({})
    : Effect.map(callCore("contacts_match", { emails }), (r) => {
        const out: Record<string, string> = {}
        const found = r !== null && isRecord(r.people) ? r.people : {}
        for (const [email, id] of Object.entries(found)) {
          if (typeof id === "string") {
            out[email] = id
          }
        }
        return out
      })

/** What the iPhone's Live Activity for the next meeting shows. */
export interface NextUp {
  readonly event: string
  readonly title: string
  readonly start: number
  readonly end: number
  readonly location: string | null
  /** When to leave, if there's somewhere to go. */
  readonly leaveAt: number | null
  readonly travelMinutes: number | null
}

/**
 * The iPhone's Live Activity: started or updated with the next meeting, ended with null. The iPhone
 * spur's tool (`iphone_activity`) doesn't exist yet; this is the call it will answer.
 */
export const liveActivity = (next: NextUp | null) =>
  callCore(
    "iphone_activity",
    next === null
      ? { kind: "next-meeting", end: true }
      : { kind: "next-meeting", id: next.event, state: next },
  )
