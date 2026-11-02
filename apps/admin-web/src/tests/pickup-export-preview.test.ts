import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import PickupReportExport from "../components/PickupReportExport.vue";
import { useAdminSessionStore } from "../stores/session";

const mocks=vi.hoisted(()=>({exportPickups:vi.fn(),readPickupWorkbook:vi.fn()}));
vi.mock("../api/admin",()=>({adminApi:{exportPickups:mocks.exportPickups}}));
vi.mock("../utils/pickup-workbook-preview",()=>({readPickupWorkbook:mocks.readPickupWorkbook}));
const file=(name:string)=>({blob:{arrayBuffer:async()=>new ArrayBuffer(1)},filename:name});
beforeEach(()=>{
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
  mocks.exportPickups.mockReset();mocks.readPickupWorkbook.mockReset().mockResolvedValue([]);
});
afterEach(()=>vi.useRealTimers());
function start(){
  const pinia=createPinia(),session=useAdminSessionStore(pinia);
  session.setSession({token:"test-only",user:{id:"admin",name:"预览测试",phone:"",tags:[],role:"admin",backofficeRole:"admin",scope:"tenant",tenantId:"a",permissions:["analytics:data-monitor:view","operation-logs:export"]},auth:{username:"admin",usesDefaultPassword:false,passwordUpdatedAt:""}});
  return mount(PickupReportExport,{global:{plugins:[pinia]}});
}
it("更改选项会取消旧请求，迟到结果不会覆盖新预览",async()=>{
  let complete!:(value:ReturnType<typeof file>)=>void;
  mocks.exportPickups.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;})).mockResolvedValueOnce(file("new.xlsx"));
  const wrapper=start();await vi.advanceTimersByTimeAsync(450);
  const oldSignal=mocks.exportPickups.mock.calls[0][2] as AbortSignal;
  await wrapper.get('input[value="phone"]').setValue(true);
  expect(oldSignal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(450);await flushPromises();
  expect(mocks.exportPickups.mock.calls[1][0].fields).toContain("phone");
  complete(file("old.xlsx"));await flushPromises();
  expect(mocks.readPickupWorkbook).toHaveBeenCalledTimes(1);
  expect(wrapper.get('button[type="submit"]').attributes("disabled")).toBeUndefined();
  wrapper.unmount();
});
it("生成失败可重试，日期无效时清除预览并停止请求",async()=>{
  mocks.exportPickups.mockRejectedValueOnce(new Error("生成失败")).mockResolvedValue(file("ok.xlsx"));
  const wrapper=start();await vi.advanceTimersByTimeAsync(450);await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("生成失败");
  expect(wrapper.get('button[type="submit"]').attributes("disabled")).toBeDefined();
  await wrapper.findAll('button').find(b=>b.text()==="刷新预览")!.trigger('click');
  await vi.advanceTimersByTimeAsync(0);await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  await wrapper.get('input[type="date"]').setValue("");await vi.advanceTimersByTimeAsync(500);
  expect(mocks.exportPickups).toHaveBeenCalledTimes(2);
  expect(wrapper.get('button[type="submit"]').attributes("disabled")).toBeDefined();
  wrapper.unmount();
});
