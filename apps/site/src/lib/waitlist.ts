import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type WaitlistResult = { ok: true } | { ok: false; reason: string };

/**
 * Provider adapter — the email provider is not decided yet (spec is pre-launch).
 * Priority: Resend audience > generic webhook > local file (dev only).
 */
export async function addToWaitlist(email: string): Promise<WaitlistResult> {
  if (process.env.RESEND_API_KEY && process.env.RESEND_AUDIENCE_ID) {
    return addViaResend(email);
  }
  if (process.env.WAITLIST_WEBHOOK_URL) {
    return addViaWebhook(email);
  }
  if (process.env.NODE_ENV !== "production") {
    return addViaLocalFile(email);
  }
  return { ok: false, reason: "no_provider_configured" };
}

async function addViaResend(email: string): Promise<WaitlistResult> {
  const res = await fetch(
    `https://api.resend.com/audiences/${process.env.RESEND_AUDIENCE_ID}/contacts`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, unsubscribed: false }),
    },
  );
  if (!res.ok) return { ok: false, reason: `resend_${res.status}` };
  return { ok: true };
}

async function addViaWebhook(email: string): Promise<WaitlistResult> {
  const res = await fetch(process.env.WAITLIST_WEBHOOK_URL as string, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, source: "semantic-access-proxy-landing" }),
  });
  if (!res.ok) return { ok: false, reason: `webhook_${res.status}` };
  return { ok: true };
}

async function addViaLocalFile(email: string): Promise<WaitlistResult> {
  const dir = path.join(process.cwd(), ".waitlist");
  await mkdir(dir, { recursive: true });
  await appendFile(
    path.join(dir, "signups.jsonl"),
    JSON.stringify({ email, at: new Date().toISOString() }) + "\n",
  );
  return { ok: true };
}
