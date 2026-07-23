import { join } from "node:path";

import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyInstance } from "fastify";

export const buildApp = (options: { logger?: boolean | object } = {}): FastifyInstance => {
	const app = Fastify({
		logger: options.logger ?? false,
		bodyLimit: 16 * 1024,
		logController: new LogController({
			disableRequestLogging: true,
		}),
	});

	void app.register(helmet, {
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"],
				fontSrc: ["'self'", "https://fonts.gstatic.com"],
				styleSrc: ["'self'", "https://fonts.googleapis.com"],
				imgSrc: ["'self'", "data:"],
				scriptSrc: ["'none'"],
			},
		},
		crossOriginEmbedderPolicy: false,
	});

	void app.register(fastifyStatic, {
		root: join(import.meta.dirname, "..", "public"),
		index: "index.html",
		cacheControl: true,
		maxAge: "1h",
	});

	app.get("/health", () => ({
		service: "the402machine",
		status: "ok",
	}));

	return app;
};
