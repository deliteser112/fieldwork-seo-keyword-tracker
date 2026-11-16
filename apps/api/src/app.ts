import "reflect-metadata";
import { TrackerError } from "./application/tracker";
import { PrismaTrackerStore } from "./infrastructure/tracker-store";
import { TrackerController, TRACKER, TRACKER_ORIGIN } from "./tracker-http";
import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpException,
  Inject,
  Module,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { createDatabase, createReadiness } from "./infrastructure/database";
import { z } from "zod";
import { AccessDenied, AccessService } from "./application/access";
import {
  createCredentials,
  PrismaIdentityStore,
} from "./infrastructure/identity";
import type { Config } from "./config";

const CONFIG = Symbol("CONFIG");
const DATABASE = Symbol("DATABASE");
const loginInput = z
  .object({ email: z.email().max(254), password: z.string().min(1).max(256) })
  .strict();
const cookieName = "tracker_session";
@Catch()
class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const transportStatus =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      [400, 413, 429].includes(error.statusCode)
        ? error.statusCode
        : undefined;
    const status =
      error instanceof TrackerError
        ? error.status
        : error instanceof AccessDenied
          ? 401
          : error instanceof HttpException
            ? error.getStatus()
            : (transportStatus ?? 503);
    const code =
      error instanceof TrackerError
        ? error.code
        : ((
            {
              400: "INVALID_REQUEST",
              401: "UNAUTHENTICATED",
              403: "FORBIDDEN",
              404: "NOT_FOUND",
              429: "RATE_LIMITED",
              503: "SERVICE_UNAVAILABLE",
            } as Record<number, string>
          )[status] ?? "REQUEST_FAILED");
    // Do not serialize raw exceptions: ORM errors may include connection details.
    request.log[status >= 500 ? "error" : "info"](
      { requestId: request.id, status, code },
      "request failed",
    );
    void response.code(status).send({ error: code, requestId: request.id });
  }
}
@Controller("api")
class AccessController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DATABASE) private readonly database: { ready(): Promise<void> },
  ) {}
  private token(req: FastifyRequest) {
    return req.cookies[cookieName];
  }
  private origin(req: FastifyRequest) {
    if (req.headers.origin !== this.config.APP_ORIGIN)
      throw new ForbiddenException();
  }
  @Get("health") async health() {
    try {
      await this.database.ready();
      return { status: "ready" };
    } catch {
      throw new ServiceUnavailableException();
    }
  }
  @Get("live") live() {
    return { status: "alive" };
  }
  @Post("auth/login") async login(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.origin(req);
    const parsed = loginInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const result = await this.access.login(
      parsed.data.email,
      parsed.data.password,
      this.token(req),
    );
    reply.setCookie(cookieName, result.token, {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE === "true",
      sameSite: "lax",
      path: "/",
      maxAge: this.config.SESSION_TTL_SECONDS,
    });
    reply.code(200);
    return { user: result.user, csrfToken: result.csrfToken };
  }
  @Get("auth/session") async session(@Req() req: FastifyRequest) {
    const token = this.token(req);
    const user = await this.access.authenticate(token);
    if (!token) throw new UnauthorizedException();
    return { user, csrfToken: this.access.csrf(token) };
  }
  @Post("auth/logout") async logout(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    this.origin(req);
    const token = this.token(req);
    await this.access.authenticate(token);
    if (!token || !this.access.validCsrf(token, req.headers["x-csrf-token"]))
      throw new ForbiddenException();
    await this.access.logout(token);
    reply.clearCookie(cookieName, {
      path: "/",
      httpOnly: true,
      secure: this.config.COOKIE_SECURE === "true",
      sameSite: "lax",
    });
    return reply.code(204).send();
  }
  @Get("clients") async clients(@Req() req: FastifyRequest) {
    return {
      clients: await this.access.clients(
        await this.access.authenticate(this.token(req)),
      ),
    };
  }
  @Get("clients/:id") async client(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    const owner = await this.access.authenticate(this.token(req));
    if (!z.uuid().safeParse(id).success) throw new NotFoundException();
    const client = await this.access.client(owner, id);
    if (!client) throw new NotFoundException();
    return { client };
  }
}
export async function createApp(config: Config) {
  const db = createDatabase(config.DATABASE_URL);
  const access = new AccessService(
    new PrismaIdentityStore(db),
    await createCredentials(),
    config.SESSION_TTL_SECONDS,
  );
  @Module({
    controllers: [AccessController, TrackerController],
    providers: [
      { provide: TRACKER, useValue: new PrismaTrackerStore(db) },
      { provide: TRACKER_ORIGIN, useValue: config.APP_ORIGIN },
      { provide: AccessService, useValue: access },
      { provide: CONFIG, useValue: config },
      { provide: DATABASE, useValue: createReadiness(db) },
    ],
  })
  class AppModule {}
  const adapter = new FastifyAdapter({
    bodyLimit: 16384,
    trustProxy: config.TRUST_PROXY_HOPS
      ? (_address, hop) => hop < config.TRUST_PROXY_HOPS
      : false,
    logger:
      config.NODE_ENV === "test"
        ? false
        : {
            redact: [
              "req.headers.cookie",
              "req.headers.authorization",
              "req.headers.x-csrf-token",
              "res.headers.set-cookie",
            ],
            serializers: {
              req: (req: { method: string; url: string }) => ({
                method: req.method,
                path: req.url.split("?")[0],
              }),
            },
          },
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    { logger: config.NODE_ENV === "test" ? false : ["error", "warn", "log"] },
  );
  await app.register(cookie);
  await app.register(helmet);
  await app.register(rateLimit, {
    global: true,
    max: 10,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
    allowList: (req) => req.routeOptions.url !== "/api/auth/login",
    errorResponseBuilder: () => ({ statusCode: 429, error: "RATE_LIMITED" }),
  });
  adapter.getInstance().addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Request-Id", _req.id);
    return payload;
  });
  app.useGlobalFilters(new SafeErrors());
  // Prisma is scoped to this app instance; Nest close releases its pool.
  const close = app.close.bind(app);
  app.close = async () => {
    try {
      await close();
    } finally {
      await db.$disconnect();
    }
  };
  app.enableShutdownHooks();
  try {
    await db.$connect();
    await app.init();
    await adapter.getInstance().ready();
  } catch {
    await app.close();
    throw new Error(
      "Application startup failed; check database availability and configuration",
    );
  }
  return app;
}
