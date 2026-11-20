// The helper's Swift source and its bundle's Info.plist, as text, so a compiled binary carries
// them. Built by apple.ts.
export const source = String.raw`// Calendar's hands on this Mac: EventKit (every calendar the Mac's Calendar has: iCloud, local,
// subscribed) and MapKit routing. One command per run, JSON in its arguments, JSON out on stdout.
// Built into an app bundle so EventKit's permission is its own; see apple.ts.
import EventKit
import Foundation
import MapKit

let store = EKEventStore()

func out(_ value: Any) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [])) ?? Data("null".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}

func fail(_ message: String) -> Never {
  out(["error": message])
}

func ms(_ d: Date?) -> Any { d.map { Int64($0.timeIntervalSince1970 * 1000) } ?? NSNull() }
func date(_ v: Any?) -> Date? { (v as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) } }

func status() -> String {
  switch EKEventStore.authorizationStatus(for: .event) {
  case .fullAccess: return "full"
  case .writeOnly: return "writeOnly"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

func requireAccess() {
  if status() == "full" { return }
  let wait = DispatchSemaphore(value: 0)
  store.requestFullAccessToEvents { _, _ in wait.signal() }
  _ = wait.wait(timeout: .now() + 120)
  if status() != "full" { fail("Calendar access \(status())") }
}

func partStatus(_ s: EKParticipantStatus) -> String {
  switch s {
  case .accepted: return "accepted"
  case .declined: return "declined"
  case .tentative: return "tentative"
  case .pending: return "needsAction"
  default: return "needsAction"
  }
}

func email(_ p: EKParticipant) -> String {
  let s = p.url.absoluteString
  return s.lowercased().hasPrefix("mailto:") ? String(s.dropFirst(7)) : s
}

func event(_ e: EKEvent) -> [String: Any] {
  let occurrence = e.occurrenceDate ?? e.startDate
  return [
    "id": "\(e.eventIdentifier ?? e.calendarItemIdentifier)@\(Int64((occurrence ?? Date()).timeIntervalSince1970 * 1000))",
    "item": e.eventIdentifier ?? e.calendarItemIdentifier,
    "calendar": e.calendar.calendarIdentifier,
    "title": e.title ?? "",
    "start": ms(e.startDate),
    "end": ms(e.endDate),
    "allDay": e.isAllDay,
    "timeZone": e.timeZone?.identifier ?? NSNull(),
    "location": e.location ?? NSNull(),
    "notes": e.notes ?? NSNull(),
    "url": e.url?.absoluteString ?? NSNull(),
    "cancelled": e.status == .canceled,
    "busy": e.availability != .free,
    "modified": ms(e.lastModifiedDate),
    "recurring": e.hasRecurrenceRules || e.isDetached,
    "organizer": e.organizer.map { ["name": $0.name ?? "", "email": email($0), "self": $0.isCurrentUser] } ?? NSNull(),
    "attendees": (e.attendees ?? []).map { ["name": $0.name ?? "", "email": email($0), "status": partStatus($0.participantStatus), "self": $0.isCurrentUser] },
  ]
}

func find(_ args: [String: Any]) -> EKEvent {
  guard let item = args["item"] as? String else { fail("No item") }
  if let at = date(args["occurrence"]) {
    let found = store.events(matching: store.predicateForEvents(withStart: at.addingTimeInterval(-1), end: at.addingTimeInterval(86400 * 2), calendars: nil))
      .first { $0.eventIdentifier == item && abs(($0.occurrenceDate ?? $0.startDate).timeIntervalSince(at)) < 1 }
    if let found { return found }
  }
  guard let e = store.event(withIdentifier: item) else { fail("No event \(item)") }
  return e
}

func apply(_ e: EKEvent, _ args: [String: Any]) {
  if let v = args["title"] as? String { e.title = v }
  if let v = date(args["start"]) { e.startDate = v }
  if let v = date(args["end"]) { e.endDate = v }
  if let v = args["allDay"] as? Bool { e.isAllDay = v }
  if args["location"] is NSNull { e.location = nil } else if let v = args["location"] as? String { e.location = v }
  if args["notes"] is NSNull { e.notes = nil } else if let v = args["notes"] as? String { e.notes = v }
  if let v = args["busy"] as? Bool { e.availability = v ? .busy : .free }
}

func place(_ text: String) async -> MKMapItem? {
  let request = MKLocalSearch.Request()
  request.naturalLanguageQuery = text
  return try? await MKLocalSearch(request: request).start().mapItems.first
}

let argv = CommandLine.arguments
let command = argv.count > 1 ? argv[1] : ""
let args = (argv.count > 2 ? try? JSONSerialization.jsonObject(with: Data(argv[2].utf8)) : nil) as? [String: Any] ?? [:]

switch command {
case "access":
  if status() == "notDetermined" {
    let wait = DispatchSemaphore(value: 0)
    store.requestFullAccessToEvents { _, _ in wait.signal() }
    _ = wait.wait(timeout: .now() + 120)
  }
  out(["status": status()])

case "calendars":
  requireAccess()
  out(store.calendars(for: .event).map { c in
    [
      "id": c.calendarIdentifier,
      "title": c.title,
      "source": c.source.title,
      "kind": c.source.sourceType == .calDAV ? "caldav" : c.source.sourceType == .local ? "local" : c.source.sourceType == .subscribed ? "subscribed" : c.source.sourceType == .birthdays ? "birthdays" : c.source.sourceType == .exchange ? "exchange" : "other",
      "writable": c.allowsContentModifications,
      "color": c.cgColor.flatMap { col -> String? in
        guard let comps = col.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)?.components, comps.count >= 3 else { return nil }
        return String(format: "#%02x%02x%02x", Int(comps[0] * 255), Int(comps[1] * 255), Int(comps[2] * 255))
      } ?? NSNull(),
    ] as [String: Any]
  })

case "events":
  requireAccess()
  guard let from = date(args["from"]), let to = date(args["to"]) else { fail("No span") }
  let ids = args["calendars"] as? [String]
  let cals = ids.map { want in store.calendars(for: .event).filter { want.contains($0.calendarIdentifier) } }
  // EventKit searches at most four years at a time.
  var all: [[String: Any]] = []
  var at = from
  while at < to {
    let until = min(to, at.addingTimeInterval(86400 * 365))
    all += store.events(matching: store.predicateForEvents(withStart: at, end: until, calendars: cals)).filter { $0.startDate >= at || at == from }.map(event)
    at = until
  }
  out(all)

case "create":
  requireAccess()
  guard let calId = args["calendar"] as? String, let cal = store.calendar(withIdentifier: calId) else { fail("No calendar") }
  let e = EKEvent(eventStore: store)
  e.calendar = cal
  apply(e, args)
  do { try store.save(e, span: .thisEvent, commit: true) } catch { fail(error.localizedDescription) }
  out(event(e))

case "update":
  requireAccess()
  let e = find(args)
  apply(e, args)
  do { try store.save(e, span: (args["series"] as? Bool) == true ? .futureEvents : .thisEvent, commit: true) } catch { fail(error.localizedDescription) }
  out(event(e))

case "delete":
  requireAccess()
  let e = find(args)
  let was = event(e)
  do { try store.remove(e, span: (args["series"] as? Bool) == true ? .futureEvents : .thisEvent, commit: true) } catch { fail(error.localizedDescription) }
  out(was)

case "route":
  // Driving time between two places in words, departing now or at "depart".
  guard let fromText = args["from"] as? String, let toText = args["to"] as? String else { fail("No places") }
  let mode = (args["mode"] as? String) ?? "driving"
  Task {
    guard let a = await place(fromText) else { fail("Can't find \(fromText)") }
    guard let b = await place(toText) else { fail("Can't find \(toText)") }
    let request = MKDirections.Request()
    request.source = a
    request.destination = b
    request.transportType = mode == "walking" ? .walking : mode == "transit" ? .transit : .automobile
    if let d = date(args["depart"]) { request.departureDate = d }
    if let d = date(args["arrive"]) { request.arrivalDate = d }
    do {
      let eta = try await MKDirections(request: request).calculateETA()
      out(["seconds": eta.expectedTravelTime, "meters": eta.distance, "from": a.name ?? fromText, "to": b.name ?? toText])
    } catch {
      fail(error.localizedDescription)
    }
  }
  dispatchMain()

default:
  fail("Unknown command \(command)")
}
`

export const plist = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>ax.switch.calendar</string>
  <key>CFBundleName</key><string>Switch Calendar</string>
  <key>CFBundleExecutable</key><string>calendar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSBackgroundOnly</key><true/>
  <key>NSCalendarsFullAccessUsageDescription</key><string>Switch keeps every calendar in one.</string>
</dict>
</plist>
`
