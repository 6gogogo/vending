// 每次加载获得自己的有效性检查；切换对象、重新加载或卸载后，旧响应不得写回界面。
export const createLatestRequestGuard = () => {
  let version = 0;
  return {
    begin() {
      const current = ++version;
      return () => current === version;
    },
    invalidate() { version++; }
  };
};
