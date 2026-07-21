export type SupportedImageExtension = ".png" | ".jpg" | ".gif" | ".webp";

const MAX_IMAGE_DIMENSION = 8_192;
const MAX_IMAGE_PIXELS = 25_000_000;

const hasSafeDimensions = (width: number, height: number) =>
  Number.isInteger(width) &&
  Number.isInteger(height) &&
  width > 0 &&
  height > 0 &&
  width <= MAX_IMAGE_DIMENSION &&
  height <= MAX_IMAGE_DIMENSION &&
  width * height <= MAX_IMAGE_PIXELS;

const isValidPng = (buffer: Buffer) => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(signature)) {
    return false;
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;

  while (offset + 12 <= buffer.length) {
    const dataLength = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + dataLength;

    if (chunkEnd > buffer.length) {
      return false;
    }

    const chunkType = buffer.subarray(offset + 4, offset + 8).toString("ascii");

    if (!sawHeader) {
      if (chunkType !== "IHDR" || dataLength !== 13) {
        return false;
      }

      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      sawHeader = true;
    }

    // 商品图片不需要 APNG；拒绝动画可避免小文件触发大量帧解码。
    if (chunkType === "acTL") {
      return false;
    }

    if (chunkType === "IEND") {
      return dataLength === 0 && chunkEnd === buffer.length && hasSafeDimensions(width, height);
    }

    offset = chunkEnd;
  }

  return false;
};

const skipGifSubBlocks = (buffer: Buffer, startOffset: number) => {
  let offset = startOffset;

  while (offset < buffer.length) {
    const length = buffer[offset];
    offset += 1;

    if (length === 0) {
      return offset;
    }

    if (offset + length > buffer.length) {
      return -1;
    }

    offset += length;
  }

  return -1;
};

const isValidStaticGif = (buffer: Buffer) => {
  const header = buffer.subarray(0, 6).toString("ascii");

  if (buffer.length < 14 || (header !== "GIF87a" && header !== "GIF89a")) {
    return false;
  }

  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);

  if (!hasSafeDimensions(width, height)) {
    return false;
  }

  const packed = buffer[10];
  let offset = 13;

  if ((packed & 0x80) !== 0) {
    offset += 3 * 2 ** ((packed & 0x07) + 1);
  }

  let frameCount = 0;

  while (offset < buffer.length) {
    const introducer = buffer[offset];
    offset += 1;

    if (introducer === 0x3b) {
      return offset === buffer.length && frameCount === 1;
    }

    if (introducer === 0x21) {
      if (offset >= buffer.length) {
        return false;
      }

      offset += 1;
      offset = skipGifSubBlocks(buffer, offset);

      if (offset < 0) {
        return false;
      }
      continue;
    }

    if (introducer !== 0x2c || offset + 9 > buffer.length) {
      return false;
    }

    frameCount += 1;

    if (frameCount > 1) {
      return false;
    }

    const frameWidth = buffer.readUInt16LE(offset + 4);
    const frameHeight = buffer.readUInt16LE(offset + 6);
    const framePacked = buffer[offset + 8];

    if (!hasSafeDimensions(frameWidth, frameHeight)) {
      return false;
    }

    offset += 9;

    if ((framePacked & 0x80) !== 0) {
      offset += 3 * 2 ** ((framePacked & 0x07) + 1);
    }

    if (offset >= buffer.length) {
      return false;
    }

    // LZW 最小码长。
    offset += 1;
    offset = skipGifSubBlocks(buffer, offset);

    if (offset < 0) {
      return false;
    }
  }

  return false;
};

const jpegStartOfFrameMarkers = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
]);

const isValidJpeg = (buffer: Buffer) => {
  if (
    buffer.length < 12 ||
    buffer[0] !== 0xff ||
    buffer[1] !== 0xd8 ||
    buffer.at(-2) !== 0xff ||
    buffer.at(-1) !== 0xd9
  ) {
    return false;
  }

  let offset = 2;
  let dimensionsValid = false;

  while (offset + 1 < buffer.length - 2) {
    if (buffer[offset] !== 0xff) {
      return false;
    }

    while (buffer[offset] === 0xff) {
      offset += 1;
    }

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xda) {
      return dimensionsValid;
    }

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (offset + 2 > buffer.length - 2) {
      return false;
    }

    const segmentLength = buffer.readUInt16BE(offset);

    if (segmentLength < 2 || offset + segmentLength > buffer.length - 2) {
      return false;
    }

    if (jpegStartOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) {
        return false;
      }

      dimensionsValid = hasSafeDimensions(
        buffer.readUInt16BE(offset + 5),
        buffer.readUInt16BE(offset + 3)
      );

      if (!dimensionsValid) {
        return false;
      }
    }

    offset += segmentLength;
  }

  return false;
};

const readUInt24LE = (buffer: Buffer, offset: number) =>
  buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);

const isValidStaticWebp = (buffer: Buffer) => {
  if (
    buffer.length < 30 ||
    buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buffer.subarray(8, 12).toString("ascii") !== "WEBP" ||
    buffer.readUInt32LE(4) + 8 !== buffer.length
  ) {
    return false;
  }

  let offset = 12;
  let dimensionsValid = false;

  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkLength = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + chunkLength;

    if (chunkEnd > buffer.length || chunkType === "ANIM" || chunkType === "ANMF") {
      return false;
    }

    if (chunkType === "VP8X") {
      if (chunkLength < 10 || (buffer[dataOffset] & 0x02) !== 0) {
        return false;
      }

      dimensionsValid = hasSafeDimensions(
        readUInt24LE(buffer, dataOffset + 4) + 1,
        readUInt24LE(buffer, dataOffset + 7) + 1
      );
    } else if (chunkType === "VP8L") {
      if (chunkLength < 5 || buffer[dataOffset] !== 0x2f) {
        return false;
      }

      const b1 = buffer[dataOffset + 1];
      const b2 = buffer[dataOffset + 2];
      const b3 = buffer[dataOffset + 3];
      const b4 = buffer[dataOffset + 4];
      dimensionsValid = hasSafeDimensions(
        1 + b1 + ((b2 & 0x3f) << 8),
        1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10)
      );
    } else if (chunkType === "VP8 ") {
      if (
        chunkLength < 10 ||
        !buffer.subarray(dataOffset + 3, dataOffset + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))
      ) {
        return false;
      }

      dimensionsValid = hasSafeDimensions(
        buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
        buffer.readUInt16LE(dataOffset + 8) & 0x3fff
      );
    }

    offset = chunkEnd + (chunkLength % 2);
  }

  return offset === buffer.length && dimensionsValid;
};

export const detectValidatedImageExtension = (buffer: Buffer): SupportedImageExtension | undefined => {
  if (isValidPng(buffer)) {
    return ".png";
  }

  if (isValidJpeg(buffer)) {
    return ".jpg";
  }

  if (isValidStaticGif(buffer)) {
    return ".gif";
  }

  if (isValidStaticWebp(buffer)) {
    return ".webp";
  }

  return undefined;
};
