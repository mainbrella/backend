import { z } from "zod";

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
  fancy: z.boolean().default(true).describe("Use the branded template; false sends only the message on a white background with a normal font."),
}).strict();

export type MarketingEmail = z.input<typeof marketingEmailSchema>;

export const marketingUnsubscribeSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
}).strict();

