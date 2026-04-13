import { BadRequestException, Controller, Post, Req, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

import { ok } from "../../common/dto/api-response";
import { AllowedRoles } from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { resolveUploadDir } from "../../common/store/persistence";

@Controller("uploads")
@UseGuards(RoleGuard)
@AllowedRoles("admin", "merchant")
export class UploadsController {
  @Post("images")
  @UseInterceptors(FileInterceptor("file"))
  uploadImage(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string; mimetype?: string } | undefined,
    @Req() request: { protocol?: string; headers?: Record<string, string | string[] | undefined> }
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException("未接收到图片文件。");
    }

    if (file.mimetype && !file.mimetype.startsWith("image/")) {
      throw new BadRequestException("仅支持上传图片文件。");
    }

    const uploadDir = resolveUploadDir();
    mkdirSync(uploadDir, { recursive: true });

    const extension = extname(file.originalname ?? "") || ".png";
    const filename = `upload-${Date.now()}-${Math.floor(Math.random() * 10_000)}${extension}`;
    writeFileSync(join(uploadDir, filename), file.buffer);

    const hostHeader = request.headers?.host;
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    const protocol = request.protocol ?? "http";
    const relativePath = `/uploads/${filename}`;
    const url = host ? `${protocol}://${host}${relativePath}` : relativePath;

    return ok(
      {
        filename,
        relativePath,
        url
      },
      "操作成功"
    );
  }
}
