import { handleRequest } from "./core";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error(JSON.stringify({
        message: "dispatcher request failed",
        error: error instanceof Error ? error.message : "unknown error",
        path: new URL(request.url).pathname,
      }));
      return Response.json({ error: "dispatcher unavailable" }, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
  },
} satisfies ExportedHandler<Env>;
