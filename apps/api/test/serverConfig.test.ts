import assert from "node:assert/strict";
import test from "node:test";
import { loadApiServerRuntimeConfig } from "../src/serverConfig.js";

test("开发环境保留本机默认值，便于直接启动", () => {
  const config = loadApiServerRuntimeConfig({});
  assert.equal(config.port, 4317);
  assert.equal(config.host, "0.0.0.0");
  assert.match(config.databaseUrl, /localhost:54329/);
  assert.equal(config.seedDevelopmentData, true);
  assert.equal(config.corsOrigin, true);
  assert.deepEqual(config.aliyunVod, { enabled: false, region: null });
});

test("生产环境默认禁用开发种子和跨源访问", () => {
  const config = loadApiServerRuntimeConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://xiqu:secret@db.internal/xiqu",
  });
  assert.equal(config.seedDevelopmentData, false);
  assert.equal(config.corsOrigin, false);
  assert.equal(config.host, "127.0.0.1");
  assert.deepEqual(config.aliyunVod, { enabled: false, region: null });
});

test("阿里云 VOD 必须显式启用并提供有效区域", () => {
  const config = loadApiServerRuntimeConfig({
    XIQU_ALIYUN_VOD_ENABLED: "true",
    XIQU_ALIYUN_VOD_REGION: "cn-shanghai",
  });
  assert.deepEqual(config.aliyunVod, {
    enabled: true,
    region: "cn-shanghai",
  });
  assert.throws(
    () => loadApiServerRuntimeConfig({ XIQU_ALIYUN_VOD_ENABLED: "true" }),
    /XIQU_ALIYUN_VOD_REGION/,
  );
  assert.throws(
    () => loadApiServerRuntimeConfig({
      XIQU_ALIYUN_VOD_ENABLED: "true",
      XIQU_ALIYUN_VOD_REGION: "Shanghai",
    }),
    /XIQU_ALIYUN_VOD_REGION/,
  );
});

test("显式生产配置会规范化、去重有限 origin", () => {
  const config = loadApiServerRuntimeConfig({
    NODE_ENV: "production",
    DATABASE_URL: " postgresql://xiqu:secret@db.internal/xiqu ",
    PORT: "8443",
    HOST: "::1",
    XIQU_SEED_DEVELOPMENT_DATA: "true",
    XIQU_CORS_ORIGINS: "https://example.org, http://localhost:5173/,https://example.org",
  });
  assert.equal(config.port, 8443);
  assert.equal(config.host, "::1");
  assert.equal(config.seedDevelopmentData, true);
  assert.deepEqual(config.corsOrigin, [
    "https://example.org",
    "http://localhost:5173",
  ]);
});

test("生产环境拒绝缺失或空白数据库连接", () => {
  assert.throws(
    () => loadApiServerRuntimeConfig({ NODE_ENV: "production" }),
    /必须显式设置 DATABASE_URL/,
  );
  assert.throws(
    () => loadApiServerRuntimeConfig({ NODE_ENV: "production", DATABASE_URL: "  " }),
    /DATABASE_URL 不能为空/,
  );
});

test("无效端口和安全布尔值会在监听前失败", () => {
  for (const port of ["", "0", "65536", "1.5", "abc"]) {
    assert.throws(() => loadApiServerRuntimeConfig({ PORT: port }), /PORT/);
  }
  assert.throws(
    () => loadApiServerRuntimeConfig({ XIQU_SEED_DEVELOPMENT_DATA: "yes" }),
    /只接受 true 或 false/,
  );
  for (const host of ["", "localhost", "example.org", "127.0.0.1/path"]) {
    assert.throws(() => loadApiServerRuntimeConfig({ HOST: host }), /HOST/);
  }
});

test("CORS 只接受不含凭据、路径或通配符的 HTTP(S) origin", () => {
  for (const corsOrigins of [
    "",
    "*",
    "example.org",
    "ftp://example.org",
    "https://user:secret@example.org",
    "https://example.org/api",
    "https://example.org?mode=test",
  ]) {
    assert.throws(
      () => loadApiServerRuntimeConfig({ XIQU_CORS_ORIGINS: corsOrigins }),
      /XIQU_CORS_ORIGINS/,
    );
  }
});
