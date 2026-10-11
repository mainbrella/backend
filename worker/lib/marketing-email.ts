import { z } from "zod";
import { renderMarketingEmail } from "../templates/marketing-email";

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

export async function sendMarketingEmail(binding: SendEmail, email: MarketingEmail): Promise<EmailSendResult> {
  const sender = marketingSender(email.from);
  if (!sender) throw new Error("invalid_sender");
  return binding.send({
    from: sender,
    to: email.to,
    subject: email.subj,
    text: email.message,
    html: renderMarketingEmail(email.subj, email.message),
  });
}
