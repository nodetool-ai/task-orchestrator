import { NextResponse, type NextRequest } from "next/server";
import * as repo from "@/lib/repo";
import { errorResponse } from "@/lib/api";
import { parseAttachmentUpload } from "@/lib/attachment-upload";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!repo.getPlan(id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(repo.listAttachments({ planId: id }));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await auth();
    const author = session?.user?.email ?? "web";
    const upload = await parseAttachmentUpload(req);
    const meta = repo.addAttachment({
      planId: id,
      filename: upload.filename,
      mimeType: upload.mimeType,
      content: upload.content,
      author,
    });
    return NextResponse.json(meta, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
