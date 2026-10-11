import { z } from "zod";
import { marketingUnsubscribeUrl, renderMarketingEmail } from "../templates/marketing-email";

const emailAddress = z.email().max(254);
const noHeaderControls = /^[^\x00-\x1f\x7f]+$/;

export function marketingSender(value: string): string | EmailAddress | null {
  if (!noHeaderControls.test(value)) return null;
  const sender = value.trim();
  if (emailAddress.safeParse(sender).success) return sender;
  const named = /^([^<>]+?)\s*<([^<>]+)>$/.exec(sender);
  if (!named) return null;
  const email = named[2].trim();
  let name = named[1].trim();
  if (name.startsWith('"') || name.endsWith('"')) {
    if (!/^"(?:[^"\\]|\\["\\])*"$/.test(name)) return null;
    name = name.slice(1, -1).replace(/\\(["\\])/g, "$1").trim();
  } else if (/[",;]/.test(name)) return null;
  return name && emailAddress.safeParse(email).success ? { email, name } : null;
}

export const marketingEmailSchema = z.object({
  to: emailAddress,
  subj: z.string().min(1).max(998).regex(noHeaderControls).refine(value => Boolean(value.trim())),
  from: z.string().min(1).max(512).refine(value => marketingSender(value) !== null,
    "Expected one email address, optionally with a display name."),
  message: z.string().min(1).max(100_000).refine(value => Boolean(value.trim())),
}).strict();

export type MarketingEmail = z.infer<typeof marketingEmailSchema>;

export const marketingUnsubscribeSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
}).strict();

export class MarketingEmailPreferenceError extends Error {
  constructor(message: "recipient_unsubscribed" | "email_preferences_unavailable") {
    super(message);
  }
}

export async function sendMarketingEmail(env: Pick<Env, "DB" | "MARKETING_EMAIL">, email: MarketingEmail): Promise<EmailSendResult> {
  const sender = marketingSender(email.from);
  if (!sender) throw new Error("invalid_sender");
  let preference;
  try {
    preference = await env.DB.prepare(`SELECT (
      EXISTS (SELECT 1 FROM users WHERE lower(trim(email)) = ? AND marketing_email_unsubscribed = 1)
      OR EXISTS (SELECT 1 FROM marketing_email_unsubscribes WHERE email = ?)
    ) AS unsubscribed`).bind(email.to.trim().toLowerCase(), email.to.trim().toLowerCase()).first<{ unsubscribed: number }>();
    if (!preference) throw new Error("missing_email_preferences");
  } catch {
    // A failed preference check must never permit a marketing send.
    throw new MarketingEmailPreferenceError("email_preferences_unavailable");
  }
  if (preference.unsubscribed) throw new MarketingEmailPreferenceError("recipient_unsubscribed");
  return env.MARKETING_EMAIL.send({
    from: sender,
    to: email.to,
    subject: email.subj,
    text: `${email.message}\n\nUnsubscribe: ${marketingUnsubscribeUrl(email.to)}`,
    html: renderMarketingEmail(email.subj, email.message, email.to),
  });
}
