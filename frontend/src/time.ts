export type Zone = "local" | "utc";

export function formatTime(iso: string, zone: Zone, withDate = true): string {
  const f = new Intl.DateTimeFormat("en-GB", {
    ...(withDate ? { weekday: "short" as const, day: "numeric" as const, month: "short" as const } : {}),
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: zone === "utc" ? "UTC" : undefined, timeZoneName: "short",
  });
  return f.format(new Date(iso));
}

export function zoneName(zone: Zone): string {
  if (zone === "utc") return "UTC";
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz === "Asia/Calcutta" || tz === "Asia/Kolkata" ? "IST (UTC+5:30)" : tz;
}
