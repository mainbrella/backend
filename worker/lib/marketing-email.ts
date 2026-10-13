import { marketingUnsubscribeUrl, renderMarketingEmail } from "../templates/marketing-email";
import { marketingSender, type MarketingEmail } from "../shared/marketing-email-contract";
export { marketingSender, marketingEmailSchema, marketingUnsubscribeSchema, type MarketingEmail } from "../shared/marketing-email-contract";

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
  if (!env.MARKETING_EMAIL) throw new Error("email_sending_unavailable");
  return env.MARKETING_EMAIL.send({
    from: sender,
    to: email.to,
    subject: email.subj,
    text: `${email.message}\n\nUnsubscribe: ${marketingUnsubscribeUrl(email.to)}`,
    html: renderMarketingEmail(email.subj, email.message, email.to, email.fancy),
  });
}
