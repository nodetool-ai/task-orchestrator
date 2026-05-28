import { RepoError } from "./repo";

export interface ParsedUpload {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/**
 * Parse an attachment upload from a request. Supports two shapes:
 *
 *  • multipart/form-data with a `file` field (the browser/`<input type=file>`
 *    path). An optional `filename` field overrides the file's own name.
 *  • application/json `{ filename, mimeType?, dataBase64 }` (programmatic
 *    clients and the REST API). `mimeType` defaults to octet-stream.
 *
 * Throws RepoError(400) on a malformed body so callers can funnel it through
 * the shared errorResponse helper.
 */
export async function parseAttachmentUpload(req: Request): Promise<ParsedUpload> {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new RepoError("multipart upload requires a 'file' field", 400);
    }
    const override = form.get("filename");
    const filename =
      (typeof override === "string" && override.trim()) || file.name || "attachment";
    const mimeType = file.type || "application/octet-stream";
    const content = Buffer.from(await file.arrayBuffer());
    return { filename, mimeType, content };
  }

  if (contentType.includes("application/json")) {
    const body = (await req.json()) as {
      filename?: unknown;
      mimeType?: unknown;
      dataBase64?: unknown;
    };
    if (typeof body.dataBase64 !== "string" || !body.dataBase64) {
      throw new RepoError("JSON upload requires a base64 'dataBase64' field", 400);
    }
    const filename =
      typeof body.filename === "string" && body.filename.trim()
        ? body.filename.trim()
        : "attachment";
    const mimeType =
      typeof body.mimeType === "string" && body.mimeType.trim()
        ? body.mimeType.trim()
        : "application/octet-stream";
    const content = Buffer.from(body.dataBase64, "base64");
    return { filename, mimeType, content };
  }

  throw new RepoError(
    "Unsupported content-type: use multipart/form-data or application/json",
    400
  );
}
