import { NextResponse, type NextRequest } from "next/server";
import * as repo from "@/lib/repo";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

// Attachment mimeType is uploader-controlled with no server-side validation, so
// serving it verbatim as `Content-Type` with `Content-Disposition: inline` is a
// stored-XSS vector (an attacker uploads a text/html "image" that then executes
// same-origin). We only ever render inline for a small allow-list of genuinely
// inert media types; anything else is forced to download as an opaque
// octet-stream. Every response also carries `X-Content-Type-Options: nosniff`
// so the browser can't sniff its way past the declared type.
const INLINE_SAFE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

// Strip anything that could break out of the quoted Content-Disposition
// filename or inject a header (quotes, backslashes, CR/LF and other control
// chars). The RFC 5987 filename* below is percent-encoded separately.
function sanitizeFilename(name: string): string {
  // Replace CR/LF, quotes, backslash and any control char so the value can't
  // break out of the quoted filename or inject a header. Built char-by-char to
  // avoid a control-char regex range.
  let out = "";
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || ch === '"' || ch === "\\") out += "_";
    else out += ch;
  }
  return out;
}

// Serve the raw bytes of an attachment. `<img src>` and download links on the
// dashboard point here. Add `?download=1` to force a save dialog instead of
// inline rendering.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const attachmentId = Number(id);
    if (!Number.isInteger(attachmentId)) {
      return NextResponse.json({ error: "Invalid attachment id" }, { status: 400 });
    }
    const att = await repo.getAttachment(attachmentId);
    if (!att) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const wantsDownload = req.nextUrl.searchParams.get("download") === "1";
    // Only inert, explicitly allow-listed types may render inline; everything
    // else (including anything HTML/script-shaped) is forced to download as an
    // opaque octet-stream so it can never execute in the app's origin.
    const inlineOk = !wantsDownload && INLINE_SAFE_TYPES.has(att.mimeType);
    const contentType = inlineOk ? att.mimeType : "application/octet-stream";
    const disposition = inlineOk ? "inline" : "attachment";
    // RFC 5987 filename* keeps non-ASCII names intact; a sanitized ASCII
    // `filename` fallback prevents header injection from a crafted name.
    const safeName = sanitizeFilename(att.filename);
    const encodedName = encodeURIComponent(att.filename);

    return new NextResponse(new Uint8Array(att.content), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(att.sizeBytes),
        "Content-Disposition": `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const attachmentId = Number(id);
    if (!Number.isInteger(attachmentId)) {
      return NextResponse.json({ error: "Invalid attachment id" }, { status: 400 });
    }
    await repo.deleteAttachment(attachmentId);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
