import { CHANNELS, handleRequest, refreshChannel } from "./core";

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
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const results = await Promise.allSettled(CHANNELS.map((channel) => refreshChannel(env, channel)));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "rejected") {
        console.error(JSON.stringify({
          message: "routing health refresh failed",
          channel: CHANNELS[index],
          error: result.reason instanceof Error ? result.reason.message : "unknown error",
        }));
      }
    }
  },
} satisfies ExportedHandler<Env>;
