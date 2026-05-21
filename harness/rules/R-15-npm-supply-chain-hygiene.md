# R-15 — npm 供应链卫生(cooldown / ignore-scripts / save-exact / npm ci / lockfile-lint)

## 规则

本仓所有 npm 包安装、升级、CI build 都必须在以下五道闸门下完成,缺一不可:

1. **Cooldown — 新版本必须满 7 天才能进入 lockfile**
   - [.npmrc](file:///Users/guoshuyu/workspace/gif-toolkit/.npmrc) 设置 `min-release-age=7`(npm 单位是 *天*,与 pnpm `minimumReleaseAge` 的 *分钟* 不同,不要写成 10080)
   - 仅在紧急 CVE 修复时允许在命令行 `--min-release-age=0` 临时绕过,但必须在 PR 描述中说明 CVE 编号 + 受影响版本 + 为什么不能等
   - 工具链要求:`engines.npm >= 11.10.0`(更早版本会忽略此 config)

2. **ignore-scripts=true — 全局禁止 lifecycle hook 自动执行**
   - [.npmrc](file:///Users/guoshuyu/workspace/gif-toolkit/.npmrc) 设置 `ignore-scripts=true`
   - 子依赖的 `preinstall` / `install` / `postinstall` 都不会跑(挡 Shai-Hulud / Nx / axios 类攻击的主要落点)
   - 本仓需要 native rebuild 的 5 个依赖必须在根 `package.json` 的 `scripts.postinstall` 里**显式列出**:`sharp` / `ffmpeg-static` / `ffprobe-static` / `gifsicle` / `ytdlp-nodejs`,通过 `npm rebuild <name>` 触发(根目录 scripts 不受 `ignore-scripts` 全局禁用影响,但子树 install hook 仍被禁)
   - 任何新增 native dep 必须在 PR 中**同步**更新 [package.json](file:///Users/guoshuyu/workspace/gif-toolkit/package.json) 的 postinstall allowlist,并在 PR 里说明该包的 install hook 做了什么

3. **save-exact=true — 新增依赖固定到精确版本**
   - [.npmrc](file:///Users/guoshuyu/workspace/gif-toolkit/.npmrc) 设置 `save-exact=true` + `save-prefix=`(空字符串)
   - 新加包写入 `package.json` 时是 `"foo": "1.2.3"` 而不是 `"^1.2.3"`,确保升级只在显式 PR 触发
   - 已有 caret 范围依赖**不**强制改写(超出 R-15 落地范围,保持 lockfile 兼容);新增和升级时严格执行精确版本

4. **npm ci 而不是 npm install — 部署/CI 必须确定性安装**
   - 任何脚本(GitHub Actions、CI、release pipeline、本地复现 bug)都必须用 `npm ci`,禁止 `npm install`
   - `npm ci` 严格按 lockfile 装,绝不更新 lockfile;一旦 lockfile 与 package.json 漂移会立即报错而不是默默修复
   - 本地开发新加依赖后 `npm install <pkg>` 是允许的(那是显式动作)

5. **lockfile-lint — package-lock.json 必须只指向官方 npm 镜像**
   - [package.json](file:///Users/guoshuyu/workspace/gif-toolkit/package.json) `scripts.lockfile:lint` 跑 `lockfile-lint --path package-lock.json --type npm --validate-https --allowed-hosts npm --validate-integrity --validate-package-names`
   - 拒绝 lockfile 里出现非 `https://registry.npmjs.org/...` 的 resolved URL(挡 lockfile injection / 镜像投毒)
   - 拒绝 integrity 字段缺失或非 sha512(挡 tarball 篡改)
   - 拒绝 resolved URL 与包名不匹配(挡名字混淆攻击)

辅助闸门(在 [.npmrc](file:///Users/guoshuyu/workspace/gif-toolkit/.npmrc) 一并启用):

- `engine-strict=true` — Node / npm 版本不达标时直接 fail,避免 native rebuild 拉错 ABI
- `audit-signatures=true` — 启用 npm sigstore 签名校验
- `fund=false` — 关掉 funding 提示,避免淹没真正的安全 warning

## 为什么

- **golden hour 攻击窗口**:近一年 Nx(2024-08)、axios-retry(2024-04)、`@solana/web3.js`(2024-12)、Shai-Hulud(2025)等大规模 npm 投毒事件都在恶意版本发布后 **2-5 小时**被检测到并下架;7 天 cooldown 实际上把"普通项目用户"挡在攻击窗口之外,只有早期社区/CI 会"中招"并触发警报。
- **lifecycle hook 是主要 payload 投放点**:Snyk / Socket.dev 2025 报告里,90% 以上的 npm 投毒攻击通过 `postinstall` 把 reverse shell / 凭证窃取脚本写入 `~/.npmrc` / `~/.aws/credentials` / `~/.ssh`。`ignore-scripts=true` 是**单点最有效**的防御。
- **caret 范围在重新生成 lockfile 时是定时炸弹**:开发者在本地跑 `npm install` / 工具自动 `npm audit fix` 都会基于 caret 范围解析到当前最新版,一旦那一刻 registry 上是恶意版本就会被锁进 lockfile。`save-exact` 把这个动作变成**必须显式 PR**。
- **`npm install` 默认会更新 lockfile**:即使有 cooldown,只要 lockfile 漂移就有窗口。`npm ci` 从 lockfile 里照搬,确保只有"经过 review 的状态"才能上 CI。
- **lockfile injection 是最隐蔽的攻击面**:攻击者改 PR 的 lockfile,把 `resolved` 指到自己控制的镜像或换 integrity hash,GitHub diff review 几乎看不出来。`lockfile-lint` 在 CI 跑一遍就能阻断。
- **业界对齐**:pnpm 11.0(2026-04)默认开 `minimumReleaseAge: 1440`(1 天)+ `blockExoticSubdeps`;yarn 4.12+ 加了 `npmMinimalAgeGate`;bun / deno 都已跟进。npm 11.10 是 npm 官方第一次支持等价能力,本仓采用业界共识的 7 天阈值。

## 怎么遵守

- 配置入口:[.npmrc](file:///Users/guoshuyu/workspace/gif-toolkit/.npmrc) — 修改属于安全敏感改动,必须在 PR 描述里说明动机
- 工具链:开发机 / CI 必须 `node >= 20.0.0` 且 `npm >= 11.10.0`(`engine-strict` 会强制),CI workflow 用 `actions/setup-node` 显式指定
- 装包流程:
  1. 开发本地添加依赖:`npm install <pkg>`(会受 cooldown / save-exact 约束)
  2. 提交 `package.json` + `package-lock.json` 到 PR
  3. CI 跑 `npm ci` + `npm run lockfile:lint` + `npm run typecheck` + `npm run build` + `npm run lint`
  4. 任何 native rebuild 必须验证 `postinstall` allowlist 已包含
- 紧急 CVE 通道:命令行加 `--min-release-age=0` 临时关闭 cooldown,在 PR 标题前缀 `[security]` 并附 CVE 链接 + 缓解期长度

## 反例

- No `.npmrc` 里写 `min-release-age=10080`(混淆 npm/pnpm 单位,等于 27 年,实际禁所有安装)
- No 在 CI 里跑 `npm install` 而不是 `npm ci`(lockfile 会被默默修改,放大攻击窗口)
- No 新加包写成 `"foo": "^1.2.3"`(应该是 `"foo": "1.2.3"`)
- No `package.json.scripts.postinstall = "npm rebuild"`(无 allowlist,等于把 ignore-scripts 防护打回零;必须显式 5 个包名)
- No 在 `package.json.scripts.postinstall` 加新 native dep 但没在 PR 里说明该包做了什么(等于盲签信任)
- No 用 `--min-release-age=0` 绕过但 PR 描述没写 CVE 编号 / 受影响版本(失去事后审计能力)
- No 关掉 `audit-signatures` 来规避一个出问题的包(应当反过来:把那个包钉到上一个签名良好的版本)
- No lockfile 里 resolved 指向非官方镜像(`registry.npmmirror.com` / `registry.cnpmjs.org` 等)— `lockfile-lint --allowed-hosts npm` 会失败,这是**预期**;切换镜像是镜像层的事,不要写进 lockfile

## 关联场景

R-15 是策略性规则,不绑定运行时场景。验证手段:在符合 `engines` 的环境下运行
- `rm -rf node_modules && npm ci --foreground-scripts`(应当成功,5 个 native dep 完成 rebuild)
- `npm run lockfile:lint`(应当 pass,所有 resolved 指向 npm)
- 故意在 `.npmrc` 注释掉 `min-release-age=7` 并尝试装一个 1 天前发布的 patch — 应当被允许;恢复后再试 — 应当被拒绝

## 关联文档

- [.npmrc](file:///Users/guoshuyu/workspace/gif-toolkit/.npmrc)
- [package.json](file:///Users/guoshuyu/workspace/gif-toolkit/package.json)
- [pr-checklist.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/checklists/pr-checklist.md) — 「添加/升级依赖时」勾选项
