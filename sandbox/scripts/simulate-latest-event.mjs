import { getJson, hasRealSmartVmCredentials, postJson, withSignature } from "./helpers.mjs";

const baseUrl = process.env.LOCAL_API_BASE_URL ?? "http://localhost:4000/api";
const preferredGoodsId = process.env.SIM_GOODS_ID;
const preferredQuantity = Number(process.env.SIM_QUANTITY ?? "1");

const unwrapEnvelope = (response) => {
  if (response && typeof response === "object" && "data" in response) {
    return response.data;
  }

  return response;
};

const maybeSign = (payload) => {
  if (!hasRealSmartVmCredentials()) {
    return payload;
  }

  return withSignature(payload);
};

const eventsResponse = await getJson(baseUrl, "/cabinet-events");
const events = unwrapEnvelope(eventsResponse);

if (!Array.isArray(events) || !events.length) {
  throw new Error("当前没有可模拟的开柜事件。请先在小程序或接口里发起一次开柜。");
}

const latestEvent = events[0];
const deviceResponse = await getJson(baseUrl, `/devices/${latestEvent.deviceCode}`);
const device = unwrapEnvelope(deviceResponse);
const goods =
  device?.doors
    ?.flatMap((door) => door.goods)
    ?.find((entry) => entry.goodsId === preferredGoodsId) ?? device?.doors?.[0]?.goods?.[0];

if (!goods) {
  throw new Error(`设备 ${latestEvent.deviceCode} 下没有可用商品，无法生成结算回调。`);
}

const doorPayload = maybeSign({
  eventId: latestEvent.eventId,
  deviceCode: latestEvent.deviceCode,
  status: "SUCCESS"
});

const settlementPayload = maybeSign({
  orderNo: latestEvent.orderNo,
  eventId: latestEvent.eventId,
  phone: latestEvent.phone,
  deviceCode: latestEvent.deviceCode,
  amount: 0,
  notifyUrl: `${baseUrl}/cabinet-events/callbacks/payment-success`,
  detail: [
    {
      goodsName: goods.name,
      quantity: preferredQuantity,
      unitPrice: goods.price ?? 0,
      goodsId: goods.goodsId
    }
  ]
});

const [doorResponse, settlementResponse] = await Promise.all([
  postJson(baseUrl, "/cabinet-events/callbacks/door-status", doorPayload),
  postJson(baseUrl, "/cabinet-events/callbacks/settlement", settlementPayload)
]);

console.log(
  JSON.stringify(
    {
      eventId: latestEvent.eventId,
      orderNo: latestEvent.orderNo,
      goodsId: goods.goodsId,
      quantity: preferredQuantity,
      doorResponse,
      settlementResponse
    },
    null,
    2
  )
);
