# 发送短信验证码完整工程示例

该项目为SendSmsVerifyCode的完整工程示例。

**工程代码建议使用更安全的无AK方式，凭据配置方式请参阅：[管理访问凭据](https://help.aliyun.com/zh/sdk/developer-reference/v2-manage-node-js-access-credentials)。**

## 运行条件

- 下载并解压需要语言的代码;

- *Node.js >= 8.x*

## 执行步骤

完成凭据配置后，可以在**解压代码所在目录下**按如下的步骤执行：

- *安装依赖*
  ```sh
  npm install --registry=https://registry.npmmirror.com
  ```

- *运行代码*
  ```sh
  node src/client.js
  ```

## 使用的 API

-  SendSmsVerifyCode：发送短信验证码。 更多信息可参考：[文档](https://next.api.aliyun.com/document/Dypnsapi/2017-05-25/SendSmsVerifyCode)

## API 返回示例

*下列输出值仅作为参考，实际输出结构可能稍有不同，以实际调用为准。*


- JSON 格式 
```js
{
  "AccessDeniedDetail": "无",
  "Message": "成功 ",
  "RequestId": "CC3BB6D2-2FDF-4321-9DCE-B38165CE4C47",
  "Model": {
    "VerifyCode": "4232",
    "RequestId": "a3671ccf-0102-4c8e-8797-a3678e091d09",
    "OutId": "1231231313",
    "BizId": "112231421412414124123^4"
  },
  "Code": "OK",
  "Success": true
}
```

