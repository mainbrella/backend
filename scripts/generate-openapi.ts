import { writeFile } from "node:fs/promises";
import { app } from "../worker/app/router";

// Fetch the same document served by the Worker, without secrets or bindings.
const response = await app.request("http://localhost/openapi.json", undefined, {} as Env);
if (!response.ok) throw new Error(`OpenAPI generation failed: ${response.status}`);
const schema = await response.json();
const output = process.argv[2] || "openapi.json";
await writeFile(output, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`Generated ${output}`);
