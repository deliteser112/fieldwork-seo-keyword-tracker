import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { AccessService } from "./application/access";
import { TrackerError, torontoRange } from "./application/tracker";
import type { TrackerStore } from "./application/tracker";
import { websiteUrl } from "./infrastructure/safe-http";
export const TRACKER = Symbol("TRACKER");
export const TRACKER_ORIGIN = Symbol("TRACKER_ORIGIN");
@Controller("api")
export class TrackerController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(TRACKER) private readonly store: TrackerStore,
    @Inject(TRACKER_ORIGIN) private readonly origin: string,
  ) {}
  private async owner(req: FastifyRequest, mutation = false) {
    const token = req.cookies.tracker_session;
    const owner = await this.access.authenticate(token);
    if (
      mutation &&
      (req.headers.origin !== this.origin ||
        !token ||
        !this.access.validCsrf(token, req.headers["x-csrf-token"]))
    )
      throw new TrackerError(403, "FORBIDDEN");
    return owner.id;
  }
  private id(id: string) {
    if (!z.uuid().safeParse(id).success)
      throw new TrackerError(404, "NOT_FOUND");
    return id;
  }
  @Post("clients") async add(
    @Req() req: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const owner = await this.owner(req, true);
    const data = z
      .object({
        name: z.string().trim().min(1).max(120),
        websiteUrl: z.string().max(2048),
      })
      .strict()
      .safeParse(body);
    if (!data.success) throw new TrackerError(400, "INVALID_REQUEST");
    let url: string;
    try {
      url = new URL(websiteUrl(data.data.websiteUrl)).origin;
    } catch {
      throw new TrackerError(400, "INVALID_URL");
    }
    const result = await this.store.addClient(owner, data.data.name, url);
    res.code(202);
    return result;
  }
  @Get("clients/:id/crawl") async crawl(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    const owner = await this.owner(req);
    return { job: await this.store.crawl(owner, this.id(id)) };
  }
  @Post("clients/:id/crawl/retry") async retry(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const owner = await this.owner(req, true);
    await this.store.retry(owner, this.id(id));
    res.code(202);
    return { status: "queued" };
  }
  @Get("pages") async pages(
    @Req() req: FastifyRequest,
    @Query() query: unknown,
  ) {
    const owner = await this.owner(req);
    const parsed = z
      .object({
        clientId: z.uuid().optional(),
        search: z.string().trim().max(200).default(""),
        page: z.coerce.number().int().min(1).max(10000).default(1),
      })
      .strict()
      .safeParse(query);
    if (!parsed.success) throw new TrackerError(400, "INVALID_REQUEST");
    if (parsed.data.clientId) {
      await this.store.crawl(owner, parsed.data.clientId);
    }
    return this.store.pages(
      owner,
      parsed.data.clientId,
      parsed.data.search,
      parsed.data.page,
    );
  }
  @Get("pages/:id") async page(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
  ) {
    const owner = await this.owner(req);
    const page = await this.store.page(owner, this.id(id));
    if (!page) throw new TrackerError(404, "NOT_FOUND");
    return { page };
  }
  @Get("pages/:id/history") async history(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Query() query: unknown,
  ) {
    const owner = await this.owner(req);
    this.id(id);
    const parsed = z
      .object({ from: z.string(), to: z.string() })
      .strict()
      .safeParse(query);
    if (!parsed.success) throw new TrackerError(400, "INVALID_DATE_RANGE");
    const { start, end } = torontoRange(parsed.data.from, parsed.data.to);
    const result = await this.store.history(owner, id, start, end);
    if (!result) throw new TrackerError(404, "NOT_FOUND");
    return result;
  }
}
