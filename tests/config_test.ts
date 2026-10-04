import { isDenoDeploy } from "../src/config.ts";

const cases: {
  name: string;
  env: Record<string, string>;
  expected: boolean;
}[] = [
  { name: "self-hosted with no Deploy variables", env: {}, expected: false },
  {
    name: "Deploy flag without a deployment ID",
    env: { DENO_DEPLOY: "true" },
    expected: true,
  },
  {
    name: "deployment ID without the Deploy flag",
    env: { DENO_DEPLOYMENT_ID: "test-deployment" },
    expected: true,
  },
  {
    name: "both Deploy variables",
    env: { DENO_DEPLOY: "true", DENO_DEPLOYMENT_ID: "test-deployment" },
    expected: true,
  },
  ...["false", "", "1", "TRUE"].map((flag) => ({
    name: `non-true Deploy flag ${JSON.stringify(flag)}`,
    env: { DENO_DEPLOY: flag },
    expected: false,
  })),
];

for (const { name, env, expected } of cases) {
  Deno.test(`runtime detection: ${name}`, () => {
    const actual = isDenoDeploy((key) => env[key]);
    if (actual !== expected) {
      throw new Error(`Expected ${expected}, got ${actual}`);
    }
  });
}
