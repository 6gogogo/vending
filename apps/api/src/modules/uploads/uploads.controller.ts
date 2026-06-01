import { BadRequestException, Controller, Inject, Post, Req, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FileInterceptor } from "@nestjs/platform-express";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { ok } from "../../common/dto/api-response";
import {
  AllowedBackofficeSessionPermissions,
  AllowedRoles
} from "../../common/guards/allowed-roles.decorator";
import { RoleGuard } from "../../common/guards/role.guard";
import { resolveUploadDir } from "../../common/store/persistence";

const MAX_UPLOAD_IMAGE_BYTES = 5 * 1024 * 1024;

const detectImageExtension = (buffer: Buffer) => {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return ".png";
  }

  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return ".jpg";
  }

  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return ".gif";
  }

  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return ".webp";
  }

  return undefined;
};

@Controller("uploads")
@UseGuards(RoleGuard)
@AllowedRoles("admin", "merchant")
export class UploadsController {
  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {}

  @Post("images")
  @AllowedBackofficeSessionPermissions("uploads:images")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_IMAGE_BYTES } }))
  uploadImage(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string; mimetype?: string } | undefined,
    @Req() request: { protocol?: string; headers?: Record<string, string | string[] | undefined> }
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException("未接收到图片文件。");
    }

    const extension = detectImageExtension(file.buffer);

    if (!extension) {
      throw new BadRequestException("仅支持 PNG、JPG、GIF、WebP 图片文件。");
    }

    const uploadDir = resolveUploadDir();
    mkdirSync(uploadDir, { recursive: true });

    const filename = `upload-${Date.now()}-${randomBytes(8).toString("hex")}${extension}`;
    const hostHeader = request.headers?.host;
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    const publicBaseUrl = this.configService.get<string>("PUBLIC_BASE_URL")?.trim();
    const protocol = request.protocol ?? "http";
    const relativePath = `/uploads/${filename}`;
    const url = publicBaseUrl
      ? new URL(relativePath, publicBaseUrl).toString()
      : host ? `${protocol}://${host}${relativePath}` : relativePath;

    writeFileSync(join(uploadDir, filename), file.buffer);

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
