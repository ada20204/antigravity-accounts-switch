# 账号 credential_drift 是什么、为什么会出现

**日期**:2026-08-22

`agent-hub-accounts` 的 `route`/`overview` 接口里,`is_active` 是"保存的密文和当前系统 Keychain 里的密文逐字节比较"的结果(`manager.ts` `keychain.profileMatchesActive`),`credential_drift` 是"我们自己 `live.json` 记录的上次切换目标"和 `is_active` 对不上时才为 true。

根本原因:VS Code 里常驻的 `agy --hub` 进程只要在跑,就会周期性刷新自己的 OAuth token(实测 15~70 分钟一次),刷新出来的新 token 会直接写回同一个共享 Keychain 槽位——不需要任何切换动作,光是正常用着 Chat,Keychain 内容就会和我们记录的"当前账号"自然对不上。这是 shared-live 架构的固有特性,不是 bug,也不是这次改动引入的。

**顺带修的真 bug**:`accountStore.ts` 一直在读 `acc.current`,但 `agent-hub-accounts` 的 schema 已经从 v1 升到 v2,字段改名成了 `acc.active`——导致不管真实状态如何,前端永远读到 `undefined`,所有账号永远显示"未激活"。已修正为读 `acc.active`,并把 `credential_drift` 接入现有的 `issue` 展示逻辑,漂移了会直接在卡片上显示出来。
