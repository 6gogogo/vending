import { findEvent, getCabinetEvents, getSandboxConfig } from "./helpers.mjs";

const sandboxConfig = getSandboxConfig();
const baseUrl = sandboxConfig.localApiBaseUrl;
const orderNo = process.argv[2];
const limitArg = process.argv[3];
const limit = limitArg ? Number(limitArg) : 10;

if (orderNo) {
  const event = await findEvent(baseUrl, orderNo);

  console.log(
    JSON.stringify(
      {
        mode: "single-event",
        baseUrl,
        event
      },
      null,
      2
    )
  );
} else {
  const events = await getCabinetEvents(baseUrl);
  const rows = events.slice(0, Number.isNaN(limit) ? 10 : limit).map((entry) => ({
    orderNo: entry.orderNo,
    eventId: entry.eventId,
    deviceCode: entry.deviceCode,
    phone: entry.phone,
    role: entry.role,
    status: entry.status,
    amount: entry.amount,
    updatedAt: entry.updatedAt
  }));

  console.log(
    JSON.stringify(
      {
        mode: "event-list",
        baseUrl,
        count: rows.length,
        rows
      },
      null,
      2
    )
  );
}
