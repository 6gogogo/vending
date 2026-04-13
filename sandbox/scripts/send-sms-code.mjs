import { requestPhoneCode } from "./aliyun-phone-code.mjs";

const phoneNumber = process.argv[2];

if (!phoneNumber) {
  throw new Error("请传入手机号，例如：npm run sandbox:sms:send -- 13800138000");
}

const result = await requestPhoneCode(phoneNumber);

console.log("验证码发送结果：");
console.log(JSON.stringify(result, null, 2));

if (!result.success) {
  process.exitCode = 1;
}
