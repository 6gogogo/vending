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
  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: "现场扫码",
      content: "为避免远程误开柜门，仅支持使用相机扫描柜机现场二维码，不支持从相册选择图片。",
      confirmText: "开始扫码",
      cancelText: "取消",
      success: (result: { confirm: boolean }) => resolve(result.confirm),
      fail: () => resolve(false)
    });
  });

  if (!confirmed) {
    return "";
  }

  const result = await new Promise<{ result?: string }>((resolve, reject) => {
    uni.scanCode({
      onlyFromCamera: true,
      scanType: ["qrCode", "barCode"],
      success: resolve,
      fail: reject
    });
  });

  return parseScannedDeviceCode(result.result ?? "");
};
