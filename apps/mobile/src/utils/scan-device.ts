export const parseScannedDeviceCode = (raw: string) => {
  const value = raw.trim();

  if (!value) {
    return "";
  }

  if (/^[A-Za-z0-9-]+$/.test(value)) {
    return value;
  }

  const queryMatch = value.match(/[?&](?:deviceCode|devicecode|code)=([^&#]+)/i);

  if (queryMatch?.[1]) {
    return decodeURIComponent(queryMatch[1]).trim();
  }

  const pathSegments = value.split(/[/?#]/).filter(Boolean);
  const tail = pathSegments.at(-1)?.trim();

  if (tail && /^[A-Za-z0-9-]+$/.test(tail)) {
    return tail;
  }

  const numericMatch = value.match(/(\d{6,})/);

  if (numericMatch?.[1]) {
    return numericMatch[1];
  }

  return "";
};

export const scanDeviceCode = async () => {
  const result = await new Promise<{ result?: string }>((resolve, reject) => {
    uni.scanCode({
      onlyFromCamera: false,
      scanType: ["qrCode", "barCode"],
      success: resolve,
      fail: reject
    });
  });

  return parseScannedDeviceCode(result.result ?? "");
};
