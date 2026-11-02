import { defineConfig, loadEnv } from "vite";

/** Serves the Vercel function during `npm run dev`. Vercel runs it directly in production. */
function demoApi(mode) {
  return {
    name: "ajo-demo-api",
    configureServer(server) {
      Object.assign(process.env, loadEnv(mode, process.cwd(), "DEMO_"));
      server.middlewares.use("/api/demo", async (req, res) => {
        let text = "";
        for await (const chunk of req) text += chunk;
        req.body = text ? JSON.parse(text) : {};
        const { default: handler } = await server.ssrLoadModule("/api/demo.js");
        await handler(req, res);
      });
    },
  };
}

export default defineConfig(({ mode }) => ({ plugins: [demoApi(mode)] }));
