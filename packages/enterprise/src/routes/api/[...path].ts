import type { APIEvent } from "@solidjs/start/server"
import { Hono } from "hono"
import { describeResponse, describeRoute, openAPIRouteHandler, resolver } from "hono-openapi"
import { validator } from "hono-openapi"
import z from "zod"
import { cors } from "hono/cors"
import { Share } from "~/core/share"

const app = new Hono()

app
  .basePath("/api")
  .use(cors())
  .get(
    "/doc",
    openAPIRouteHandler(app, {
      documentation: {
        info: {
          title: "Opencode Enterprise API",
          version: "1.0.0",
          description: "Opencode Enterprise API endpoints",
        },
        openapi: "3.1.1",
      },
    }),
  )
  .post(
    "/share",
    describeRoute({
      description: "Create a share",
      operationId: "share.create",
      responses: {
        200: {
          description: "Success",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    url: z.string(),
                    secret: z.string(),
                  })
                  .meta({ ref: "Share" }),
              ),
            },
          },
        },
      },
    }),
    validator("json", z.object({ sessionID: z.string() })),
    async (c) => {
      const body = c.req.valid("json")
      const share = await Share.create({ id: body.sessionID })
      return c.json({
        secret: share.secret,
        url: "/s/" + share.id,
      })
    },
  )
  .post(
    "/share/:sessionID/sync",
    describeRoute({
      description: "Sync share data",
      operationId: "share.sync",
      responses: {
        200: {
          description: "Success",
          content: {
            "application/json": {
              schema: resolver(z.object({})),
            },
          },
        },
      },
    }),
    validator("param", z.object({ sessionID: z.string() })),
    validator("json", z.object({ secret: z.string(), data: Share.Data.array() })),
    async (c) => {
      const { sessionID } = c.req.valid("param")
      const body = c.req.valid("json")
      await Share.sync({
        share: { id: sessionID, secret: body.secret },
        data: body.data,
      })
      return c.json({})
    },
  )
  .get(
    "/share/:sessionID/data",
    describeRoute({
      description: "Get share data",
      operationId: "share.data",
      responses: {
        200: {
          description: "Success",
          content: {
            "application/json": {
              schema: resolver(z.array(Share.Data)),
            },
          },
        },
      },
    }),
    validator("param", z.object({ sessionID: z.string() })),
    async (c) => {
      const { sessionID } = c.req.valid("param")
      return c.json(await Share.data(sessionID))
    },
  )

export function GET(event: APIEvent) {
  return app.fetch(event.request)
}

export function POST(event: APIEvent) {
  return app.fetch(event.request)
}

export function PUT(event: APIEvent) {
  return app.fetch(event.request)
}

export async function DELETE(event: APIEvent) {
  return app.fetch(event.request)
}
