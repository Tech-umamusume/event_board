const encoder = new TextEncoder();
const string = (value) => typeof value === "string" ? value : "";
const items = (value) => Array.isArray(value) ? value : [];
function time(value) {
  const ms = typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
function utc(milliseconds) {
  const iso = new Date(milliseconds).toISOString();
  if (!/^\d{4}-/.test(iso)) throw Object.assign(new Error("日程日期超出支持范围"), { status: 400 });
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
export function escapeIcsText(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;")
    .replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}
export function foldIcsLine(line) {
  let result = "", current = "", bytes = 0;
  for (const character of String(line)) {
    const size = encoder.encode(character).length;
    if (bytes + size > 75) {
      result += current + "\r\n";
      current = " "; bytes = 1;
    }
    current += character; bytes += size;
  }
  return result + current;
}
function eventLines(event) {
  const view = event?.view || event?.compiled_data;
  const core = view?.l1_core, modules = view?.l2_modules || {};
  const start = time(core?.start_time);
  if (!view || start === null) return null;
  const end = time(core.end_time);
  const effectiveEnd = end !== null && end > start ? end : start + 2 * 3600000;
  const title = string(core.title).trim() || "未命名活动";
  const name = string(core.location_name).trim(), address = string(core.location_address).trim();
  const location = address.includes(name) ? address : [name, address].filter(Boolean).join(" ");
  const description = [];
  if (string(core.time_display)) description.push("时间说明：" + core.time_display);
  if (end === null || end <= start) description.push("结束时间未明确，日历暂按开始后 2 小时显示，请以活动通知为准。");
  const rules = items(core.must_know).filter(v => typeof v === "string" && v.trim());
  if (rules.length) description.push("入场红线：" + rules.join("；"));
  const changes = items(core.change_alerts).filter(v => v && typeof v === "object")
    .map(v => [string(v.field), string(v.old_value) + " → " + string(v.new_value), string(v.reason)].filter(Boolean).join("："));
  if (changes.length) description.push("近期变更：" + changes.join("；"));
  const focus = items(modules.personal_focus).filter(v => typeof v === "string" && v.trim());
  if (focus.length) description.push("个人关注：" + focus.join("；"));
  const contacts = items(modules.links_and_contacts).filter(v => v && typeof v === "object")
    .map(v => [string(v.label), string(v.value)].filter(Boolean).join("：")).filter(Boolean);
  if (contacts.length) description.push("入口与联络：" + contacts.join("；"));
  const lines = [
    "BEGIN:VEVENT",
    "UID:" + escapeIcsText(String(event.id) + "@event-board"),
    "SEQUENCE:" + (Number.isInteger(event.version) ? event.version : 1),
    "DTSTAMP:" + utc(time(event.updated_at) ?? Date.now()),
    "DTSTART:" + utc(start), "DTEND:" + utc(effectiveEnd),
    "SUMMARY:" + escapeIcsText(title),
  ];
  if (location) lines.push("LOCATION:" + escapeIcsText(location));
  if (description.length) lines.push("DESCRIPTION:" + escapeIcsText(description.join("\n")));
  for (const trigger of ["-P1D", "-PT1H"]) {
    lines.push("BEGIN:VALARM", "TRIGGER:" + trigger, "ACTION:DISPLAY",
      "DESCRIPTION:" + escapeIcsText(title), "END:VALARM");
  }
  return [...lines, "END:VEVENT"];
}
function calendar(lines) {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Event Board//Personal Calendar//ZH",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Event Board 活动日程",
    "X-WR-TIMEZONE:Asia/Shanghai", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
    ...lines, "END:VCALENDAR",
  ].map(foldIcsLine).join("\r\n") + "\r\n";
}
export function buildCalendarFeed(events) {
  return calendar(items(events).flatMap(event => eventLines(event) || []));
}
export function buildSingleEventIcs(event) {
  const lines = eventLines(event);
  if (!lines) throw Object.assign(new Error("该活动尚未确定明确开始时间，无法导出日程"), { status: 400 });
  return calendar(lines);
}
