import { DurableObject } from 'cloudflare:workers';

// First-install namespace declarations only. The staging setup script gives this
// worker no public routes, schedules, service bindings, or external namespaces.
class InitializingObject extends DurableObject {
  fetch(): Response { return new Response('Staging is initializing.', { status: 503 }); }
}
export class AccountActivity extends InitializingObject {}
export class ContainerAccount extends InitializingObject {}
export class ReceptionistCall extends InitializingObject {}
export default {
  fetch(): Response { return new Response('Staging is initializing.', { status: 503 }); },
};
