import { createSeededPersistedState, resolveApiDataFile, writePersistedState } from "../common/store/persistence.js";

const state = createSeededPersistedState();
const dataFile = writePersistedState(state);

console.log(`后端测试数据已初始化：${dataFile}`);
