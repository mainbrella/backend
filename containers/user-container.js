import { DurableObject } from "cloudflare:workers";
import { UserContainerController } from "./user-container-core.js";
import { upgradeTerminal } from "./terminal.js";
import { executeCommand } from "./commands.js";
import { accessFile } from "./files.js";

export class UserContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    if (ctx.container.running) {
      ctx.blockConcurrencyWhile(async () => {
        const metadata = await ctx.storage.get("builderMachine");
        await ctx.container.setInactivityTimeout(metadata?.idleTimeoutMs ?? 10 * 60_000);
      });
    }
    this.controller = new UserContainerController(ctx);
    this.terminals = new Set();
    this.commands = new Set();
    this.controller.onStopped = () => {
      for (const session of this.terminals) session.close(1000, 'Container stopped');
      for (const session of this.commands) session.close();
    };
  }

  fetch(request) {
    if (new URL(request.url).pathname === '/files') return accessFile(this.controller, request, this.commands);
    if (new URL(request.url).pathname === '/exec') return executeCommand(this.controller, request, this.commands);
    if (["/ssh", "/terminal"].includes(new URL(request.url).pathname)) {
      return upgradeTerminal(this.controller, request, this.terminals);
    }
    return this.controller.fetch(request);
  }

  alarm() {
    return this.controller.alarm();
  }
}

export default {
  fetch() {
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
