import { BadRequestException, Controller, Inject, Post, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
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
import { detectValidatedImageExtension } from "./image-file-validation";

const MAX_UPLOAD_IMAGE_BYTES = 5 * 1024 * 1024;

@Controller("uploads")
@UseGuards(RoleGuard)
@AllowedRoles("admin", "merchant")
export class UploadsController {
  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {}

  @Post("images")
  @AllowedBackofficeSessionPermissions("uploads:images")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_IMAGE_BYTES } }))
  uploadImage(
    @UploadedFile() file: { buffer?: Buffer; originalname?: string; mimetype?: string } | undefined
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException("未接收到图片文件。");
    }

    const extension = detectValidatedImageExtension(file.buffer);

    if (!extension) {
      throw new BadRequestException("图片文件无效；仅支持尺寸合理的 PNG、JPG、静态 GIF、WebP。");
    }

    const uploadDir = resolveUploadDir();
    mkdirSync(uploadDir, { recursive: true });

    const filename = `upload-${Date.now()}-${randomBytes(8).toString("hex")}${extension}`;
    const publicBaseUrl = this.configService.get<string>("PUBLIC_BASE_URL")?.trim();
    const relativePath = `/uploads/${filename}`;
    const url = publicBaseUrl
      ? new URL(relativePath, publicBaseUrl).toString()
      : relativePath;

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
