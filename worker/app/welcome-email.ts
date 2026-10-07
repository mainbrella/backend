import type { AuthUser } from "./auth-core";

const WELCOME_TEXT = `💥 Hey there! Thanks for signing up with mainbrella.

Real quick and I'll get out of your inbox.

My name is Andrew, founder of the mainbrella and we will jump over backwards here to make you a happy customer.

Please let me know personally if there is anything confusing or hard to use.

Keep out of the rain!

Best,
-aa`;

// Call only after this request has created the account, never on sign-in/linking.
export async function welcomeNewUser(env: Env, user: AuthUser, ctx?: ExecutionContext): Promise<void> {
  if (!user.email) return;
  const send = async () => {
    try {
      if (!env.WELCOME_EMAIL) throw new Error("Welcome email binding is unavailable.");
      await env.WELCOME_EMAIL.send({
        from: { email: "andrew@mainbrella.com", name: "Andrew Arrow" },
        to: user.email!,
        subject: "Thanks for signing up! 🔋⚡",
        text: WELCOME_TEXT,
      });
    } catch (error) {
      console.error("welcome_email_failed", user.id, error);
    }
  };
  // Keep delivery alive after the HTTP response; direct callers await delivery.
  if (ctx) ctx.waitUntil(send());
  else await send();
}
