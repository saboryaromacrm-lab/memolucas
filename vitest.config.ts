import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      TZ: "America/Argentina/Buenos_Aires",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5433/memolucas_test",
      DATA_DIR: "./tests/.datos",
      APP_SECRET: "secreto-de-pruebas-con-mas-de-32-caracteres-xx",
      LOG_LEVEL: "silent",
    },
    fileParallelism: false,
    testTimeout: 20000,
  },
});
