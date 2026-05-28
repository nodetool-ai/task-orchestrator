import { NextResponse, type NextRequest } from "next/server";
import * as repo from "@/lib/repo";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

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
    const att = repo.getAttachment(attachmentId);
    if (!att) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const wantsDownload = req.nextUrl.searchParams.get("download") === "1";
    const disposition = wantsDownload ? "attachment" : "inline";
    // RFC 5987 filename* keeps non-ASCII names intact and prevents header
    // injection from a crafted filename.
    const encodedName = encodeURIComponent(att.filename);
    return new NextResponse(new Uint8Array(att.content), {
      status: 200,
      headers: {
        "Content-Type": att.mimeType,
        "Content-Length": String(att.sizeBytes),
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encodedName}`,
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
    repo.deleteAttachment(attachmentId);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
