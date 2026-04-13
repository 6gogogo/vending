import { verifyPhoneCode } from "./aliyun-phone-code.mjs";

const phoneNumber = process.argv[2];
const verificationCode = process.argv[3];

if (!phoneNumber || !verificationCode) {
  throw new Error("请传入手机号和验证码，例如：npm run sandbox:sms:verify -- 13800138000 123456");
}

const result = await verifyPhoneCode(phoneNumber, verificationCode);

console.log("验证码校验结果：");
console.log(JSON.stringify(result, null, 2));

if (!result.verified) {
  process.exitCode = 1;
}
