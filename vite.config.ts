import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 开发环境复用生产同源路径，同时代理 WebSocket 协作握手，避免前端出现第二套 API 地址配置。
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
