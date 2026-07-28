type FetchSafeLoopbackServer = {
  address(): unknown;
  close(callback: (error?: Error | null) => void): unknown;
};

type FetchSafeLoopbackApplication = {
  listen(port: number, host: string): Promise<unknown>;
  getHttpServer(): FetchSafeLoopbackServer;
};

const maximumEphemeralListenAttempts = 8;

// Fetch 规范保留端口；本机临时端口偶发命中时，请重新申请而非发送请求。
const fetchForbiddenPorts = new Set<number>([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080
]);

export const isFetchSafeLoopbackPort = (port: number) =>
  Number.isInteger(port) &&
  port > 0 &&
  port <= 65_535 &&
  !fetchForbiddenPorts.has(port);

const getListeningPort = (server: FetchSafeLoopbackServer) => {
  const address = server.address();
  if (
    !address ||
    typeof address !== "object" ||
    !("port" in address) ||
    typeof address.port !== "number"
  ) {
    throw new Error("测试 API 未返回有效的回环监听端口。");
  }

  return address.port;
};

const closeHttpServer = (server: FetchSafeLoopbackServer) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

/**
 * 使用系统原子分配的空闲回环端口，命中 Fetch 禁用端口时关闭并重试。
 */
export const listenOnFetchSafeLoopbackPort = async (
  application: FetchSafeLoopbackApplication,
  host = "127.0.0.1"
) => {
  for (let attempt = 0; attempt < maximumEphemeralListenAttempts; attempt += 1) {
    await application.listen(0, host);
    const server = application.getHttpServer();
    let port: number;
    try {
      port = getListeningPort(server);
    } catch (error) {
      await closeHttpServer(server).catch(() => undefined);
      throw error;
    }

    if (isFetchSafeLoopbackPort(port)) {
      return port;
    }

    await closeHttpServer(server);
  }

  throw new Error("无法获取 Fetch 安全的测试 API 回环端口。");
};
