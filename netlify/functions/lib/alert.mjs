/*
 * Opt-in failure alerting for the scheduled functions. Set ALERT_WEBHOOK to a
 * Slack- or Discord-style incoming webhook URL (SETUP.md §6) and the nightly
 * jobs will post a one-line summary when a step fails — so a silent
 * daily-rollover error (skipped waivers, unsettled week) actually reaches you.
 * No env var → no-op, so it's safe to leave unset.
 */
export async function notify(text) {
  const url = process.env.ALERT_WEBHOOK;
  if (!url) return false;
  try {
    // Slack reads `text`, Discord reads `content` — send both so either works.
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text }),
    });
    if (!res.ok) console.error(`alert webhook returned ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error("alert webhook failed:", (e && e.message) || e);
    return false;
  }
}

// Collect `{step: {error}}` entries into "step: message" lines. Non-error
// values (numbers, plain results) are ignored.
export function failuresIn(out) {
  return Object.entries(out || {})
    .filter(([, v]) => v && typeof v === "object" && v.error)
    .map(([k, v]) => `${k}: ${v.error}`);
}
