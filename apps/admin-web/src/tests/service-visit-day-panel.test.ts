import { beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { ServiceVisitDaySnapshot } from "@vm/shared-types";
import ServiceVisitDayPanel from "../components/ServiceVisitDayPanel.vue";

const mocks = vi.hoisted(() => ({ serviceVisitDay: vi.fn() }));
vi.mock("../api/admin", () => ({ adminApi: { serviceVisitDay: mocks.serviceVisitDay } }));

const makeSnapshot = (): ServiceVisitDaySnapshot => ({
  date: "2026-10-20",
  monthKey: "2026-10",
  today: "2026-10-31",
  generatedAt: "2026-10-31T08:00:00Z",
  businessDayStartHour: 4,
  timezoneOffsetHours: 8,
  person: { userId: "person-a", name: "测试甲", neighborhood: "测试社区" },
  summary: { visits: 1, units: 4 },
  days: [
    { dateKey: "2026-10-20", day: 20, inCurrentMonth: true, visits: 1, units: 4 },
    { dateKey: "2026-10-21", day: 21, inCurrentMonth: true, visits: 0, units: 0 }
  ],
  visits: [{
    key: "visit-a",
    happenedAt: "2026-10-20T06:00:00Z",
    deviceCode: "cab-a",
    deviceName: "测试柜机",
    units: 4,
    goods: [{ goodsId: "milk", name: "牛奶", quantity: 2, returnedQuantity: 1 }]
  }],
  legacyVisitCount: 0
});

beforeEach(() => mocks.serviceVisitDay.mockReset());

it("默认打开最近领取日，点击月历后查询对应日期", async () => {
  mocks.serviceVisitDay.mockResolvedValue(makeSnapshot());
  const wrapper = mount(ServiceVisitDayPanel, { props: { userId: "person-a", personName: "测试甲" } });
  await flushPromises();
  expect(mocks.serviceVisitDay.mock.calls[0][0]).toEqual({ userId: "person-a", date: undefined });
  expect(wrapper.text()).toContain("第 1 次领取");
  expect(wrapper.text()).toContain("牛奶");
  expect(wrapper.text()).toContain("已抵减退回 1 件");
  expect(wrapper.findAll("button").find((button) => button.text() === "下月")?.attributes("disabled")).toBeDefined();
  await wrapper.get('button[aria-label="2026-10-20，1 人次，4 件"]').trigger("click");
  await flushPromises();
  expect(mocks.serviceVisitDay.mock.calls[1][0]).toEqual({ userId: "person-a", date: "2026-10-20" });
  await wrapper.findAll("button").find((button) => button.text() === "上月")!.trigger("click");
  await flushPromises();
  expect(mocks.serviceVisitDay.mock.calls[2][0]).toEqual({ userId: "person-a", date: "2026-09-01" });
  wrapper.unmount();
});

it("加载失败可重试，空日期显示明确空态", async () => {
  mocks.serviceVisitDay.mockRejectedValueOnce(new Error("网络失败"));
  const wrapper = mount(ServiceVisitDayPanel, { props: { userId: "person-a", personName: "测试甲" } });
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("网络失败");
  const empty = { ...makeSnapshot(), summary: { visits: 0, units: 0 }, visits: [] };
  mocks.serviceVisitDay.mockResolvedValueOnce(empty);
  await wrapper.findAll("button").find((button) => button.text() === "重新加载")!.trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("这一天没有领取记录");
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  wrapper.unmount();
});
