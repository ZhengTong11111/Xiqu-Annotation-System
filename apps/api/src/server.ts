import { createServer } from "node:http";
import { sendError, sendJson } from "./http.js";
import { InMemoryPlatformRepository } from "./repository.js";
import { routeRequest } from "./router.js";

const repository = new InMemoryPlatformRepository();
const port = Number(process.env.PORT ?? 4317);

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, null);
    return;
  }

  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const data = await routeRequest({
      request,
      response,
      url,
      repository,
    });
    sendJson(response, 200, { data });
  } catch (error) {
    sendError(response, error);
  }
});

server.listen(port, () => {
  console.info(`Xiqu platform API listening on http://localhost:${port}`);
});
