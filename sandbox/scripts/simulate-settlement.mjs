import { resolve } from "node:path";

import { postJson, readFixture } from "./helpers.mjs";

const fixtureArg = process.argv[2] ?? "sandbox/fixtures/settlement.sample.json";
const baseUrl = process.env.LOCAL_API_BASE_URL ?? "http://localhost:4000/api";

const payload = await readFixture(resolve(process.cwd(), fixtureArg));
const response = await postJson(baseUrl, "/cabinet-events/callbacks/settlement", payload);

console.log(JSON.stringify(response, null, 2));
