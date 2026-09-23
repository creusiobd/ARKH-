import express, { Express } from "express";
import { env } from "../shared/config/env";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  if (env.isProduction) {
    app.set("trust proxy", 1);
  }

  return app;
}

export function startServer(app: Express, port = Number(process.env.PORT ?? 3000)): ReturnType<Express["listen"]> {
  return app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${port}`);
  });
}
