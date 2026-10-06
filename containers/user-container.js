import { DurableObject } from "cloudflare:workers";
import { UserContainerController } from "./user-container-core.js";
import { upgradeTerminal } from "./terminal.js";
import { executeCommand } from "./commands.js";
import { accessFile } from "./files.js";
import { accessFilesystem } from './filesystem.js';
import { ManagedExecutions } from './executions.js';
import { ContainerPreviews } from './previews.js';
import { WorkloadWebhooks } from './webhooks.js';
import { exportWorkspace } from './workspace-export.js';

export class UserContainer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.controller = new UserContainerController(ctx);
    this.terminals = new Set();
    this.commands = new Set();
    this.executions = new ManagedExecutions(this.controller, this.commands, ctx);
    this.previews = new ContainerPreviews(this.controller);
    this.webhooks = new WorkloadWebhooks(this.controller, env);
    this.controller.webhooks = this.webhooks;
    this.controller.observations.onAppend = event => this.webhooks.enqueue(event);
    this.webhooks.onChange = () => ctx.waitUntil(this.executions.scheduleCleanup().catch(() => { console.error('webhook_alarm_schedule_failed'); }));
    this.controller.onStarted = createdAt => this.monitor(createdAt);
    this.controller.onStopped = () => {
      this.previews.close();
      for (const session of this.terminals) session.close(1000, 'Container stopped');
      for (const session of this.commands) session.close();
    };
    ctx.blockConcurrencyWhile(async () => {
      await this.executions.recover();
      if (ctx.container.running) {
        const metadata = await ctx.storage.get('builderMachine');
        await ctx.container.setInactivityTimeout(metadata?.idleTimeoutMs ?? 10 * 60_000);
        this.monitor(metadata?.createdAt);
      }
    });
  }

  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/features') return this.controller.fetch(request);
    if (path === '/workspaces/export-v1') return exportWorkspace(this.controller,request,this.commands);
    if (path.startsWith('/workspaces/')) return this.controller.fetch(request);
    if (path.startsWith('/observations/webhook')) return this.webhooks.fetch(request);
    if (path === '/previews') return this.previews.manage(request);
    if (path === '/preview' || path.startsWith('/preview/')) return this.previews.forward(request);
    if (path.startsWith('/filesystem/')) return accessFilesystem(this.controller, request, this.commands);
    if (new URL(request.url).pathname === '/executions' || new URL(request.url).pathname.startsWith('/executions/')) return this.executions.fetch(request);
    if (new URL(request.url).pathname === '/files') return accessFile(this.controller, request, this.commands);
    if (new URL(request.url).pathname === '/exec') return executeCommand(this.controller, request, this.commands);
    if (["/ssh", "/terminal"].includes(new URL(request.url).pathname)) {
      return upgradeTerminal(this.controller, request, this.terminals);
    }
    return this.executions.lifecycleFetch(request);
  }

  monitor(createdAt) {
    if (createdAt === undefined || this.monitoredGeneration === createdAt) return;
    this.monitoredGeneration = createdAt;
    const observe = async failed => {
      await this.controller.observePlatformStop(createdAt, failed);
      await this.controller.observations.prune();
      await this.executions.scheduleCleanup();
    };
    this.ctx.waitUntil(this.ctx.container.monitor().then(() => observe(false), () => observe(true))
      .catch(() => { console.error('container_lifecycle_observation_failed'); }));
  }

  async alarm() {
    await this.controller.alarm();
    await this.executions.prune();
    await this.controller.observations.prune();
    await this.webhooks.tick();
    await this.executions.scheduleCleanup();
  }
}

export default {
  fetch() {
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
