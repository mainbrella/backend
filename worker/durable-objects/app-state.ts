export class AppState {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET", "cache-control": "no-store" },
      });
    }

    const visits = (await this.ctx.storage.get<number>("visits")) || 0;
    const nextVisits = visits + 1;
    await this.ctx.storage.put("visits", nextVisits);

    return Response.json({ visits: nextVisits }, {
      headers: { "cache-control": "no-store" },
    });
  }
}
