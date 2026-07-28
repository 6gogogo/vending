export interface CachedAsyncLoadOptions {
  forceRefresh?: boolean;
}

export interface CachedAsyncLoader<T> {
  load: (options?: CachedAsyncLoadOptions) => Promise<T>;
}

export const createCachedAsyncLoader = <T>(
  request: () => Promise<T>
): CachedAsyncLoader<T> => {
  let pendingRequest: Promise<T> | undefined;

  return {
    async load(options) {
      if (options?.forceRefresh) {
        pendingRequest = undefined;
      }

      pendingRequest ??= request();
      const requestForThisLoad = pendingRequest;

      try {
        return await requestForThisLoad;
      } catch (error) {
        if (pendingRequest === requestForThisLoad) {
          pendingRequest = undefined;
        }
        throw error;
      }
    }
  };
};
