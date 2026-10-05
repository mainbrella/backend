When adding or changing an API endpoint, update its Chanfana/Zod schema in
`worker/app/openapi-*.ts` in the same change. Include request parameters/body,
responses, authentication, and a unique operation ID. Register new feature modules
in `worker/app/openapi.ts` and update coverage in `worker/app/openapi.test.ts`.
Existing handlers own runtime validation and authorization; the OpenAPI adapter
must preserve raw requests, responses (including WebSockets), and execution context.
Run `npm run test:openapi`, `npm run type-check`, and `npm run docs:generate`.
