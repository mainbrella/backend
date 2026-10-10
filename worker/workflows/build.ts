import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { runBuildAgent } from '../lib/build-agent';
import type { BuildParams } from '../lib/build-contract';

export class BuildWorkflow extends WorkflowEntrypoint<Env, BuildParams> {
  async run(event: WorkflowEvent<BuildParams>, step: WorkflowStep) {
    await runBuildAgent(this.env, event.payload, step, event.timestamp.getTime());
  }
}
