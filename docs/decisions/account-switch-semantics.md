# 账号切换语义:confirmAndSwitch 为什么不跳过"已经是 active"的情况

**日期**:2026-08-22 · 涉及 `accountStore.ts::confirmAndSwitch`

`isActive` 缓存字段来自上一次 fetch 到的结果,而 shared-live 架构下"当前账号"会在几分钟内自然漂移(见上面 credential_drift 一节:hub 自己周期性刷新 token 就会改写 Keychain,不需要任何切换动作)。如果按缓存的 `isActive` 跳过点击("反正已经是 active 了,不用真的切"),用户在漂移发生后会彻底没有办法强制把状态拉回到他们以为的那个账号,因为点击本身被拦下来了。真正的后端切换调用即使最终什么都没变,也是安全、幂等的,所以点击一律真正发起一次后端切换请求,不做本地状态短路。
